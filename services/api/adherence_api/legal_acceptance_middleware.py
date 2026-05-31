"""Workspace-level legal acceptance enforcement.

If the calling workspace has not accepted the current Terms of Service
and Data Processing Agreement, every mutating request is rejected with
HTTP 451 ("Unavailable For Legal Reasons"). Read traffic, health and
metrics probes, GDPR data exit, SSO sign-in, and the ``/v1/legal``
endpoints themselves are exempt so a blocked workspace can still:

* read what it already has,
* see what it owes (``GET /v1/legal/outstanding``),
* fetch the document body (``GET /v1/legal/documents/...``),
* click accept (``POST /v1/legal/accept``),
* and, if it walks away from the contract, exfiltrate or erase its
  data via the GDPR endpoints.

Why a middleware (not per-route Depends)
----------------------------------------
Mirrors :class:`ScopeEnforceMiddleware`. Per-route checks only protect
routes that remember to declare them; the codebase has 60+ mutating
endpoints, so a single chokepoint here closes the gap for every route
at once, including ones added in the future.

Fail-open on infrastructure
---------------------------
If the DB lookup for outstanding kinds raises, the middleware lets the
request through. A failed legal-state lookup is logged as a warning;
we deliberately do not let a degraded DB take the API down. The same
philosophy is used by audit, MFA, and revocation in this codebase.
"""
from __future__ import annotations

from collections.abc import Iterable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from adherence_common.api_keys import resolve_db_key
from adherence_common.auth import verify_jwt
from adherence_common.errors import AuthError
from adherence_common.legal_acceptance import outstanding_kinds
from adherence_common.logging import get_logger
from adherence_common.settings import Settings

log = get_logger(__name__)

# Mutating methods. ``GET``/``HEAD``/``OPTIONS`` are intentionally
# excluded so a blocked workspace can still read state and learn what
# to accept.
_MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# Paths that are never gated, regardless of HTTP method. Health and
# metrics keep operators wired up; ``/v1/legal/*`` is what the tenant
# needs to call to unblock itself; ``/v1/gdpr`` is the contractual
# data-exit door and must stay open; SSO sign-in runs before any
# tenant context exists; SCIM uses its own bearer flow.
_EXEMPT_PREFIXES: tuple[str, ...] = (
    "/v1/health",
    "/healthz",
    "/readyz",
    "/metrics",
    "/openapi.json",
    "/docs",
    "/redoc",
    "/v1/legal",
    "/v1/gdpr",
    "/v1/admin/sso",
    "/v1/admin/token",
    "/v1/auth/scopes",
    "/scim/v2",
)


def _resolve_tenant(request: Request, settings: Settings) -> str:
    """Best-effort tenant resolution. Mirrors IP allowlist middleware.

    Returns the deployment-default tenant when no credential is present
    or the credential cannot be resolved, so unauthenticated probes
    never hit a 451.
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


class LegalAcceptanceMiddleware(BaseHTTPMiddleware):
    """Reject mutations from workspaces that owe a TOS/DPA acceptance."""

    def __init__(
        self,
        app,
        *,
        settings: Settings,
        exempt_prefixes: Iterable[str] = _EXEMPT_PREFIXES,
    ):
        super().__init__(app)
        self.settings = settings
        self.exempt = tuple(exempt_prefixes)

    async def dispatch(self, request: Request, call_next) -> Response:
        method = request.method.upper()
        if method not in _MUTATING_METHODS:
            return await call_next(request)

        path = request.url.path
        if any(path.startswith(p) for p in self.exempt):
            return await call_next(request)

        tenant = _resolve_tenant(request, self.settings)
        try:
            owed = outstanding_kinds(tenant)
        except Exception as exc:  # pragma: no cover - defensive
            log.warning("legal_acceptance_check_failed", error=str(exc), tenant=tenant)
            return await call_next(request)

        if not owed:
            return await call_next(request)

        rid = getattr(request.state, "request_id", None)
        log.info(
            "legal_acceptance_block",
            request_id=rid,
            tenant=tenant,
            method=method,
            path=path,
            outstanding=[item["kind"] + ":" + item["version"] for item in owed],
        )
        return JSONResponse(
            status_code=451,
            content={
                "error": "legal_acceptance_required",
                "detail": (
                    "This workspace must accept the current Terms of "
                    "Service and Data Processing Agreement before "
                    "submitting mutating requests. A workspace admin "
                    "can review and accept the outstanding documents "
                    "at /v1/legal/outstanding and POST /v1/legal/accept."
                ),
                "tenant_id": tenant,
                "outstanding": owed,
                "request_id": rid,
            },
            headers={"X-Legal-Acceptance": "required"},
        )
