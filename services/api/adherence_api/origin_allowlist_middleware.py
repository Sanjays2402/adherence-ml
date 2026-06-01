"""Per-tenant browser ``Origin`` allowlist enforcement.

Sits in the same middleware chain as :class:`IpAllowlistMiddleware`
and reuses the same credential-to-tenant resolution. We only inspect
the ``Origin`` header: server to server callers (curl, internal jobs,
the inference worker) never set ``Origin`` and are unaffected. CORS
preflight (``OPTIONS``) is also exempt so the deployment-wide CORS
policy can answer it normally; the actual request that follows will
be checked.

When a tenant has no rows the gate is OFF (allow all origins). When
at least one row exists, browser-issued requests for that tenant
must carry an ``Origin`` that matches a row.
"""
from __future__ import annotations

from collections.abc import Iterable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from adherence_api.ip_allowlist_middleware import _resolve_credential
from adherence_common.logging import get_logger
from adherence_common.origin_allowlist import is_allowed, is_enforced
from adherence_common.settings import Settings

log = get_logger(__name__)


class OriginAllowlistMiddleware(BaseHTTPMiddleware):
    """Reject requests whose ``Origin`` is not in the tenant allowlist."""

    def __init__(self, app, *, settings: Settings, exempt_prefixes: Iterable[str] = ()):
        super().__init__(app)
        self.settings = settings
        self.exempt = tuple(exempt_prefixes)

    async def dispatch(self, request: Request, call_next):
        # Never block CORS preflight: the CORSMiddleware answers those
        # and there is no body for the route handler anyway.
        if request.method == "OPTIONS":
            return await call_next(request)
        path = request.url.path
        if any(path.startswith(p) for p in self.exempt):
            return await call_next(request)
        origin = request.headers.get("origin")
        # Non-browser caller (curl, server to server, the worker): no
        # Origin header to evaluate, so this gate does not apply.
        if not origin:
            return await call_next(request)
        tenant, _, _ = _resolve_credential(request, self.settings)
        if not is_enforced(tenant):
            return await call_next(request)
        if is_allowed(tenant, origin):
            return await call_next(request)
        log.warning(
            "origin_allowlist_block",
            tenant=tenant, origin=origin, path=path, method=request.method,
        )
        return JSONResponse(
            status_code=403,
            content={
                "error": "origin_not_allowed",
                "detail": (
                    "Browser Origin is not in this workspace's allowlist. "
                    "Ask a workspace admin to add it under Settings, "
                    "Origin allowlist."
                ),
                "tenant_id": tenant,
                "origin": origin,
            },
        )
