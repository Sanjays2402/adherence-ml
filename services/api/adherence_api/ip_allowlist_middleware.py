"""Per-tenant IP allowlist enforcement.

Runs after auth credentials are presented but before the route handler.
For each request we resolve the tenant the credential belongs to (DB
backed api key, then JWT ``tenant`` claim, then deployment default for
unauthenticated probes). If the tenant has any allowlist entries we
require the client IP to match one of them.

The middleware is intentionally tolerant: requests without credentials
hit the deployment-default tenant, which is what unauthenticated probes
and the marketing landing page already use, so locking down a specific
customer tenant never breaks the open auth and health surface.
"""
from __future__ import annotations

from collections.abc import Iterable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from adherence_common.api_keys import resolve_db_key
from adherence_common.auth import verify_jwt
from adherence_common.errors import AuthError
from adherence_common.ip_allowlist import is_allowed
from adherence_common.logging import get_logger
from adherence_common.settings import Settings

log = get_logger(__name__)


def _client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    real = request.headers.get("x-real-ip", "")
    if real:
        return real.strip()
    return request.client.host if request.client else ""


def _tenant_from_request(request: Request, settings: Settings) -> str:
    api_key = request.headers.get("x-api-key")
    if api_key:
        try:
            row = resolve_db_key(api_key)
        except AuthError:
            row = None
        except Exception:
            row = None
        if row is not None and getattr(row, "tenant_id", None):
            return str(row.tenant_id)
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        token = auth.split(" ", 1)[1]
        try:
            claims = verify_jwt(token, settings)
            tid = claims.get("tenant")
            if tid:
                return str(tid)
        except Exception:
            pass
    return settings.default_tenant


class IpAllowlistMiddleware(BaseHTTPMiddleware):
    """Reject requests whose client IP is not in the tenant allowlist."""

    def __init__(self, app, *, settings: Settings, exempt_prefixes: Iterable[str] = ()):
        super().__init__(app)
        self.settings = settings
        self.exempt = tuple(exempt_prefixes)

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if any(path.startswith(p) for p in self.exempt):
            return await call_next(request)
        tenant = _tenant_from_request(request, self.settings)
        ip = _client_ip(request)
        if is_allowed(tenant, ip):
            return await call_next(request)
        log.warning(
            "ip_allowlist_block",
            tenant=tenant, ip=ip, path=path, method=request.method,
        )
        return JSONResponse(
            status_code=403,
            content={
                "error": "ip_not_allowed",
                "detail": (
                    "Client IP is not in this workspace's allowlist. "
                    "Ask a workspace admin to add it under Settings, "
                    "IP allowlist."
                ),
                "tenant_id": tenant,
            },
        )
