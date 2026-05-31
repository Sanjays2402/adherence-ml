"""FastAPI dependencies: auth, settings, model cache."""
from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status

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
                "tenant": dbk.tenant_id or settings.default_tenant,
            }
        try:
            role = resolve_api_key(x_api_key, settings)
            return {"sub": "api-key", "role": role, "tenant": settings.default_tenant}
        except Exception as exc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=str(exc))
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1]
        try:
            claims = verify_jwt(token, settings)
            return {
                "sub": claims.get("sub", ""),
                "role": claims.get("role", "viewer"),
                "tenant": claims.get("tenant") or settings.default_tenant,
            }
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


def current_tenant(
    request: Request,
    p=Depends(current_principal),
) -> str:
    """Resolve the calling principal's tenant id.

    Returns the tenant stamped on the DB-backed API key, the ``tenant``
    claim from a JWT, or the deployment-wide ``default_tenant`` for
    legacy env-mapped keys.

    Also stashes the resolved tenant on ``request.state.tenant`` so
    response middleware (e.g. ``X-Data-Residency``) can stamp
    tenant-scoped headers without re-parsing auth.
    """
    tenant = str(p.get("tenant") or "default")
    try:
        request.state.tenant = tenant
    except Exception:  # pragma: no cover - defensive
        pass
    return tenant


def require_tenant_access(
    target_tenant: str,
    principal: dict[str, str],
    request=None,
) -> None:
    """Raise 403 unless the principal may operate on ``target_tenant``.

    Admins may cross tenants explicitly; everyone else is pinned to their
    own tenant. ``target_tenant`` of ``"*"`` is admin-only and signals a
    cross-tenant read (used by /v1/audit/list for compliance queries).

    When ``request`` is supplied and the admin is crossing a tenant
    boundary, a break-glass justification is required via the
    ``X-Break-Glass-Justification`` header. Missing or too-short
    justifications return 400 with a structured error so the operator
    sees exactly what to supply. Each accepted cross-tenant access is
    recorded in :class:`adherence_common.break_glass.BreakGlassEvent` so
    the impacted tenant can review it.
    """
    own = str(principal.get("tenant") or "default")
    role = principal.get("role", "")

    crossing = False
    if target_tenant == "*":
        if role != "admin":
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail="cross-tenant access requires admin role",
            )
        crossing = True
    elif target_tenant != own:
        if role != "admin":
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail=f"tenant mismatch: principal={own!r} target={target_tenant!r}",
            )
        crossing = True

    if not crossing or request is None:
        return

    # Cross-tenant admin access: require justification + record.
    from adherence_common.break_glass import (
        BreakGlassError,
        JUSTIFICATION_HEADER,
        record as record_break_glass,
        validate_justification,
    )
    raw = request.headers.get(JUSTIFICATION_HEADER)
    try:
        justification = validate_justification(raw)
    except BreakGlassError as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "break_glass_required",
                "reason": str(exc),
                "header": JUSTIFICATION_HEADER,
                "source_tenant": own,
                "target_tenant": target_tenant,
            },
        )
    caller = str(
        principal.get("sub")
        or principal.get("key_name")
        or "unknown"
    )
    try:
        client_ip = request.client.host if request.client else None
    except Exception:
        client_ip = None
    request_id = request.headers.get("x-request-id") or getattr(
        getattr(request, "state", object()), "request_id", None
    )
    try:
        record_break_glass(
            caller=caller,
            caller_role=str(role or "unknown"),
            source_tenant=own,
            target_tenant=target_tenant,
            route=str(request.url.path),
            method=str(request.method),
            justification=justification,
            client_ip=client_ip,
            request_id=request_id,
        )
    except Exception:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="failed to record break-glass event; access denied",
        )
