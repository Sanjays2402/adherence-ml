"""Per-workspace model approval policy (model governance).

Regulated buyers (healthcare, finance, public sector) routinely require
**change-control** over which model versions actually score their data.
This module gives each workspace an enforceable allowlist of
``(model_name, model_version)`` pairs plus an enforcement mode:

* ``disabled`` (default) keeps the deployment behaviour: any version the
  registry resolves is allowed. Useful for new tenants and demos.
* ``audit`` lets predictions through but records every unapproved
  version into the admin audit log so the customer can build their own
  change ticket before flipping to enforce.
* ``enforce`` rejects ``/v1/predict`` and ``/v1/predict/batch`` whenever
  the resolved model version is not on the allowlist for that tenant.
  The response is HTTP 422 with ``X-Model-Approval: blocked`` so
  callers can branch cleanly.

Every approval / revocation is admin-MFA-gated, dry-run aware, and
written to the tamper-evident admin audit chain. Storage is tenant
scoped: pinning ``acme``'s approval list never affects ``globex``.

The actual decision is made by :func:`evaluate` which is the single
function the predict path consults. Everything else is bookkeeping.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import Column, Integer, String, Text, UniqueConstraint, select
from sqlalchemy.exc import SQLAlchemyError

from adherence_common.db import Base, session
from adherence_common.logging import get_logger

log = get_logger(__name__)


# Enforcement modes. Order is meaningful: disabled < audit < enforce.
ALLOWED_MODES: frozenset[str] = frozenset({"disabled", "audit", "enforce"})
DEFAULT_MODE: str = "disabled"

# Soft cap so a buggy operator cannot pin a million versions and break
# the settings page. 500 covers every realistic release cadence.
MAX_APPROVED_VERSIONS_PER_TENANT: int = 500


def _normalize_mode(mode: str) -> str:
    return str(mode or "").strip().lower()


def _normalize_name(value: str, *, field: str, max_len: int) -> str:
    v = str(value or "").strip()
    if not v:
        raise ValueError(f"{field} is required")
    if len(v) > max_len:
        raise ValueError(f"{field} too long (max {max_len})")
    return v


def is_allowed_mode(mode: str) -> bool:
    return _normalize_mode(mode) in ALLOWED_MODES


def _now_ts() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())


# ---- tables ---------------------------------------------------------------


class WorkspaceModelApprovalMode(Base):
    """One row per tenant. Absence means :data:`DEFAULT_MODE`."""

    __tablename__ = "workspace_model_approval_mode"

    tenant_id = Column(String(64), primary_key=True)
    mode = Column(String(16), nullable=False)
    updated_at = Column(Integer, nullable=False)
    updated_by = Column(String(128), nullable=True)


class WorkspaceApprovedModelVersion(Base):
    """Approved (model_name, model_version) for a tenant.

    A row exists if and only if the version is on the allowlist. The
    natural key is ``(tenant_id, model_name, model_version)``.
    """

    __tablename__ = "workspace_approved_model_version"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "model_name", "model_version",
            name="uq_workspace_approved_model_version",
        ),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), nullable=False, index=True)
    model_name = Column(String(128), nullable=False)
    model_version = Column(String(64), nullable=False)
    approved_at = Column(Integer, nullable=False)
    approved_by = Column(String(128), nullable=True)
    note = Column(Text, nullable=True)


# ---- views ---------------------------------------------------------------


@dataclass(frozen=True)
class ApprovalModeView:
    tenant_id: str
    mode: str
    pinned: bool
    updated_at: Optional[int]
    updated_by: Optional[str]


@dataclass(frozen=True)
class ApprovedVersionView:
    id: int
    tenant_id: str
    model_name: str
    model_version: str
    approved_at: int
    approved_by: Optional[str]
    note: Optional[str]


@dataclass(frozen=True)
class ApprovalDecision:
    """Result of :func:`evaluate`. ``allowed=False`` only happens in
    enforce mode. ``approved`` reflects allowlist membership regardless
    of mode so the API layer can surface it as a response header even
    when the mode is ``disabled``."""

    tenant_id: str
    mode: str
    model_name: str
    model_version: str
    approved: bool
    allowed: bool
    reason: str


# ---- mode -----------------------------------------------------------------


def get_mode(tenant_id: str) -> ApprovalModeView:
    """Return the current mode view, falling back to :data:`DEFAULT_MODE`
    when the tenant has not pinned a value."""
    tid = str(tenant_id or "")[:64]
    if not tid:
        return ApprovalModeView(
            tenant_id="", mode=DEFAULT_MODE, pinned=False,
            updated_at=None, updated_by=None,
        )
    try:
        with session() as s:
            row = s.execute(
                select(WorkspaceModelApprovalMode).where(
                    WorkspaceModelApprovalMode.tenant_id == tid
                )
            ).scalar_one_or_none()
            if row is None:
                return ApprovalModeView(
                    tenant_id=tid, mode=DEFAULT_MODE, pinned=False,
                    updated_at=None, updated_by=None,
                )
            return ApprovalModeView(
                tenant_id=tid,
                mode=str(row.mode),
                pinned=True,
                updated_at=int(row.updated_at),
                updated_by=(str(row.updated_by) if row.updated_by else None),
            )
    except SQLAlchemyError as exc:
        log.warning("model_approval_get_mode_failed",
                    tenant=tid, error=str(exc))
        return ApprovalModeView(
            tenant_id=tid, mode=DEFAULT_MODE, pinned=False,
            updated_at=None, updated_by=None,
        )


def set_mode(tenant_id: str, *, mode: str, updated_by: str | None = None) -> ApprovalModeView:
    if not tenant_id:
        raise ValueError("tenant_id is required")
    norm = _normalize_mode(mode)
    if norm not in ALLOWED_MODES:
        allowed = ", ".join(sorted(ALLOWED_MODES))
        raise ValueError(f"mode must be one of: {allowed}")
    tid = str(tenant_id)[:64]
    now = _now_ts()
    with session() as s:
        row = s.execute(
            select(WorkspaceModelApprovalMode).where(
                WorkspaceModelApprovalMode.tenant_id == tid
            )
        ).scalar_one_or_none()
        if row is None:
            row = WorkspaceModelApprovalMode(
                tenant_id=tid, mode=norm, updated_at=now,
                updated_by=(str(updated_by)[:128] if updated_by else None),
            )
            s.add(row)
        else:
            row.mode = norm
            row.updated_at = now
            row.updated_by = (str(updated_by)[:128] if updated_by else None)
        s.commit()
        return ApprovalModeView(
            tenant_id=tid, mode=norm, pinned=True,
            updated_at=now,
            updated_by=(str(updated_by)[:128] if updated_by else None),
        )


# ---- approved versions ---------------------------------------------------


def _row_to_view(row: WorkspaceApprovedModelVersion) -> ApprovedVersionView:
    return ApprovedVersionView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        model_name=str(row.model_name),
        model_version=str(row.model_version),
        approved_at=int(row.approved_at),
        approved_by=(str(row.approved_by) if row.approved_by else None),
        note=(str(row.note) if row.note else None),
    )


def list_approved(tenant_id: str) -> list[ApprovedVersionView]:
    tid = str(tenant_id or "")[:64]
    if not tid:
        return []
    try:
        with session() as s:
            rows = s.execute(
                select(WorkspaceApprovedModelVersion)
                .where(WorkspaceApprovedModelVersion.tenant_id == tid)
                .order_by(
                    WorkspaceApprovedModelVersion.model_name.asc(),
                    WorkspaceApprovedModelVersion.approved_at.desc(),
                )
            ).scalars().all()
            return [_row_to_view(r) for r in rows]
    except SQLAlchemyError as exc:
        log.warning("model_approval_list_failed",
                    tenant=tid, error=str(exc))
        return []


def is_approved(tenant_id: str, *, model_name: str, model_version: str) -> bool:
    tid = str(tenant_id or "")[:64]
    name = str(model_name or "")[:128]
    ver = str(model_version or "")[:64]
    if not (tid and name and ver):
        return False
    try:
        with session() as s:
            row = s.execute(
                select(WorkspaceApprovedModelVersion.id).where(
                    WorkspaceApprovedModelVersion.tenant_id == tid,
                    WorkspaceApprovedModelVersion.model_name == name,
                    WorkspaceApprovedModelVersion.model_version == ver,
                )
            ).first()
            return row is not None
    except SQLAlchemyError as exc:
        log.warning("model_approval_is_approved_failed",
                    tenant=tid, error=str(exc))
        return False


def approve(
    tenant_id: str,
    *,
    model_name: str,
    model_version: str,
    approved_by: str | None = None,
    note: str | None = None,
) -> ApprovedVersionView:
    if not tenant_id:
        raise ValueError("tenant_id is required")
    name = _normalize_name(model_name, field="model_name", max_len=128)
    ver = _normalize_name(model_version, field="model_version", max_len=64)
    tid = str(tenant_id)[:64]
    now = _now_ts()
    with session() as s:
        existing = s.execute(
            select(WorkspaceApprovedModelVersion).where(
                WorkspaceApprovedModelVersion.tenant_id == tid,
                WorkspaceApprovedModelVersion.model_name == name,
                WorkspaceApprovedModelVersion.model_version == ver,
            )
        ).scalar_one_or_none()
        if existing is not None:
            # Idempotent: refresh approver/note so the audit trail stays
            # useful but do not duplicate the row.
            existing.approved_at = now
            existing.approved_by = (
                str(approved_by)[:128] if approved_by else None
            )
            existing.note = (str(note)[:4096] if note else None)
            s.commit()
            return _row_to_view(existing)
        count = s.execute(
            select(WorkspaceApprovedModelVersion.id).where(
                WorkspaceApprovedModelVersion.tenant_id == tid,
            )
        ).all()
        if len(count) >= MAX_APPROVED_VERSIONS_PER_TENANT:
            raise ValueError(
                f"approved versions cap reached ({MAX_APPROVED_VERSIONS_PER_TENANT})"
            )
        row = WorkspaceApprovedModelVersion(
            tenant_id=tid,
            model_name=name,
            model_version=ver,
            approved_at=now,
            approved_by=(str(approved_by)[:128] if approved_by else None),
            note=(str(note)[:4096] if note else None),
        )
        s.add(row)
        s.commit()
        return _row_to_view(row)


def revoke(tenant_id: str, *, model_name: str, model_version: str) -> bool:
    tid = str(tenant_id or "")[:64]
    name = str(model_name or "")[:128]
    ver = str(model_version or "")[:64]
    if not (tid and name and ver):
        return False
    with session() as s:
        row = s.execute(
            select(WorkspaceApprovedModelVersion).where(
                WorkspaceApprovedModelVersion.tenant_id == tid,
                WorkspaceApprovedModelVersion.model_name == name,
                WorkspaceApprovedModelVersion.model_version == ver,
            )
        ).scalar_one_or_none()
        if row is None:
            return False
        s.delete(row)
        s.commit()
        return True


# ---- decision -----------------------------------------------------------


def evaluate(
    tenant_id: str,
    *,
    model_name: str,
    model_version: str,
) -> ApprovalDecision:
    """Decide whether a prediction may proceed.

    Always returns a decision; never raises. The predict path uses
    ``decision.allowed`` to block, ``decision.approved`` for the
    response header, and ``decision.mode``/``decision.reason`` for the
    error payload and audit log.
    """
    tid = str(tenant_id or "default")[:64]
    name = str(model_name or "")[:128]
    ver = str(model_version or "")[:64]
    mode_view = get_mode(tid)
    mode = mode_view.mode
    approved = is_approved(tid, model_name=name, model_version=ver) if (name and ver) else False
    if mode == "enforce":
        if approved:
            return ApprovalDecision(
                tenant_id=tid, mode=mode, model_name=name,
                model_version=ver, approved=True, allowed=True,
                reason="approved",
            )
        return ApprovalDecision(
            tenant_id=tid, mode=mode, model_name=name,
            model_version=ver, approved=False, allowed=False,
            reason="not_in_approved_versions",
        )
    if mode == "audit":
        return ApprovalDecision(
            tenant_id=tid, mode=mode, model_name=name,
            model_version=ver, approved=approved, allowed=True,
            reason=("approved" if approved else "audit_unapproved"),
        )
    # disabled
    return ApprovalDecision(
        tenant_id=tid, mode=mode, model_name=name,
        model_version=ver, approved=approved, allowed=True,
        reason="mode_disabled",
    )


__all__ = [
    "ALLOWED_MODES",
    "DEFAULT_MODE",
    "MAX_APPROVED_VERSIONS_PER_TENANT",
    "WorkspaceModelApprovalMode",
    "WorkspaceApprovedModelVersion",
    "ApprovalModeView",
    "ApprovedVersionView",
    "ApprovalDecision",
    "is_allowed_mode",
    "get_mode",
    "set_mode",
    "list_approved",
    "is_approved",
    "approve",
    "revoke",
    "evaluate",
]
