"""Auth helpers: API key extraction, JWT mint/verify, RBAC."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

import jwt

from adherence_common.errors import AuthError, PermissionError_
from adherence_common.settings import Settings

Role = Literal["admin", "service", "viewer"]
ROLE_RANK: dict[str, int] = {"viewer": 1, "service": 2, "admin": 3}


def mint_jwt(subject: str, role: Role, settings: Settings, *, tenant: str | None = None) -> str:
    now = datetime.now(tz=timezone.utc)
    payload = {
        "sub": subject,
        "role": role,
        "tenant": (tenant or "default"),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=settings.jwt_ttl_seconds)).timestamp()),
        "iss": "adherence-ml",
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_alg)


def verify_jwt(token: str, settings: Settings) -> dict:
    """Decode and validate a JWT, then enforce revocation/superseded checks.

    Raises :class:`AuthError` if the token was individually revoked (by jti)
    or if the bearer's sessions were bulk-revoked after the token was issued
    (per-(tenant,subject) "min_iat" cutoff). The revocation check is
    best-effort: if the backing store is unavailable, the check fails open
    and the request proceeds with only signature/expiry validation. This
    matches the rest of the codebase (audit, mfa) which never let a degraded
    DB take the API down, while still hard-failing once the store is healthy.
    """
    try:
        claims = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_alg])
    except jwt.PyJWTError as exc:
        raise AuthError(str(exc)) from exc
    # Local import to avoid a circular import at module load time
    # (revocation -> db -> settings -> ...).
    try:
        from adherence_common.revocation import check_token_revoked
    except Exception:
        return claims
    reason = check_token_revoked(claims)
    if reason is not None:
        raise AuthError(reason)
    return claims


def resolve_api_key(key: str, settings: Settings) -> Role:
    role = settings.api_key_map().get(key)
    if not role:
        raise AuthError("unknown api key")
    if role not in ROLE_RANK:
        raise AuthError(f"invalid role {role}")
    return role  # type: ignore[return-value]


def require_role(actual: str, required: Role) -> None:
    if ROLE_RANK.get(actual, 0) < ROLE_RANK[required]:
        raise PermissionError_(f"role {actual!r} cannot access {required!r}")
