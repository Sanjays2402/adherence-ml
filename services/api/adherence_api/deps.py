"""FastAPI dependencies: auth, settings, model cache."""
from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status

from adherence_common.auth import resolve_api_key, require_role, verify_jwt
from adherence_common.api_keys import resolve_db_key, touch_last_seen
from adherence_common.api_key_usage import record_usage as _record_key_usage
from adherence_common.errors import AuthError, PermissionError_
from adherence_common.settings import Settings, get_settings
from adherence_common.sso_enforcement import enforce as _enforce_sso

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
            principal = {
                "sub": f"api-key:{dbk.name}",
                "role": dbk.role,
                "scopes": ",".join(sorted(dbk.scopes)),
                "key_name": dbk.name,
                "key_record_id": str(dbk.record_id),
                "tenant": dbk.tenant_id or settings.default_tenant,
            }
            _enforce_sso_or_403(
                principal,
                auth_method=None,
                is_service_account=(dbk.role == "service"),
            )
            return principal
        try:
            role = resolve_api_key(x_api_key, settings)
            principal = {"sub": "api-key", "role": role, "tenant": settings.default_tenant}
            # Env-mapped static keys never carry SSO context and are never
            # considered service accounts for enforce-SSO purposes; tenants
            # that require SSO must migrate to DB-backed keys.
            _enforce_sso_or_403(
                principal,
                auth_method=None,
                is_service_account=False,
            )
            return principal
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=str(exc))
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1]
        try:
            claims = verify_jwt(token, settings)
            principal = {
                "sub": claims.get("sub", ""),
                "role": claims.get("role", "viewer"),
                "tenant": claims.get("tenant") or settings.default_tenant,
            }
            _enforce_sso_or_403(
                principal,
                auth_method=str(claims.get("auth_method") or "") or None,
                is_service_account=False,
            )
            return principal
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=str(exc))
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing credentials")


def _enforce_sso_or_403(
    principal: dict,
    *,
    auth_method: str | None,
    is_service_account: bool,
) -> None:
    """Raise 403 if the principal's tenant requires SSO and this
    credential isn't SSO-issued or break-glass.

    Break-glass uses are recorded in the admin audit log so workspace
    owners can review every bypass.
    """
    result = _enforce_sso(
        principal,
        auth_method=auth_method,
        is_service_account=is_service_account,
    )
    if result.break_glass_used:
        try:
            from adherence_common.admin_audit import record_admin_action
            record_admin_action(
                action="sso.enforcement.break_glass",
                principal=principal,
                target=str(principal.get("tenant") or "default"),
                details={
                    "auth_method": auth_method,
                    "is_service_account": is_service_account,
                },
                tenant_id=str(principal.get("tenant") or "default"),
            )
        except Exception:
            pass
        return
    if not result.allowed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={
                "code": "sso_required",
                "reason": result.reason or "SSO required",
                "tenant": str(principal.get("tenant") or "default"),
            },
        )


def current_principal(
    settings: SettingsDep,
    request: Request,
    x_api_key: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
) -> dict[str, str]:
    p = _principal_from_headers(settings, x_api_key, authorization)
    key_name = p.get("key_name")
    if key_name:
        try:
            path = request.url.path if request is not None else None
        except Exception:
            path = None
        # Extract client IP (honour the first hop in X-Forwarded-For when
        # present so deployments behind a trusted proxy still see the
        # real source) and a truncated User-Agent for display-only
        # attribution on the admin API-keys panel. Both fields are
        # best-effort; failures must never break an authenticated request.
        client_ip: str | None = None
        user_agent: str | None = None
        try:
            if request is not None:
                xff = request.headers.get("x-forwarded-for")
                if xff:
                    client_ip = xff.split(",", 1)[0].strip() or None
                if not client_ip and request.client is not None:
                    client_ip = request.client.host
                user_agent = request.headers.get("user-agent")
        except Exception:
            pass
        _record_key_usage(
            key_name,
            path=path,
            client_ip=client_ip,
            user_agent=user_agent,
        )
        rid_raw = p.get("key_record_id")
        try:
            rid = int(rid_raw) if rid_raw else 0
        except (TypeError, ValueError):
            rid = 0
        if rid:
            touch_last_seen(
                rid,
                client_ip=client_ip,
                user_agent=user_agent,
            )
    return p


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

    # Vendor support access grants (per-tenant lock-down). When the
    # target tenant requires an active grant, deny any cross-tenant
    # admin call that is not covered by an unrevoked, unexpired grant
    # bound to this principal. The check happens BEFORE the
    # justification check so locked tenants reject even well-formed
    # break-glass attempts that haven't been pre-authorised.
    from adherence_common import support_access as _sa
    sub_for_grant = str(
        principal.get("sub")
        or principal.get("key_name")
        or "unknown"
    )
    allowed, deny_reason, grant_view = _sa.evaluate_access(
        target_tenant if target_tenant != "*" else own,
        sub_for_grant,
    )
    if not allowed:
        try:
            from adherence_common.admin_audit import record_admin_action
            record_admin_action(
                action="support_access.denied",
                principal=principal,
                target=target_tenant,
                details={
                    "source_tenant": own,
                    "route": str(request.url.path),
                    "method": str(request.method),
                    "reason": deny_reason,
                },
                ok=False,
                error=deny_reason,
                tenant_id=(target_tenant if target_tenant != "*" else own),
            )
        except Exception:
            pass
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={
                "code": "support_access_grant_required",
                "reason": deny_reason,
                "source_tenant": own,
                "target_tenant": target_tenant,
            },
        )

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
    if grant_view is not None:
        try:
            _sa.record_use(grant_view.public_id)
        except Exception:
            pass
