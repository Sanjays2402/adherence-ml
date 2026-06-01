"""Per-workspace enforce-SSO policy.

Enterprise buyers in regulated verticals require that human sign-in for
their workspace go through their corporate IdP (Okta, Azure AD, Google
Workspace). Once enforce-SSO is on for a tenant, password / magic-link
JWTs and human-bound API keys are rejected; only credentials minted from
a verified OIDC exchange (auth_method=``sso``) or credentials explicitly
flagged as service-to-service automation may call the API.

A small break-glass allow-list (subjects, by JWT ``sub`` or API key
``key_name``) lets a workspace owner keep a recovery path open if the
IdP is down. Each break-glass use is recorded in the admin audit log by
the calling site, not here, so this module stays a pure policy gate.

Wiring:

* :class:`WorkspaceSsoEnforcement` ORM row, one per tenant.
* :func:`get_policy` / :func:`set_policy` / :func:`clear_policy` admin helpers.
* :func:`enforce` called from ``services.api.adherence_api.deps`` on every
  authenticated request. Fail-open on backend errors so a degraded DB
  cannot lock every customer out.

Distinguishing credential types:

* JWTs minted via :func:`adherence_common.auth.mint_jwt` may now carry an
  ``auth_method`` claim. The SSO exchange route stamps ``"sso"``; the
  direct ``/v1/auth/token`` mint stamps ``"password"`` (the historical
  default).
* DB-backed API keys carry a ``service_account`` flag (default False).
  Service-account keys are exempt from enforce-SSO because they
  represent machine-to-machine integrations that have no human session.
* Env-mapped static API keys are never exempt; deployments that want to
  enforce SSO should migrate those to DB-backed service-account keys.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import Column, Integer, String, Text, select
from sqlalchemy.exc import SQLAlchemyError

from adherence_common.db import Base, session
from adherence_common.logging import get_logger

log = get_logger(__name__)

MAX_BREAK_GLASS_SUBJECTS = 5
MAX_SUBJECT_LEN = 128


class WorkspaceSsoEnforcement(Base):
    """One row per tenant. Absence means: SSO is not enforced; all
    credential types are accepted.
    """

    __tablename__ = "workspace_sso_enforcement"

    tenant_id = Column(String(64), primary_key=True)
    require_sso = Column(Integer, nullable=False, default=0)
    # Comma-separated list of subjects (JWT ``sub`` or DB key ``key_name``)
    # that may bypass the enforce-SSO check. Stored as Text so we can grow
    # past the SQLite VARCHAR fast path without a migration.
    break_glass_subjects = Column(Text, nullable=True)
    updated_at = Column(Integer, nullable=False)
    updated_by = Column(String(128), nullable=True)


@dataclass(frozen=True)
class PolicyView:
    tenant_id: str
    require_sso: bool
    break_glass_subjects: tuple[str, ...]
    updated_at: int
    updated_by: Optional[str]


def _now_ts() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())


def _split(raw: Optional[str]) -> tuple[str, ...]:
    if not raw:
        return ()
    return tuple(s for s in (p.strip() for p in raw.split(",")) if s)


def _join(subs: Iterable[str]) -> str:
    return ",".join(sorted({s.strip() for s in subs if s and s.strip()}))


def _to_view(row: WorkspaceSsoEnforcement) -> PolicyView:
    return PolicyView(
        tenant_id=str(row.tenant_id),
        require_sso=bool(int(row.require_sso or 0)),
        break_glass_subjects=_split(row.break_glass_subjects),
        updated_at=int(row.updated_at),
        updated_by=(str(row.updated_by) if row.updated_by else None),
    )


def get_policy(tenant_id: str) -> Optional[PolicyView]:
    if not tenant_id:
        return None
    try:
        with session() as s:
            row = s.execute(
                select(WorkspaceSsoEnforcement).where(
                    WorkspaceSsoEnforcement.tenant_id == str(tenant_id)[:64]
                )
            ).scalar_one_or_none()
            return _to_view(row) if row else None
    except SQLAlchemyError as exc:
        log.warning("sso_enforcement_get_failed", tenant=tenant_id, error=str(exc))
        return None


def set_policy(
    tenant_id: str,
    *,
    require_sso: bool,
    break_glass_subjects: Iterable[str] = (),
    updated_by: str | None = None,
) -> PolicyView:
    if not tenant_id:
        raise ValueError("tenant_id is required")
    subs = [s for s in (str(x).strip() for x in break_glass_subjects) if s]
    if len(subs) > MAX_BREAK_GLASS_SUBJECTS:
        raise ValueError(
            f"at most {MAX_BREAK_GLASS_SUBJECTS} break-glass subjects allowed"
        )
    for s in subs:
        if len(s) > MAX_SUBJECT_LEN:
            raise ValueError(
                f"break-glass subject too long (>{MAX_SUBJECT_LEN} chars): {s[:32]}..."
            )
    tid = str(tenant_id)[:64]
    now = _now_ts()
    joined = _join(subs) or None
    with session() as s:
        row = s.execute(
            select(WorkspaceSsoEnforcement).where(
                WorkspaceSsoEnforcement.tenant_id == tid
            )
        ).scalar_one_or_none()
        if row is None:
            row = WorkspaceSsoEnforcement(
                tenant_id=tid,
                require_sso=1 if require_sso else 0,
                break_glass_subjects=joined,
                updated_at=now,
                updated_by=(str(updated_by)[:128] if updated_by else None),
            )
            s.add(row)
        else:
            row.require_sso = 1 if require_sso else 0
            row.break_glass_subjects = joined
            row.updated_at = now
            row.updated_by = (str(updated_by)[:128] if updated_by else None)
        s.commit()
        return _to_view(row)


def clear_policy(tenant_id: str) -> bool:
    if not tenant_id:
        return False
    tid = str(tenant_id)[:64]
    with session() as s:
        row = s.execute(
            select(WorkspaceSsoEnforcement).where(
                WorkspaceSsoEnforcement.tenant_id == tid
            )
        ).scalar_one_or_none()
        if row is None:
            return False
        s.delete(row)
        s.commit()
        return True


@dataclass(frozen=True)
class EnforceResult:
    """Outcome of an enforce check.

    ``allowed`` is False only when the policy blocks the principal. The
    ``reason`` is safe to surface in a 403 ``detail`` and to write into
    the admin audit log. ``break_glass_used`` lets the caller stamp the
    audit row so workspace owners can review every bypass.
    """

    allowed: bool
    reason: Optional[str]
    break_glass_used: bool


def enforce(
    principal: dict,
    *,
    auth_method: str | None,
    is_service_account: bool,
) -> EnforceResult:
    """Decide whether ``principal`` may proceed under tenant policy.

    ``auth_method`` is the value of the JWT ``auth_method`` claim (or
    ``None`` for API-key principals). ``is_service_account`` is True only
    for DB-backed API keys explicitly flagged as machine-to-machine; env
    keys and human keys must be False.
    """
    try:
        tenant = str(principal.get("tenant") or "").strip()
        if not tenant:
            return EnforceResult(True, None, False)
        policy = get_policy(tenant)
        if policy is None or not policy.require_sso:
            return EnforceResult(True, None, False)
        if auth_method == "sso":
            return EnforceResult(True, None, False)
        if is_service_account:
            return EnforceResult(True, None, False)
        subject = str(
            principal.get("sub")
            or principal.get("key_name")
            or ""
        ).strip()
        if subject and subject in set(policy.break_glass_subjects):
            return EnforceResult(True, "break-glass subject", True)
        return EnforceResult(
            False,
            (
                f"workspace {tenant!r} requires SSO sign-in; this credential "
                f"is not SSO-issued and is not on the break-glass allow-list"
            ),
            False,
        )
    except Exception as exc:  # pragma: no cover - defensive
        log.warning("sso_enforcement_check_failed", error=str(exc))
        return EnforceResult(True, None, False)


__all__ = [
    "MAX_BREAK_GLASS_SUBJECTS",
    "MAX_SUBJECT_LEN",
    "WorkspaceSsoEnforcement",
    "PolicyView",
    "EnforceResult",
    "get_policy",
    "set_policy",
    "clear_policy",
    "enforce",
]
