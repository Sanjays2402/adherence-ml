"""JWT revocation store.

Provides session-revocation primitives layered on top of the stateless
JWT auth flow:

* :func:`revoke_jti` invalidates one specific token by its ``jti`` claim.
* :func:`revoke_all_for` invalidates every token issued for a principal at
  or before the current moment (with optional tenant scoping). New tokens
  minted after the call are unaffected, which is how the "sign me out of
  every device, but let me log back in" flow works.
* :func:`check_token_revoked` is called by :func:`adherence_common.auth.verify_jwt`
  on every request. It is defensive: a missing or unreachable backing
  store returns ``None`` (fail-open) so a single DB hiccup does not lock
  every client out, mirroring how the audit chain degrades.

The table itself lives in :mod:`adherence_common.db` so it shares the
engine, multi-tenant migration pass, and ``init_db`` lifecycle.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from adherence_common.db import JWTRevocation, session
from adherence_common.logging import get_logger

log = get_logger(__name__)


def _now_ts() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())


def revoke_jti(
    jti: str,
    *,
    sub: str | None = None,
    tenant: str | None = None,
    reason: str | None = None,
    revoked_by: str | None = None,
) -> int:
    """Revoke a single JWT by its ``jti`` claim. Returns the row id.

    Idempotent at the API level: callers may revoke the same jti repeatedly
    and we simply append additional rows (cheap, append-only audit trail).
    """
    if not jti:
        raise ValueError("jti is required")
    with session() as s:
        row = JWTRevocation(
            kind="jti",
            target_jti=jti[:64],
            target_sub=(sub[:128] if sub else None),
            target_tenant=(tenant[:64] if tenant else None),
            not_before_iat=None,
            reason=(reason[:128] if reason else None),
            revoked_by=(revoked_by[:64] if revoked_by else None),
        )
        s.add(row)
        s.commit()
        return int(row.id)


def revoke_all_for(
    sub: str,
    *,
    tenant: str | None = None,
    cutoff_iat: int | None = None,
    reason: str | None = None,
    revoked_by: str | None = None,
) -> int:
    """Revoke every token issued for ``sub`` (within ``tenant`` if given)
    at or before ``cutoff_iat`` (default: now). Returns the row id.
    """
    if not sub:
        raise ValueError("sub is required")
    ts = int(cutoff_iat) if cutoff_iat is not None else _now_ts()
    with session() as s:
        row = JWTRevocation(
            kind="all",
            target_jti=None,
            target_sub=sub[:128],
            target_tenant=(tenant[:64] if tenant else None),
            not_before_iat=ts,
            reason=(reason[:128] if reason else None),
            revoked_by=(revoked_by[:64] if revoked_by else None),
        )
        s.add(row)
        s.commit()
        return int(row.id)


def check_token_revoked(claims: dict) -> Optional[str]:
    """Return a human-readable revocation reason, or ``None`` if the
    token is still live. Fails open on backend errors.
    """
    try:
        jti = claims.get("jti")
        sub = claims.get("sub")
        tenant = claims.get("tenant")
        iat = claims.get("iat")
        with session() as s:
            if jti:
                hit = s.execute(
                    select(JWTRevocation).where(
                        JWTRevocation.kind == "jti",
                        JWTRevocation.target_jti == str(jti),
                    ).limit(1)
                ).scalar_one_or_none()
                if hit is not None:
                    return "token has been revoked"
            if sub and iat is not None:
                q = select(JWTRevocation).where(
                    JWTRevocation.kind == "all",
                    JWTRevocation.target_sub == str(sub),
                    JWTRevocation.not_before_iat >= int(iat),
                )
                hit_all = s.execute(q).scalars().first()
                if hit_all is not None:
                    # Tenant scope check: a tenant-scoped revoke only
                    # affects tokens that match the tenant, while a global
                    # row (target_tenant IS NULL) hits all tenants.
                    if hit_all.target_tenant is None or (
                        tenant is not None
                        and str(hit_all.target_tenant) == str(tenant)
                    ):
                        return "session was revoked by an administrator"
                    # Walk additional matching rows to find a tenant hit.
                    rows = s.execute(q).scalars().all()
                    for r in rows:
                        if r.target_tenant is None or (
                            tenant is not None
                            and str(r.target_tenant) == str(tenant)
                        ):
                            return "session was revoked by an administrator"
    except SQLAlchemyError as exc:
        log.warning("revocation_check_degraded", error=str(exc))
        return None
    except Exception as exc:  # pragma: no cover - defensive
        log.warning("revocation_check_failed", error=str(exc))
        return None
    return None


__all__ = ["revoke_jti", "revoke_all_for", "check_token_revoked"]
