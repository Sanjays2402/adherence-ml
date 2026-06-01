"""Per-workspace password policy.

Enterprise procurement (especially in healthcare, finance, and any SOC2
audited buyer) requires the vendor to publish a configurable password
policy: minimum length, character classes, history, max age, reuse
window. Even when the buyer federates via SSO, their security review
team asks for a documented and enforceable local-credential policy for
the fallback / break-glass paths and for SCIM-provisioned service
accounts.

This module is the storage + validation primitive. It exposes:

* :class:`WorkspacePasswordPolicy` ORM row (one per tenant).
* :data:`DEFAULT_POLICY` returned when a tenant has not set its own.
* :func:`get_policy` / :func:`set_policy` / :func:`clear_policy`
  admin-plane helpers, matching the shape of
  :mod:`adherence_common.session_policy` so the audit log, dry-run
  envelope, and MFA gate wire identically.
* :func:`validate_password` deterministic check that returns the list of
  reasons a candidate password fails the tenant policy. Used by SCIM
  provisioning, break-glass credential mint, and the public dry-run
  endpoint exposed by the workspace settings UI.

The check is defensive: any backend lookup error falls back to
``DEFAULT_POLICY`` (which is itself stricter than NIST 800-63B's floor)
and the failure is logged. This mirrors how the session-policy and
revocation helpers degrade.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, Column, Integer, String, select
from sqlalchemy.exc import SQLAlchemyError

from adherence_common.db import Base, session
from adherence_common.logging import get_logger

log = get_logger(__name__)


# Bounds chosen to keep an admin from rendering accounts unusable while
# still allowing very-strict overrides for regulated tenants.
MIN_LENGTH_FLOOR = 8
MIN_LENGTH_CEILING = 128
MAX_AGE_DAYS_CEILING = 365 * 2  # ~2 years; 0 disables rotation
HISTORY_CEILING = 24


@dataclass(frozen=True)
class PolicyView:
    tenant_id: Optional[str]
    min_length: int
    require_upper: bool
    require_lower: bool
    require_digit: bool
    require_symbol: bool
    max_age_days: int  # 0 means no rotation requirement
    history_size: int  # number of previous hashes that may not be reused
    updated_at: Optional[int]
    updated_by: Optional[str]

    def to_public(self) -> dict:
        d = asdict(self)
        return d


# The default policy is intentionally stricter than NIST 800-63B's
# 8 character floor: a 12 character minimum with mixed classes is what
# most procurement checklists ask for. Tenants can tighten or relax it
# inside the documented bounds.
DEFAULT_POLICY = PolicyView(
    tenant_id=None,
    min_length=12,
    require_upper=True,
    require_lower=True,
    require_digit=True,
    require_symbol=False,
    max_age_days=0,
    history_size=5,
    updated_at=None,
    updated_by=None,
)


class WorkspacePasswordPolicy(Base):
    """One row per tenant. Absence means: use :data:`DEFAULT_POLICY`."""

    __tablename__ = "workspace_password_policy"

    tenant_id = Column(String(64), primary_key=True)
    min_length = Column(Integer, nullable=False)
    require_upper = Column(Boolean, nullable=False, default=True)
    require_lower = Column(Boolean, nullable=False, default=True)
    require_digit = Column(Boolean, nullable=False, default=True)
    require_symbol = Column(Boolean, nullable=False, default=False)
    max_age_days = Column(Integer, nullable=False, default=0)
    history_size = Column(Integer, nullable=False, default=5)
    updated_at = Column(Integer, nullable=False)
    updated_by = Column(String(128), nullable=True)


def _now_ts() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())


def _to_view(row: WorkspacePasswordPolicy) -> PolicyView:
    return PolicyView(
        tenant_id=str(row.tenant_id),
        min_length=int(row.min_length),
        require_upper=bool(row.require_upper),
        require_lower=bool(row.require_lower),
        require_digit=bool(row.require_digit),
        require_symbol=bool(row.require_symbol),
        max_age_days=int(row.max_age_days or 0),
        history_size=int(row.history_size or 0),
        updated_at=int(row.updated_at),
        updated_by=(str(row.updated_by) if row.updated_by else None),
    )


def _validate_bounds(
    *,
    min_length: int,
    max_age_days: int,
    history_size: int,
) -> None:
    if not isinstance(min_length, int):
        raise ValueError("min_length must be an integer")
    if min_length < MIN_LENGTH_FLOOR or min_length > MIN_LENGTH_CEILING:
        raise ValueError(
            f"min_length must be between {MIN_LENGTH_FLOOR} "
            f"and {MIN_LENGTH_CEILING}"
        )
    if not isinstance(max_age_days, int) or max_age_days < 0:
        raise ValueError("max_age_days must be a non-negative integer")
    if max_age_days > MAX_AGE_DAYS_CEILING:
        raise ValueError(
            f"max_age_days must be at most {MAX_AGE_DAYS_CEILING}"
        )
    if not isinstance(history_size, int) or history_size < 0:
        raise ValueError("history_size must be a non-negative integer")
    if history_size > HISTORY_CEILING:
        raise ValueError(f"history_size must be at most {HISTORY_CEILING}")


def get_policy(tenant_id: Optional[str]) -> PolicyView:
    """Return the policy row for ``tenant_id`` or :data:`DEFAULT_POLICY`."""
    if not tenant_id:
        return DEFAULT_POLICY
    try:
        with session() as s:
            row = s.execute(
                select(WorkspacePasswordPolicy).where(
                    WorkspacePasswordPolicy.tenant_id == str(tenant_id)[:64]
                )
            ).scalar_one_or_none()
            return _to_view(row) if row else DEFAULT_POLICY
    except SQLAlchemyError as exc:
        log.warning(
            "password_policy_get_failed", tenant=tenant_id, error=str(exc)
        )
        return DEFAULT_POLICY


def set_policy(
    tenant_id: str,
    *,
    min_length: int,
    require_upper: bool,
    require_lower: bool,
    require_digit: bool,
    require_symbol: bool,
    max_age_days: int,
    history_size: int,
    updated_by: str | None = None,
) -> PolicyView:
    """Insert or update the tenant policy. Returns the resulting view.

    Raises ``ValueError`` on out-of-bounds input. Caller is responsible
    for RBAC (admin-only) and MFA step-up.
    """
    if not tenant_id:
        raise ValueError("tenant_id is required")
    _validate_bounds(
        min_length=min_length,
        max_age_days=max_age_days,
        history_size=history_size,
    )
    tid = str(tenant_id)[:64]
    now = _now_ts()
    with session() as s:
        row = s.execute(
            select(WorkspacePasswordPolicy).where(
                WorkspacePasswordPolicy.tenant_id == tid
            )
        ).scalar_one_or_none()
        if row is None:
            row = WorkspacePasswordPolicy(
                tenant_id=tid,
                min_length=int(min_length),
                require_upper=bool(require_upper),
                require_lower=bool(require_lower),
                require_digit=bool(require_digit),
                require_symbol=bool(require_symbol),
                max_age_days=int(max_age_days),
                history_size=int(history_size),
                updated_at=now,
                updated_by=(str(updated_by)[:128] if updated_by else None),
            )
            s.add(row)
        else:
            row.min_length = int(min_length)
            row.require_upper = bool(require_upper)
            row.require_lower = bool(require_lower)
            row.require_digit = bool(require_digit)
            row.require_symbol = bool(require_symbol)
            row.max_age_days = int(max_age_days)
            row.history_size = int(history_size)
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
            select(WorkspacePasswordPolicy).where(
                WorkspacePasswordPolicy.tenant_id == tid
            )
        ).scalar_one_or_none()
        if row is None:
            return False
        s.delete(row)
        s.commit()
        return True


_SYMBOL_RE = re.compile(r"[^A-Za-z0-9]")


def validate_password(password: str, *, policy: PolicyView) -> list[str]:
    """Return the list of human-readable reasons ``password`` fails the
    policy. An empty list means the candidate is acceptable.

    Pure function: no I/O, deterministic, safe to call from any layer.
    """
    if not isinstance(password, str):
        return ["password must be a string"]
    reasons: list[str] = []
    if len(password) < policy.min_length:
        reasons.append(
            f"must be at least {policy.min_length} characters "
            f"(got {len(password)})"
        )
    if policy.require_upper and not any(c.isupper() for c in password):
        reasons.append("must contain an uppercase letter")
    if policy.require_lower and not any(c.islower() for c in password):
        reasons.append("must contain a lowercase letter")
    if policy.require_digit and not any(c.isdigit() for c in password):
        reasons.append("must contain a digit")
    if policy.require_symbol and not _SYMBOL_RE.search(password):
        reasons.append("must contain a symbol (non-alphanumeric)")
    return reasons


__all__ = [
    "MIN_LENGTH_FLOOR",
    "MIN_LENGTH_CEILING",
    "MAX_AGE_DAYS_CEILING",
    "HISTORY_CEILING",
    "DEFAULT_POLICY",
    "PolicyView",
    "WorkspacePasswordPolicy",
    "get_policy",
    "set_policy",
    "clear_policy",
    "validate_password",
]
