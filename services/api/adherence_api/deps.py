"""FastAPI dependencies: auth, settings, model cache."""
from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, HTTPException, status

from adherence_common.auth import resolve_api_key, require_role, verify_jwt
from adherence_common.api_keys import resolve_db_key
from adherence_common.errors import AuthError, PermissionError_
from adherence_common.settings import Settings, get_settings

SettingsDep = Annotated[Settings, Depends(get_settings)]


def _principal_from_headers(
    settings: Settings,
    x_api_key: str | None,
    authorization: str | None,
) -> dict[str, str]:
    if x_api_key:
        # Try DB-backed keys first; fall back to static env keys.
        try:
            dbk = resolve_db_key(x_api_key)
        except AuthError as exc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=str(exc))
        except Exception:
            dbk = None
        if dbk is not None:
            return {
                "sub": f"api-key:{dbk.name}",
                "role": dbk.role,
                "scopes": ",".join(sorted(dbk.scopes)),
                "key_name": dbk.name,
            }
        try:
            role = resolve_api_key(x_api_key, settings)
            return {"sub": "api-key", "role": role}
        except Exception as exc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=str(exc))
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1]
        try:
            claims = verify_jwt(token, settings)
            return {"sub": claims.get("sub", ""), "role": claims.get("role", "viewer")}
        except Exception as exc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=str(exc))
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing credentials")


def current_principal(
    settings: SettingsDep,
    x_api_key: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
) -> dict[str, str]:
    return _principal_from_headers(settings, x_api_key, authorization)


def _check_role(actual: str, required: str) -> None:
    try:
        require_role(actual, required)
    except PermissionError_ as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail=str(exc))


def require_viewer(p=Depends(current_principal)) -> dict[str, str]:
    _check_role(p["role"], "viewer")
    return p


def require_service(p=Depends(current_principal)) -> dict[str, str]:
    _check_role(p["role"], "service")
    return p


def require_admin(p=Depends(current_principal)) -> dict[str, str]:
    _check_role(p["role"], "admin")
    return p


def require_scope(scope: str):
    """Dep factory: require principal hold ``scope`` (or admin role / no
    scope restriction on the key).

    DB-backed keys with an empty scope set pass (the role check is the
    only gate). Env keys never carry scopes and also pass here, since
    coarse role checks remain the source of truth for them.
    """
    def _dep(p=Depends(current_principal)) -> dict[str, str]:
        if p.get("role") == "admin":
            return p
        raw = p.get("scopes", "")
        if not raw:
            return p
        if scope in {s for s in raw.split(",") if s}:
            return p
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail=f"missing scope {scope!r}",
        )

    return _dep
