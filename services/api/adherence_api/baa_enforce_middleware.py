"""Workspace-level HIPAA BAA enforcement for PHI-bearing routes.

When a workspace flips ``require_baa_for_phi`` on (and is not in the
configured grace window), any request to a PHI-bearing route is
rejected with HTTP 451 ("Unavailable For Legal Reasons") until an
active BAA exists. The BAA register itself, plus GDPR data exit and
legal acceptance, stay reachable so the workspace can unblock itself.

PHI-bearing routes covered:

* ``/v1/predict`` (single + batch)
* ``/v1/explain`` (SHAP for a patient prediction)
* ``/v1/cohort`` and ``/v1/cohort/*`` (cohort analytics + CSV export)
* ``/v1/forecast`` (per-patient forecast)
* ``/v1/interventions`` (recommended actions per patient)
* ``/v1/phi/*`` (PHI access endpoints)
* ``/v1/dsar`` (subject access)

Operator probes (health, metrics, .well-known, docs), authentication
flows (SSO, scopes, MFA), GDPR data exit, legal acceptance, and the
BAA admin endpoints themselves are always exempt.

If the policy lookup raises, the middleware lets the request through
and logs a warning, matching the legal-acceptance middleware.
"""
from __future__ import annotations

from collections.abc import Iterable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from adherence_common import baa as baa_mod
from adherence_common.api_keys import resolve_db_key
from adherence_common.auth import verify_jwt
from adherence_common.errors import AuthError
from adherence_common.logging import get_logger
from adherence_common.settings import Settings

log = get_logger(__name__)

_PHI_PREFIXES: tuple[str, ...] = (
    "/v1/predict",
    "/v1/explain",
    "/v1/cohort",
    "/v1/forecast",
    "/v1/interventions",
    "/v1/phi",
    "/v1/dsar",
)

_EXEMPT_PREFIXES: tuple[str, ...] = (
    "/v1/health",
    "/healthz",
    "/readyz",
    "/metrics",
    "/openapi.json",
    "/docs",
    "/redoc",
    "/.well-known",
    "/v1/legal",
    "/v1/subprocessors",
    "/v1/caiq",
    "/v1/gdpr",
    "/v1/admin/baa",
    "/v1/admin/sso",
    "/v1/admin/token",
    "/v1/auth/scopes",
    "/scim/v2",
)


def _resolve_tenant(request: Request, settings: Settings) -> str:
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


class BaaEnforcementMiddleware(BaseHTTPMiddleware):
    """Reject PHI traffic when a workspace owes a signed BAA."""

    def __init__(
        self,
        app,
        *,
        settings: Settings,
        phi_prefixes: Iterable[str] = _PHI_PREFIXES,
        exempt_prefixes: Iterable[str] = _EXEMPT_PREFIXES,
    ):
        super().__init__(app)
        self.settings = settings
        self.phi_prefixes = tuple(phi_prefixes)
        self.exempt = tuple(exempt_prefixes)

    async def dispatch(self, request: Request, call_next) -> Response:
        path = request.url.path
        if any(path.startswith(p) for p in self.exempt):
            return await call_next(request)
        if not any(path == p or path.startswith(p + "/") for p in self.phi_prefixes):
            return await call_next(request)

        tenant = _resolve_tenant(request, self.settings)
        try:
            state = baa_mod.enforcement_state(tenant)
        except Exception as exc:  # pragma: no cover - defensive
            log.warning(
                "baa_enforcement_check_failed", error=str(exc), tenant=tenant
            )
            return await call_next(request)

        if not state.get("should_block"):
            return await call_next(request)

        rid = getattr(request.state, "request_id", None)
        log.info(
            "baa_enforcement_block",
            request_id=rid,
            tenant=tenant,
            method=request.method,
            path=path,
        )
        return JSONResponse(
            status_code=451,
            content={
                "error": "baa_required",
                "detail": (
                    "This workspace requires a signed HIPAA Business "
                    "Associate Agreement before PHI-bearing endpoints "
                    "can be called. A workspace admin can register the "
                    "executed BAA at POST /v1/admin/baa, or extend the "
                    "grace window at PUT /v1/admin/baa/policy."
                ),
                "tenant_id": tenant,
                "request_id": rid,
            },
            headers={"X-BAA-Required": "true"},
        )
