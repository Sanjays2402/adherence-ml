"""FastAPI dependencies: auth, settings, model cache."""
from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, HTTPException, status

from adherence_common.auth import resolve_api_key, require_role, verify_jwt
from adherence_common.errors import PermissionError_
from adherence_common.settings import Settings, get_settings

SettingsDep = Annotated[Settings, Depends(get_settings)]


def _principal_from_headers(
    settings: Settings,
    x_api_key: str | None,
    authorization: str | None,
) -> dict[str, str]:
    if x_api_key:
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
