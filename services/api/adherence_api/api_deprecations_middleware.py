"""Inject RFC 8594 + draft-ietf-httpapi-deprecation-header response
headers on every response that matches a row in the API deprecation
registry.

Header set written:

* ``Deprecation: <IMF-fixdate>`` (draft-ietf-httpapi-deprecation-header)
* ``Sunset: <IMF-fixdate>`` (RFC 8594)
* ``Link: <url>; rel="successor-version"`` and
  ``Link: <url>; rel="deprecation"`` so reviewers can land directly
  on the changelog blurb.

The middleware also bumps a per-tenant usage counter so workspace
admins can see "we still hit this endpoint N times; sunset is in 17
days" in their admin console. Counter writes are best-effort and
never leak across tenants because every write is scoped by the
caller's resolved tenant id.

This middleware never blocks: deprecation is signal, not denial.
Sunset enforcement (after a grace period) is a separate policy that
lives upstream of this header layer.
"""
from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from adherence_common.api_deprecations import (
    DeprecationOut,
    lookup_for_request,
    record_usage,
)
from adherence_common.logging import get_logger
from adherence_common.settings import Settings

from adherence_api.ip_allowlist_middleware import _tenant_from_request

log = get_logger(__name__)


# Paths that never carry a tenant context (public trust surfaces,
# probes, docs). We still stamp the headers if the path matches a
# registered prefix, but skip the per-tenant usage write so we don't
# create phantom "default" rows.
_NO_TENANT_PREFIXES = (
    "/healthz",
    "/readyz",
    "/metrics",
    "/openapi.json",
    "/docs",
    "/redoc",
    "/.well-known",
    "/v1/health",
)


def _stamp_headers(response, match: DeprecationOut) -> None:
    response.headers["Deprecation"] = match.deprecated_at
    response.headers["Sunset"] = match.sunset_at
    links: list[str] = []
    if match.successor_link:
        links.append(f'<{match.successor_link}>; rel="successor-version"')
    # Self-describing deprecation link so reviewers and SDKs can fetch
    # the rationale without out-of-band docs.
    links.append('</.well-known/api-deprecations>; rel="deprecation"; type="application/json"')
    existing = response.headers.get("Link")
    if existing:
        links.insert(0, existing)
    response.headers["Link"] = ", ".join(links)


class ApiDeprecationsMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, *, settings: Settings):
        super().__init__(app)
        self.settings = settings

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        method = request.method
        match = lookup_for_request(method, path)
        response = await call_next(request)
        if match is None:
            return response
        try:
            _stamp_headers(response, match)
        except Exception as exc:  # pragma: no cover
            log.warning("deprecation_header_stamp_failed", error=str(exc), path=path)
            return response
        # Track usage only for tenant-bound traffic. Probes and public
        # well-known endpoints have no tenant and would create noise.
        if not any(path.startswith(p) for p in _NO_TENANT_PREFIXES):
            try:
                tenant = _tenant_from_request(request, self.settings)
                if tenant:
                    record_usage(tenant_id=tenant, deprecation_id=match.id)
            except Exception as exc:  # pragma: no cover
                log.warning("deprecation_usage_record_failed", error=str(exc), path=path)
        return response
