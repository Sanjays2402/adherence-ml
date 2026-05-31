"""Per-workspace API-key lifetime policy.

Enterprise buyers in regulated verticals require a forced API-key
rotation cadence. A workspace admin should be able to declare:

* "no API key issued in this workspace may live longer than 90 days",
* "every key must declare an expiry; non-expiring keys are forbidden".

This module stores one row per tenant. Absence of a row means: no
per-tenant cap, callers may mint keys with any TTL (including no
expiry) subject to the global API limit. When a row exists every
``api_key.create`` and ``api_key.rotate`` call for that tenant must
satisfy the policy or the operation is rejected with HTTP 400 and an
audit record showing why.

The policy is tenant-scoped so a healthcare workspace can demand
90-day rotation while a sandbox workspace stays unconstrained, even
inside the same deployment.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, Column, Integer, String, select

# When set the workspace caps how many simultaneously-active API keys may
# exist (not revoked, not expired). 0 is reserved for "no cap" but the
# public API treats ``None``/missing as the disabled state. Floor of 1
# keeps the workspace usable; ceiling of 10_000 is well above the largest
# enterprise plan seat count.
MIN_MAX_ACTIVE_KEYS = 1
MAX_MAX_ACTIVE_KEYS = 10_000
from sqlalchemy.exc import SQLAlchemyError

from adherence_common.db import Base, session
from adherence_common.logging import get_logger

log = get_logger(__name__)


# Minimum allowed cap is 1 day (rotation any tighter is operationally
# hostile and almost certainly a misconfiguration). Ceiling matches the
# 5-year ceiling already enforced by the admin API on raw ttl_seconds.
MIN_MAX_TTL_SECONDS = 60 * 60 * 24
MAX_MAX_TTL_SECONDS = 60 * 60 * 24 * 365 * 5


class WorkspaceAPIKeyPolicy(Base):
    """One row per tenant. Absence means no cap is enforced."""

    __tablename__ = "workspace_api_key_policy"

    tenant_id = Column(String(64), primary_key=True)
    max_ttl_seconds = Column(Integer, nullable=False)
    require_expiry = Column(Boolean, nullable=False, default=True)
    # Optional cap on the number of simultaneously-active API keys in
    # this workspace. ``None`` means no cap is enforced (only plan seats
    # apply). When set, ``enforce_active_key_count`` rejects ``api_key.create``
    # for the tenant with HTTP 400 once the count reaches the cap.
    max_active_keys = Column(Integer, nullable=True)
    updated_at = Column(Integer, nullable=False)
    updated_by = Column(String(128), nullable=True)


@dataclass(frozen=True)
class PolicyView:
    tenant_id: str
    max_ttl_seconds: int
    require_expiry: bool
    max_active_keys: Optional[int]
    updated_at: int
    updated_by: Optional[str]


def _now_ts() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())


def _to_view(row: WorkspaceAPIKeyPolicy) -> PolicyView:
    mak = getattr(row, "max_active_keys", None)
    return PolicyView(
        tenant_id=str(row.tenant_id),
        max_ttl_seconds=int(row.max_ttl_seconds),
        require_expiry=bool(row.require_expiry),
        max_active_keys=(int(mak) if mak is not None else None),
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
                select(WorkspaceAPIKeyPolicy).where(
                    WorkspaceAPIKeyPolicy.tenant_id == str(tenant_id)[:64]
                )
            ).scalar_one_or_none()
            return _to_view(row) if row else None
    except SQLAlchemyError as exc:
        log.warning("api_key_policy_get_failed", tenant=tenant_id, error=str(exc))
        return None


def set_policy(
    tenant_id: str,
    *,
    max_ttl_seconds: int,
    require_expiry: bool = True,
    max_active_keys: int | None = None,
    updated_by: str | None = None,
) -> PolicyView:
    """Insert or update the tenant policy. Returns the resulting view.

    Raises ``ValueError`` if ``max_ttl_seconds`` is outside the allowed
    range. Caller is responsible for RBAC (admin-only) and audit.
    """
    if not tenant_id:
        raise ValueError("tenant_id is required")
    if not isinstance(max_ttl_seconds, int):
        raise ValueError("max_ttl_seconds must be an integer")
    if (
        max_ttl_seconds < MIN_MAX_TTL_SECONDS
        or max_ttl_seconds > MAX_MAX_TTL_SECONDS
    ):
        raise ValueError(
            f"max_ttl_seconds must be between {MIN_MAX_TTL_SECONDS} "
            f"and {MAX_MAX_TTL_SECONDS}"
        )
    if max_active_keys is not None:
        if not isinstance(max_active_keys, int):
            raise ValueError("max_active_keys must be an integer or None")
        if (
            max_active_keys < MIN_MAX_ACTIVE_KEYS
            or max_active_keys > MAX_MAX_ACTIVE_KEYS
        ):
            raise ValueError(
                f"max_active_keys must be between {MIN_MAX_ACTIVE_KEYS} "
                f"and {MAX_MAX_ACTIVE_KEYS}"
            )
    tid = str(tenant_id)[:64]
    now = _now_ts()
    with session() as s:
        row = s.execute(
            select(WorkspaceAPIKeyPolicy).where(
                WorkspaceAPIKeyPolicy.tenant_id == tid
            )
        ).scalar_one_or_none()
        if row is None:
            row = WorkspaceAPIKeyPolicy(
                tenant_id=tid,
                max_ttl_seconds=int(max_ttl_seconds),
                require_expiry=bool(require_expiry),
                max_active_keys=(int(max_active_keys) if max_active_keys is not None else None),
                updated_at=now,
                updated_by=(str(updated_by)[:128] if updated_by else None),
            )
            s.add(row)
        else:
            row.max_ttl_seconds = int(max_ttl_seconds)
            row.require_expiry = bool(require_expiry)
            row.max_active_keys = (int(max_active_keys) if max_active_keys is not None else None)
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
            select(WorkspaceAPIKeyPolicy).where(
                WorkspaceAPIKeyPolicy.tenant_id == tid
            )
        ).scalar_one_or_none()
        if row is None:
            return False
        s.delete(row)
        s.commit()
        return True


class PolicyViolation(ValueError):
    """Raised by :func:`enforce_key_ttl` when the requested TTL violates
    the tenant policy. The route layer maps this to HTTP 400 and writes
    an audit record so SOC2 reviewers can see attempted bypass.
    """

    def __init__(
        self,
        message: str,
        *,
        tenant_id: str,
        max_ttl_seconds: int,
        require_expiry: bool,
        requested_ttl_seconds: int | None,
    ) -> None:
        super().__init__(message)
        self.tenant_id = tenant_id
        self.max_ttl_seconds = max_ttl_seconds
        self.require_expiry = require_expiry
        self.requested_ttl_seconds = requested_ttl_seconds


def enforce_key_ttl(tenant_id: str, ttl_seconds: int | None) -> None:
    """Validate a requested API-key TTL against the tenant policy.

    No policy on file -> no-op. Policy on file with ``require_expiry``
    true and ``ttl_seconds`` is None -> raise. ``ttl_seconds`` exceeds
    ``max_ttl_seconds`` -> raise. The check is best-effort: a backend
    error logs and returns (fail-open) to avoid wedging key creation if
    the policy store is temporarily unavailable.
    """
    try:
        policy = get_policy(tenant_id)
    except Exception as exc:  # pragma: no cover - defensive
        log.warning("api_key_policy_enforce_lookup_failed",
                    tenant=tenant_id, error=str(exc))
        return
    if policy is None:
        return
    if ttl_seconds is None:
        if policy.require_expiry:
            raise PolicyViolation(
                (
                    f"workspace {tenant_id!r} requires every API key to "
                    f"declare an expiry of at most "
                    f"{policy.max_ttl_seconds} seconds"
                ),
                tenant_id=tenant_id,
                max_ttl_seconds=policy.max_ttl_seconds,
                require_expiry=policy.require_expiry,
                requested_ttl_seconds=None,
            )
        return
    if int(ttl_seconds) > int(policy.max_ttl_seconds):
        raise PolicyViolation(
            (
                f"requested ttl_seconds={int(ttl_seconds)} exceeds "
                f"workspace {tenant_id!r} policy "
                f"(max_ttl_seconds={policy.max_ttl_seconds})"
            ),
            tenant_id=tenant_id,
            max_ttl_seconds=policy.max_ttl_seconds,
            require_expiry=policy.require_expiry,
            requested_ttl_seconds=int(ttl_seconds),
        )


class ActiveKeyLimitExceeded(ValueError):
    """Raised by :func:`enforce_active_key_count` when the workspace has
    already reached its admin-configured cap of simultaneously-active
    API keys. Carries the cap and current count so route layers can
    surface a precise structured error without re-querying.

    This is distinct from :class:`adherence_common.quota.SeatLimitExceeded`,
    which enforces the plan-level seat ceiling. The active-key cap is a
    workspace-admin tightening that sits *below* the plan seat count, so
    a 100-seat plan can be locked to (for example) 5 active keys in a
    production tenant without changing billing.
    """

    def __init__(
        self,
        tenant_id: str,
        *,
        active: int,
        max_active_keys: int,
    ) -> None:
        self.tenant_id = tenant_id
        self.active = active
        self.max_active_keys = max_active_keys
        super().__init__(
            f"workspace {tenant_id!r} has reached its admin-configured "
            f"active-key cap ({active}/{max_active_keys}); revoke an "
            f"existing key before issuing another"
        )


def enforce_active_key_count(tenant_id: str) -> None:
    """Reject ``api_key.create`` when the workspace is at or above the
    admin-configured ``max_active_keys`` cap.

    No policy on file, or policy with ``max_active_keys`` unset -> no-op.
    Defensive against backend failure: a lookup error logs and returns
    (fail-open) to avoid wedging key creation if the policy store is
    temporarily unavailable, matching :func:`enforce_key_ttl`.
    """
    try:
        policy = get_policy(tenant_id)
    except Exception as exc:  # pragma: no cover - defensive
        log.warning(
            "api_key_policy_active_count_lookup_failed",
            tenant=tenant_id, error=str(exc),
        )
        return
    if policy is None or policy.max_active_keys is None:
        return
    # Late import to avoid a cycle: quota imports api_keys which transits
    # several modules that ultimately want settings; api_key_policy is
    # imported early during init_db.
    from adherence_common.quota import seat_usage  # noqa: WPS433
    try:
        active = int(seat_usage(tenant_id))
    except Exception as exc:  # pragma: no cover - defensive
        log.warning(
            "api_key_policy_active_count_query_failed",
            tenant=tenant_id, error=str(exc),
        )
        return
    if active >= int(policy.max_active_keys):
        raise ActiveKeyLimitExceeded(
            str(tenant_id),
            active=active,
            max_active_keys=int(policy.max_active_keys),
        )


__all__ = [
    "MIN_MAX_TTL_SECONDS",
    "MAX_MAX_TTL_SECONDS",
    "MIN_MAX_ACTIVE_KEYS",
    "MAX_MAX_ACTIVE_KEYS",
    "WorkspaceAPIKeyPolicy",
    "PolicyView",
    "PolicyViolation",
    "ActiveKeyLimitExceeded",
    "get_policy",
    "set_policy",
    "clear_policy",
    "enforce_key_ttl",
    "enforce_active_key_count",
]
