"""HIPAA Purpose of Use (POU) gate for PHI endpoints.

Sits in the middleware chain after auth headers are presented and
before route dispatch. For each request whose path looks like a PHI
surface (see :data:`adherence_common.purpose_of_use.PHI_PREFIXES`) we:

1. Resolve the caller's tenant (same logic as the IP allowlist).
2. Load the tenant's :class:`WorkspacePurposeOfUsePolicy`.
3. Read the ``X-Purpose-Of-Use`` header from the request.
4. If the policy is enforcing and the header is missing or not in
   the allowed set, short-circuit with HTTP 412 plus the
   ``X-Purpose-Required`` header listing acceptable values.
5. Otherwise pass through; after the route returns, stamp the
   ``X-Purpose-Of-Use`` response header and append one
   :class:`PHIAccessLogRow` row.

Why a middleware, not a per-route Depends
-----------------------------------------
The codebase has dozens of PHI-touching endpoints across half a
dozen routers. Enforcing at one chokepoint prevents a future PR from
adding a new ``/v1/predict/...`` route that quietly skips the gate.
This is the same reasoning used by :mod:`legal_acceptance_middleware`
and :mod:`scope_enforce_middleware`.

Fail-open on infrastructure
---------------------------
DB lookups are wrapped in ``purpose_of_use``; a failed policy load
yields the default-off view and the request proceeds. Log writes
are best-effort. A failed log insert never fails the request.
"""
from __future__ import annotations

import time
from collections.abc import Iterable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from adherence_api.ip_allowlist_middleware import _client_ip, _resolve_credential
from adherence_common.logging import get_logger
from adherence_common.purpose_of_use import (
    POU_HEADER,
    POU_REQUIRED_HEADER,
    evaluate,
    is_phi_path,
    normalize_code,
    record_access,
)
from adherence_common.settings import Settings

log = get_logger(__name__)


def _extract_user_id(request: Request) -> str | None:
    """Best-effort: pull a user id from the path for log indexing.

    The convention in this repo is ``/v1/users/{user_id}/...`` for
    per-user endpoints. We only read what's already there; we do not
    parse bodies (that would require reading the stream and re-injecting
    it, which adds cost on the hot path).
    """
    parts = [p for p in (request.url.path or "").split("/") if p]
    for i, p in enumerate(parts):
        if p == "users" and i + 1 < len(parts):
            return parts[i + 1]
    return None


class PurposeOfUseMiddleware(BaseHTTPMiddleware):
    """Enforce per-workspace HIPAA POU policy on PHI routes."""

    def __init__(
        self, app, *, settings: Settings, exempt_prefixes: Iterable[str] = ()
    ):
        super().__init__(app)
        self.settings = settings
        self.exempt = tuple(exempt_prefixes)

    async def dispatch(self, request: Request, call_next):
        path = request.url.path or ""
        # Cheap exits first: non-PHI routes and explicit exemptions
        # never touch the policy store.
        if any(path.startswith(p) for p in self.exempt):
            return await call_next(request)
        if not is_phi_path(path):
            return await call_next(request)
        # CORS preflight: pass through; CORSMiddleware answers OPTIONS
        # and the follow-up request will be checked.
        if request.method == "OPTIONS":
            return await call_next(request)

        tenant, key_name, _ = _resolve_credential(request, self.settings)
        caller_purpose = request.headers.get(POU_HEADER)
        ok, effective, pol = evaluate(
            tenant_id=tenant, caller_purpose=caller_purpose
        )
        if not ok:
            # Record the denied attempt so workspace owners can spot
            # callers stuck without a purpose header.
            record_access(
                tenant_id=tenant,
                request_id=getattr(request.state, "request_id", None),
                route=path,
                method=request.method,
                purpose=(normalize_code(caller_purpose) or "MISSING"),
                actor=str(key_name or "unknown"),
                actor_role="unknown",
                key_name=key_name,
                client_ip=_client_ip(request),
                status_code=412,
                latency_ms=None,
                user_id=_extract_user_id(request),
                note="rejected by purpose-of-use policy",
            )
            log.warning(
                "pou_block",
                tenant=tenant, path=path, method=request.method,
                supplied=caller_purpose,
                allowed=list(pol.allowed),
            )
            return JSONResponse(
                status_code=412,
                headers={POU_REQUIRED_HEADER: ",".join(pol.allowed)},
                content={
                    "error": "purpose_of_use_required",
                    "detail": (
                        "This workspace requires every PHI request to declare "
                        "a HIPAA purpose of use via the "
                        f"{POU_HEADER} header. Acceptable values: "
                        f"{', '.join(pol.allowed) or '(none configured)'}."
                    ),
                    "tenant_id": tenant,
                    "allowed": list(pol.allowed),
                    "header": POU_HEADER,
                },
            )

        # Stash on request.state for downstream handlers (e.g. so the
        # prediction audit row can copy the POU later if it wants).
        try:
            request.state.purpose_of_use = effective
        except Exception:
            pass

        started = time.perf_counter()
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - started) * 1000.0

        # Stamp the response so SIEM/SDK telemetry can correlate.
        try:
            response.headers[POU_HEADER] = effective or ""
        except Exception:
            pass

        # Append the access log row. Wrap everything: a log failure
        # never fails the request the caller already got an answer for.
        try:
            record_access(
                tenant_id=tenant,
                request_id=getattr(request.state, "request_id", None),
                route=path,
                method=request.method,
                purpose=effective or "UNSPECIFIED",
                actor=str(key_name or "unknown"),
                actor_role="unknown",
                key_name=key_name,
                client_ip=_client_ip(request),
                status_code=int(getattr(response, "status_code", 0) or 0),
                latency_ms=elapsed_ms,
                user_id=_extract_user_id(request),
            )
        except Exception as exc:  # pragma: no cover - defensive
            log.warning("pou_log_failed", error=str(exc))

        return response
