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

from adherence_common.api_keys import ip_matches_allowlist, resolve_db_key
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


def _resolve_credential(request: Request, settings: Settings) -> tuple[str, str | None, tuple[str, ...]]:
    """Return (tenant_id, key_name_or_None, per_key_cidrs).

    Best-effort: any auth resolution failure falls back to the deployment
    default tenant with no per-key restriction so unauthenticated probes
    and the open landing page continue to work.
    """
    api_key = request.headers.get("x-api-key")
    if api_key:
        try:
            row = resolve_db_key(api_key)
        except AuthError:
            row = None
        except Exception:
            row = None
        if row is not None and getattr(row, "tenant_id", None):
            return (
                str(row.tenant_id),
                getattr(row, "name", None),
                tuple(getattr(row, "ip_allowlist", ()) or ()),
            )
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        token = auth.split(" ", 1)[1]
        try:
            claims = verify_jwt(token, settings)
            tid = claims.get("tenant")
            if tid:
                return (str(tid), None, ())
        except Exception:
            pass
    return (settings.default_tenant, None, ())


def _tenant_from_request(request: Request, settings: Settings) -> str:
    tenant, _, _ = _resolve_credential(request, settings)
    return tenant


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
        tenant, key_name, key_cidrs = _resolve_credential(request, self.settings)
        ip = _client_ip(request)
        # Per-key allowlist first: even if the tenant has no allowlist, a
        # caller may have pinned this specific API key to a known set of
        # source ranges (e.g. their production egress).
        if key_cidrs and not ip_matches_allowlist(ip, key_cidrs):
            log.warning(
                "api_key_ip_allowlist_block",
                tenant=tenant, key=key_name, ip=ip, path=path,
                method=request.method,
            )
            return JSONResponse(
                status_code=403,
                content={
                    "error": "api_key_ip_not_allowed",
                    "detail": (
                        "This API key is restricted to a specific set of "
                        "source IPs. Your client IP is not in that list. "
                        "Ask an admin to update the key's IP allowlist under "
                        "/v1/admin/api-keys/{name}/ip-allowlist."
                    ),
                    "tenant_id": tenant,
                    "key": key_name,
                },
            )
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
