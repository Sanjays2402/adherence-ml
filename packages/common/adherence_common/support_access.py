"""Vendor support access grants.

Enterprise buyers in regulated verticals (healthcare, finance, public
sector) routinely require that the vendor cannot read or modify their
data without an explicit, time-bound, audited grant from the workspace
owner. This module implements the data model and enforcement logic.

* Each tenant has at most one :class:`SupportAccessPolicy`. A policy
  with ``require_grant = False`` keeps today's behaviour: cross-tenant
  admin access is gated only by the break-glass justification header.
* A policy with ``require_grant = True`` flips the workspace into
  "locked mode": no vendor admin may cross into the tenant unless there
  is an active :class:`SupportAccessGrant` for that admin (or for any
  admin, when ``grantee_sub`` is blank).
* Grants are time-bound (``expires_at``) and revocable.

Enforcement lives in :mod:`adherence_api.deps` (``require_tenant_access``)
so every existing route that performs a tenant boundary crossing picks
up the check without per-route edits.
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, Column, Integer, String, Text, select
from sqlalchemy.exc import SQLAlchemyError

from adherence_common.db import Base, session
from adherence_common.logging import get_logger

log = get_logger(__name__)


MIN_TTL_SECONDS = 60
MAX_TTL_SECONDS = 60 * 60 * 24 * 30  # 30 days
DEFAULT_TTL_SECONDS = 60 * 60  # 1 hour


class SupportAccessPolicy(Base):
    """One row per tenant; absence implies ``require_grant=False``."""

    __tablename__ = "tenant_support_access_policy"

    tenant_id = Column(String(64), primary_key=True)
    require_grant = Column(Boolean, nullable=False, default=False)
    updated_at = Column(Integer, nullable=False)
    updated_by = Column(String(128), nullable=True)


class SupportAccessGrant(Base):
    """A single time-bound grant authorising a vendor admin to cross
    the tenant boundary. ``grantee_sub`` is the principal subject
    (typically ``"api-key:<name>"`` for DB-backed keys, or the JWT
    ``sub``). When left blank the grant applies to any admin.
    """

    __tablename__ = "tenant_support_access_grant"

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), nullable=False, index=True)
    grantee_sub = Column(String(128), nullable=True)
    reason = Column(Text, nullable=False)
    granted_by = Column(String(128), nullable=False)
    granted_at = Column(Integer, nullable=False)
    expires_at = Column(Integer, nullable=False)
    revoked_at = Column(Integer, nullable=True)
    revoked_by = Column(String(128), nullable=True)
    last_used_at = Column(Integer, nullable=True)
    use_count = Column(Integer, nullable=False, default=0)
    public_id = Column(String(40), nullable=False, unique=True)


@dataclass(frozen=True)
class PolicyView:
    tenant_id: str
    require_grant: bool
    updated_at: int
    updated_by: Optional[str]


@dataclass(frozen=True)
class GrantView:
    id: int
    public_id: str
    tenant_id: str
    grantee_sub: Optional[str]
    reason: str
    granted_by: str
    granted_at: int
    expires_at: int
    revoked_at: Optional[int]
    revoked_by: Optional[str]
    last_used_at: Optional[int]
    use_count: int

    @property
    def is_active(self) -> bool:
        if self.revoked_at is not None:
            return False
        return _now_ts() < self.expires_at


def _now_ts() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())


def _to_policy(row: SupportAccessPolicy) -> PolicyView:
    return PolicyView(
        tenant_id=str(row.tenant_id),
        require_grant=bool(row.require_grant),
        updated_at=int(row.updated_at),
        updated_by=(str(row.updated_by) if row.updated_by else None),
    )


def _to_grant(row: SupportAccessGrant) -> GrantView:
    return GrantView(
        id=int(row.id),
        public_id=str(row.public_id),
        tenant_id=str(row.tenant_id),
        grantee_sub=(str(row.grantee_sub) if row.grantee_sub else None),
        reason=str(row.reason),
        granted_by=str(row.granted_by),
        granted_at=int(row.granted_at),
        expires_at=int(row.expires_at),
        revoked_at=(int(row.revoked_at) if row.revoked_at is not None else None),
        revoked_by=(str(row.revoked_by) if row.revoked_by else None),
        last_used_at=(int(row.last_used_at) if row.last_used_at is not None else None),
        use_count=int(row.use_count or 0),
    )


def get_policy(tenant_id: str) -> Optional[PolicyView]:
    if not tenant_id:
        return None
    try:
        with session() as s:
            row = s.execute(
                select(SupportAccessPolicy).where(
                    SupportAccessPolicy.tenant_id == str(tenant_id)[:64]
                )
            ).scalar_one_or_none()
            return _to_policy(row) if row else None
    except SQLAlchemyError as exc:
        log.warning("support_access_policy_get_failed", tenant=tenant_id, error=str(exc))
        return None


def set_policy(
    tenant_id: str,
    *,
    require_grant: bool,
    updated_by: Optional[str] = None,
) -> PolicyView:
    if not tenant_id:
        raise ValueError("tenant_id is required")
    tid = str(tenant_id)[:64]
    now = _now_ts()
    with session() as s:
        row = s.execute(
            select(SupportAccessPolicy).where(SupportAccessPolicy.tenant_id == tid)
        ).scalar_one_or_none()
        if row is None:
            row = SupportAccessPolicy(
                tenant_id=tid,
                require_grant=bool(require_grant),
                updated_at=now,
                updated_by=(str(updated_by)[:128] if updated_by else None),
            )
            s.add(row)
        else:
            row.require_grant = bool(require_grant)
            row.updated_at = now
            row.updated_by = (str(updated_by)[:128] if updated_by else None)
        s.commit()
        return _to_policy(row)


def create_grant(
    tenant_id: str,
    *,
    granted_by: str,
    reason: str,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
    grantee_sub: Optional[str] = None,
) -> GrantView:
    if not tenant_id:
        raise ValueError("tenant_id is required")
    reason = (reason or "").strip()
    if len(reason) < 10:
        raise ValueError("reason must be at least 10 characters")
    if len(reason) > 1000:
        raise ValueError("reason must be at most 1000 characters")
    if not granted_by:
        raise ValueError("granted_by is required")
    if not isinstance(ttl_seconds, int):
        raise ValueError("ttl_seconds must be an integer")
    if ttl_seconds < MIN_TTL_SECONDS or ttl_seconds > MAX_TTL_SECONDS:
        raise ValueError(
            f"ttl_seconds must be between {MIN_TTL_SECONDS} and {MAX_TTL_SECONDS}"
        )
    now = _now_ts()
    pub = "sag_" + secrets.token_urlsafe(16)
    with session() as s:
        row = SupportAccessGrant(
            tenant_id=str(tenant_id)[:64],
            grantee_sub=(str(grantee_sub)[:128] if grantee_sub else None),
            reason=reason,
            granted_by=str(granted_by)[:128],
            granted_at=now,
            expires_at=now + int(ttl_seconds),
            revoked_at=None,
            revoked_by=None,
            last_used_at=None,
            use_count=0,
            public_id=pub,
        )
        s.add(row)
        s.commit()
        s.refresh(row)
        return _to_grant(row)


def list_grants(
    tenant_id: str,
    *,
    include_inactive: bool = False,
    limit: int = 100,
) -> list[GrantView]:
    if not tenant_id:
        return []
    tid = str(tenant_id)[:64]
    with session() as s:
        q = select(SupportAccessGrant).where(SupportAccessGrant.tenant_id == tid)
        rows = s.execute(q.order_by(SupportAccessGrant.granted_at.desc())).scalars().all()
    views = [_to_grant(r) for r in rows]
    if not include_inactive:
        views = [v for v in views if v.is_active]
    return views[: max(1, min(int(limit), 500))]


def revoke_grant(
    tenant_id: str,
    public_id: str,
    *,
    revoked_by: str,
) -> Optional[GrantView]:
    if not tenant_id or not public_id:
        return None
    now = _now_ts()
    with session() as s:
        row = s.execute(
            select(SupportAccessGrant).where(
                SupportAccessGrant.tenant_id == str(tenant_id)[:64],
                SupportAccessGrant.public_id == str(public_id)[:40],
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        if row.revoked_at is None:
            row.revoked_at = now
            row.revoked_by = str(revoked_by)[:128] if revoked_by else None
        s.commit()
        s.refresh(row)
        return _to_grant(row)


def find_active_grant(
    tenant_id: str,
    grantee_sub: str,
) -> Optional[GrantView]:
    """Return the most recently granted active grant covering
    ``grantee_sub`` on ``tenant_id``, or ``None`` if no active grant
    matches. Grants with ``grantee_sub`` left blank match any caller.
    """
    if not tenant_id:
        return None
    tid = str(tenant_id)[:64]
    sub = str(grantee_sub or "")[:128]
    now = _now_ts()
    try:
        with session() as s:
            rows = (
                s.execute(
                    select(SupportAccessGrant)
                    .where(SupportAccessGrant.tenant_id == tid)
                    .where(SupportAccessGrant.expires_at > now)
                    .where(SupportAccessGrant.revoked_at.is_(None))
                    .order_by(SupportAccessGrant.granted_at.desc())
                )
                .scalars()
                .all()
            )
    except SQLAlchemyError as exc:
        log.warning("support_access_find_failed", tenant=tenant_id, error=str(exc))
        return None
    for row in rows:
        if not row.grantee_sub or row.grantee_sub == sub:
            return _to_grant(row)
    return None


def record_use(public_id: str) -> None:
    """Bump ``last_used_at`` and ``use_count``. Best-effort."""
    if not public_id:
        return
    now = _now_ts()
    try:
        with session() as s:
            row = s.execute(
                select(SupportAccessGrant).where(
                    SupportAccessGrant.public_id == str(public_id)[:40]
                )
            ).scalar_one_or_none()
            if row is None:
                return
            row.last_used_at = now
            row.use_count = int(row.use_count or 0) + 1
            s.commit()
    except SQLAlchemyError as exc:  # pragma: no cover - defensive
        log.warning("support_access_record_use_failed", error=str(exc))


def evaluate_access(
    tenant_id: str,
    grantee_sub: str,
) -> tuple[bool, Optional[str], Optional[GrantView]]:
    """Return ``(allowed, reason_if_denied, grant_or_none)``."""
    pol = get_policy(tenant_id)
    if pol is None or not pol.require_grant:
        return True, None, None
    grant = find_active_grant(tenant_id, grantee_sub)
    if grant is None:
        return (
            False,
            "workspace requires an active support access grant for vendor admins",
            None,
        )
    return True, None, grant


__all__ = [
    "MIN_TTL_SECONDS",
    "MAX_TTL_SECONDS",
    "DEFAULT_TTL_SECONDS",
    "SupportAccessPolicy",
    "SupportAccessGrant",
    "PolicyView",
    "GrantView",
    "get_policy",
    "set_policy",
    "create_grant",
    "list_grants",
    "revoke_grant",
    "find_active_grant",
    "record_use",
    "evaluate_access",
]
