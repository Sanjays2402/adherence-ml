"""Security headers middleware.

Adds standard browser-side hardening response headers on every reply:

- ``Strict-Transport-Security`` (HSTS), only when ``hsts_enabled`` is true.
  Default off in dev/test so local HTTP curl flows are unaffected; turn it on
  in prod via ``ADHERENCE_HSTS_ENABLED=true``.
- ``X-Content-Type-Options: nosniff``
- ``X-Frame-Options: DENY``
- ``Referrer-Policy: strict-origin-when-cross-origin``
- ``Permissions-Policy`` with camera/microphone/geolocation disabled
- ``Cross-Origin-Opener-Policy: same-origin``
- ``Cross-Origin-Resource-Policy: same-site``
- ``Content-Security-Policy`` (optional) when ``csp_policy`` is non-empty.
  Left empty by default because the API serves PNG plots and JSON only; the
  Next.js front end sets its own CSP at the edge.

Existing headers (set by an upstream proxy or by a route) are preserved and not
overwritten. The middleware is a no-op when ``security_headers_enabled`` is
false.
"""
from __future__ import annotations

from adherence_common.settings import Settings
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

DEFAULT_PERMISSIONS_POLICY = (
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), "
    "magnetometer=(), gyroscope=(), accelerometer=()"
)


def build_headers(settings: Settings) -> dict[str, str]:
    """Return the static header set this middleware would emit.

    Pure helper so unit tests can assert the policy without spinning a client.
    """
    headers: dict[str, str] = {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Permissions-Policy": DEFAULT_PERMISSIONS_POLICY,
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-site",
    }
    if settings.hsts_enabled:
        directives = [f"max-age={int(settings.hsts_max_age_seconds)}"]
        if settings.hsts_include_subdomains:
            directives.append("includeSubDomains")
        if settings.hsts_preload:
            directives.append("preload")
        headers["Strict-Transport-Security"] = "; ".join(directives)
    if settings.csp_policy:
        headers["Content-Security-Policy"] = settings.csp_policy
    return headers


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, settings: Settings) -> None:
        super().__init__(app)
        self._settings = settings
        self._enabled = settings.security_headers_enabled
        self._headers = build_headers(settings) if self._enabled else {}

    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        if not self._enabled:
            return response
        for name, value in self._headers.items():
            # Do not clobber a header already set upstream (e.g. by a proxy or
            # a route returning a custom CSP for a specific HTML response).
            if name not in response.headers:
                response.headers[name] = value
        return response
