"""Per-workspace session policy.

Enterprise buyers in regulated verticals require that JWT-bearer sessions
expire after a tenant-controlled max age, independent of the global
``jwt_ttl_seconds`` setting. For example a healthcare workspace may want
a 30 minute cap while a sandbox workspace may allow 24 hours.

This module exposes:

* :class:`WorkspaceSessionPolicy` ORM row, one per tenant.
* :func:`get_policy` / :func:`set_policy` admin-plane helpers.
* :func:`enforce_session_age` called inside :func:`adherence_common.auth.verify_jwt`
  to short-circuit tokens that are older than the workspace cap.

The check is defensive: if the backing store is unreachable the request
proceeds (fail-open) and the failure is logged, mirroring how the
revocation and audit chain helpers degrade.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Column, Integer, String, select
from sqlalchemy.exc import SQLAlchemyError

from adherence_common.db import Base, session
from adherence_common.logging import get_logger

log = get_logger(__name__)


# A floor of one minute prevents an admin accidentally locking every user
# out by setting a value of zero. The cap of 30 days matches the longest
# reasonable JWT lifetime; anything beyond that should be a service-account
# api key, not a user session.
MIN_MAX_AGE_SECONDS = 60
MAX_MAX_AGE_SECONDS = 60 * 60 * 24 * 30


class WorkspaceSessionPolicy(Base):
    """One row per tenant. Absence means: no per-tenant cap, the global
    ``jwt_ttl_seconds`` is the only limit.
    """

    __tablename__ = "workspace_session_policy"

    tenant_id = Column(String(64), primary_key=True)
    max_age_seconds = Column(Integer, nullable=False)
    updated_at = Column(Integer, nullable=False)
    updated_by = Column(String(128), nullable=True)


@dataclass(frozen=True)
class PolicyView:
    tenant_id: str
    max_age_seconds: int
    updated_at: int
    updated_by: Optional[str]


def _now_ts() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())


def _to_view(row: WorkspaceSessionPolicy) -> PolicyView:
    return PolicyView(
        tenant_id=str(row.tenant_id),
        max_age_seconds=int(row.max_age_seconds),
        updated_at=int(row.updated_at),
        updated_by=(str(row.updated_by) if row.updated_by else None),
    )


def get_policy(tenant_id: str) -> Optional[PolicyView]:
    """Return the policy row for ``tenant_id`` or ``None`` if none set."""
    if not tenant_id:
        return None
    try:
        with session() as s:
            row = s.execute(
                select(WorkspaceSessionPolicy).where(
                    WorkspaceSessionPolicy.tenant_id == str(tenant_id)[:64]
                )
            ).scalar_one_or_none()
            return _to_view(row) if row else None
    except SQLAlchemyError as exc:
        log.warning("session_policy_get_failed", tenant=tenant_id, error=str(exc))
        return None


def set_policy(
    tenant_id: str,
    *,
    max_age_seconds: int,
    updated_by: str | None = None,
) -> PolicyView:
    """Insert or update the tenant policy. Returns the resulting view.

    Raises ``ValueError`` if ``max_age_seconds`` is outside the allowed
    range. Caller is responsible for RBAC (admin-only).
    """
    if not tenant_id:
        raise ValueError("tenant_id is required")
    if not isinstance(max_age_seconds, int):
        raise ValueError("max_age_seconds must be an integer")
    if max_age_seconds < MIN_MAX_AGE_SECONDS or max_age_seconds > MAX_MAX_AGE_SECONDS:
        raise ValueError(
            f"max_age_seconds must be between {MIN_MAX_AGE_SECONDS} "
            f"and {MAX_MAX_AGE_SECONDS}"
        )
    tid = str(tenant_id)[:64]
    now = _now_ts()
    with session() as s:
        row = s.execute(
            select(WorkspaceSessionPolicy).where(
                WorkspaceSessionPolicy.tenant_id == tid
            )
        ).scalar_one_or_none()
        if row is None:
            row = WorkspaceSessionPolicy(
                tenant_id=tid,
                max_age_seconds=int(max_age_seconds),
                updated_at=now,
                updated_by=(str(updated_by)[:128] if updated_by else None),
            )
            s.add(row)
        else:
            row.max_age_seconds = int(max_age_seconds)
            row.updated_at = now
            row.updated_by = (str(updated_by)[:128] if updated_by else None)
        s.commit()
        return _to_view(row)


def clear_policy(tenant_id: str) -> bool:
    """Drop the tenant policy. Returns True if a row was removed."""
    if not tenant_id:
        return False
    tid = str(tenant_id)[:64]
    with session() as s:
        row = s.execute(
            select(WorkspaceSessionPolicy).where(
                WorkspaceSessionPolicy.tenant_id == tid
            )
        ).scalar_one_or_none()
        if row is None:
            return False
        s.delete(row)
        s.commit()
        return True


def enforce_session_age(claims: dict) -> Optional[str]:
    """Return a human-readable reason if the token is older than the
    tenant's configured ``max_age_seconds``, else ``None``.

    Fail-open: any backend error returns ``None`` and is logged. Called by
    :func:`adherence_common.auth.verify_jwt` on every request.
    """
    try:
        tenant = claims.get("tenant")
        iat = claims.get("iat")
        if not tenant or iat is None:
            return None
        policy = get_policy(str(tenant))
        if policy is None:
            return None
        age = _now_ts() - int(iat)
        if age > policy.max_age_seconds:
            return (
                f"session exceeded workspace max age "
                f"({age}s > {policy.max_age_seconds}s)"
            )
    except Exception as exc:  # pragma: no cover - defensive
        log.warning("session_policy_enforce_failed", error=str(exc))
        return None
    return None


__all__ = [
    "MIN_MAX_AGE_SECONDS",
    "MAX_MAX_AGE_SECONDS",
    "WorkspaceSessionPolicy",
    "PolicyView",
    "get_policy",
    "set_policy",
    "clear_policy",
    "enforce_session_age",
]
