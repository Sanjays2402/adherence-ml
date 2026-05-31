"""Per-workspace data retention policy.

Procurement teams in regulated verticals (HIPAA, GDPR, SOC2) require
that each customer workspace can declare its own data retention
ceiling, independent of the global deployment default. A US clinical
trial workspace may need to keep prediction audit rows for 7 years
while a European demo workspace must purge them after 30 days. The
global ``retention.sweep`` defaults are a deployment-wide policy and
cannot express that.

This module stores one row per ``tenant_id`` with TTL overrides for
each tenant-scoped retention target table, plus a counterpart helper
:func:`sweep_for_tenant` that performs scoped deletes that never touch
another workspace's rows. Absence of a row means: use deployment
defaults from :mod:`adherence_common.retention`.

Tables eligible for per-tenant overrides are the tenant-scoped ones:

* ``predictions``
* ``prediction_audit``
* ``admin_audit_log``
* ``api_key_records``

``webhook_deliveries`` / ``dose_outcomes`` / ``idempotency_records``
remain global-only because their schema lacks a ``tenant_id`` column;
those tables are intentionally untouched by the per-tenant sweeper.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional

from sqlalchemy import Column, Integer, JSON, String, delete, func, select
from sqlalchemy.exc import SQLAlchemyError

from adherence_common.db import (
    AdminAuditLog,
    Base,
    PredictionAudit,
    PredictionRow,
    init_db,
    session,
)
from adherence_common.logging import get_logger

log = get_logger(__name__)

# Bounds (days). 1 day floor protects accidental "0 day" wipes.
MIN_TTL_DAYS = 1
MAX_TTL_DAYS = 365 * 10  # 10 years; long enough for any regulated retention

# Tenant-scoped tables we can prune safely. Map table -> (ORM, timestamp col).
# ``api_key_records`` is intentionally excluded from auto-prune even though
# it carries ``tenant_id``: deleting an api key record orphans audit history
# referencing it, so key lifecycle stays on the admin api-key route.
_TENANT_TABLES: dict[str, tuple[type, object]] = {
    "predictions": (PredictionRow, PredictionRow.created_at),
    "prediction_audit": (PredictionAudit, PredictionAudit.created_at),
    "admin_audit_log": (AdminAuditLog, AdminAuditLog.created_at),
}

ALLOWED_TABLES: tuple[str, ...] = tuple(_TENANT_TABLES.keys())


class WorkspaceRetentionPolicy(Base):
    """One row per tenant. Absence means no per-tenant overrides apply."""

    __tablename__ = "workspace_retention_policy"

    tenant_id = Column(String(64), primary_key=True)
    # JSON map of {table_name: ttl_days}. Validated on write to be a
    # subset of ALLOWED_TABLES with integer values in [MIN_TTL_DAYS,
    # MAX_TTL_DAYS]. Stored as JSON for forward-compat as we add more
    # tenant-scoped tables.
    ttls_days = Column(JSON, nullable=False, default=dict)
    updated_at = Column(Integer, nullable=False)
    updated_by = Column(String(128), nullable=True)


@dataclass(frozen=True)
class PolicyView:
    tenant_id: str
    ttls_days: dict[str, int]
    updated_at: int
    updated_by: Optional[str]


@dataclass
class TableSweep:
    table: str
    cutoff: datetime
    candidates: int
    deleted: int


def _now_ts() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())


def _to_view(row: WorkspaceRetentionPolicy) -> PolicyView:
    raw = row.ttls_days or {}
    if not isinstance(raw, dict):
        raw = {}
    cleaned: dict[str, int] = {}
    for k, v in raw.items():
        if k in _TENANT_TABLES:
            try:
                cleaned[k] = int(v)
            except (TypeError, ValueError):
                continue
    return PolicyView(
        tenant_id=str(row.tenant_id),
        ttls_days=cleaned,
        updated_at=int(row.updated_at),
        updated_by=(str(row.updated_by) if row.updated_by else None),
    )


def _normalize_ttls(ttls: dict[str, int]) -> dict[str, int]:
    if not isinstance(ttls, dict):
        raise ValueError("ttls_days must be an object mapping table -> days")
    out: dict[str, int] = {}
    for k, v in ttls.items():
        if k not in _TENANT_TABLES:
            raise ValueError(
                f"unknown retention table: {k!r}. allowed: {sorted(_TENANT_TABLES)}"
            )
        try:
            iv = int(v)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"ttl_days for {k} must be an integer") from exc
        if iv < MIN_TTL_DAYS or iv > MAX_TTL_DAYS:
            raise ValueError(
                f"ttl_days for {k} must be between {MIN_TTL_DAYS} and {MAX_TTL_DAYS}"
            )
        out[k] = iv
    return out


def get_policy(tenant_id: str) -> Optional[PolicyView]:
    """Return the policy row for ``tenant_id`` or ``None`` if none set."""
    if not tenant_id:
        return None
    try:
        with session() as s:
            row = s.execute(
                select(WorkspaceRetentionPolicy).where(
                    WorkspaceRetentionPolicy.tenant_id == str(tenant_id)[:64]
                )
            ).scalar_one_or_none()
            return _to_view(row) if row else None
    except SQLAlchemyError as exc:
        log.warning(
            "retention_policy_get_failed", tenant=tenant_id, error=str(exc)
        )
        return None


def set_policy(
    tenant_id: str,
    *,
    ttls_days: dict[str, int],
    updated_by: str | None = None,
) -> PolicyView:
    """Insert or update the tenant retention policy.

    ``ttls_days`` must be a non-empty mapping; pass an empty policy by
    calling :func:`clear_policy` instead. RBAC and audit are the
    caller's responsibility.
    """
    if not tenant_id:
        raise ValueError("tenant_id is required")
    norm = _normalize_ttls(ttls_days)
    if not norm:
        raise ValueError(
            "ttls_days must include at least one table override; "
            "call clear_policy() to remove the policy entirely"
        )
    tid = str(tenant_id)[:64]
    now = _now_ts()
    with session() as s:
        row = s.execute(
            select(WorkspaceRetentionPolicy).where(
                WorkspaceRetentionPolicy.tenant_id == tid
            )
        ).scalar_one_or_none()
        if row is None:
            row = WorkspaceRetentionPolicy(
                tenant_id=tid,
                ttls_days=norm,
                updated_at=now,
                updated_by=(str(updated_by)[:128] if updated_by else None),
            )
            s.add(row)
        else:
            row.ttls_days = norm
            row.updated_at = now
            row.updated_by = (str(updated_by)[:128] if updated_by else None)
        s.commit()
        return _to_view(row)


def clear_policy(tenant_id: str) -> bool:
    """Drop the per-tenant retention policy. Returns True if removed."""
    if not tenant_id:
        return False
    tid = str(tenant_id)[:64]
    with session() as s:
        row = s.execute(
            select(WorkspaceRetentionPolicy).where(
                WorkspaceRetentionPolicy.tenant_id == tid
            )
        ).scalar_one_or_none()
        if row is None:
            return False
        s.delete(row)
        s.commit()
        return True


def sweep_for_tenant(
    tenant_id: str,
    *,
    ttls_days: dict[str, int] | None = None,
    tables: Iterable[str] | None = None,
    now: datetime | None = None,
    dry_run: bool = False,
) -> list[TableSweep]:
    """Delete rows older than ``ttl_days`` scoped to ``tenant_id`` only.

    When ``ttls_days`` is omitted the persisted tenant policy is used.
    If no policy exists and no override is supplied this is a no-op
    returning an empty list (no global defaults are applied here: that
    is what the deployment-wide :func:`adherence_common.retention.sweep`
    is for).

    Every WHERE clause includes ``tenant_id == tenant`` so a misconfig
    cannot leak deletes across workspace boundaries.
    """
    if not tenant_id:
        raise ValueError("tenant_id is required")
    init_db()
    tid = str(tenant_id)[:64]
    now = now or datetime.utcnow()

    if ttls_days is None:
        pol = get_policy(tid)
        effective = dict(pol.ttls_days) if pol else {}
    else:
        effective = _normalize_ttls(ttls_days)

    if not effective:
        return []

    target = list(tables) if tables else list(effective.keys())
    for t in target:
        if t not in _TENANT_TABLES:
            raise ValueError(
                f"unknown retention table: {t!r}. allowed: {sorted(_TENANT_TABLES)}"
            )
        if t not in effective:
            raise ValueError(
                f"no ttl_days configured for {t!r} on tenant {tid!r}"
            )

    results: list[TableSweep] = []
    with session() as s:
        for tname in target:
            model, ts_col = _TENANT_TABLES[tname]
            cutoff = now - timedelta(days=effective[tname])
            tenant_filter = model.tenant_id == tid  # type: ignore[attr-defined]
            n = s.execute(
                select(func.count())
                .select_from(model)
                .where(ts_col < cutoff, tenant_filter)
            ).scalar_one()
            deleted = 0
            if not dry_run and n:
                res = s.execute(
                    delete(model).where(ts_col < cutoff, tenant_filter)
                )
                deleted = int(res.rowcount or 0)
            results.append(
                TableSweep(
                    table=tname,
                    cutoff=cutoff,
                    candidates=int(n),
                    deleted=deleted,
                )
            )
        if not dry_run:
            s.commit()
    log.info(
        "retention_sweep_tenant",
        tenant=tid,
        dry_run=dry_run,
        results=[r.__dict__ for r in results],
    )
    return results


__all__ = [
    "ALLOWED_TABLES",
    "MIN_TTL_DAYS",
    "MAX_TTL_DAYS",
    "WorkspaceRetentionPolicy",
    "PolicyView",
    "TableSweep",
    "get_policy",
    "set_policy",
    "clear_policy",
    "sweep_for_tenant",
]
