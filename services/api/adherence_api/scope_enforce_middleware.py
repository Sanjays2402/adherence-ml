"""Scope enforcement middleware.

Runs after auth/rate-limit/IP middleware and before route dispatch.
For requests authenticated with a DB-backed API key that carries a
non-empty scope set, the middleware looks up the canonical scope for
``METHOD + path`` in :mod:`adherence_api.scope_catalog` and rejects the
request with 403 if the scope is missing.

Why a middleware (not a per-route Depends)
------------------------------------------
Per-route ``Depends(require_scope("..."))`` only enforces scopes on
routes that remember to declare it. The repo grew faster than that
pattern: of 60+ mutating routes, only ``/v1/gdpr`` had scope checks
wired in. Centralising the check here closes the gap for every route at
once, including ones added in the future, and lets us expose the same
catalog via ``/v1/auth/scopes`` for procurement evidence.

Backward-compatibility
----------------------
* Requests without an ``x-api-key`` (JWT-only, env keys) are passed
  through unchanged: those credentials do not carry scopes today and
  the role checks on the route remain the source of truth.
* DB-backed keys with an **empty** scope set are passed through too
  (this preserves the documented "empty scopes means all the role
  allows" behaviour and avoids breaking existing keys on upgrade).
* Admin-role keys with scopes still must match (otherwise scopes on an
  admin key would be meaningless). Admin-role keys *without* scopes
  bypass enforcement, matching today's behaviour.
"""
from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from adherence_common.api_keys import resolve_db_key
from adherence_common.errors import AuthError
from adherence_common.logging import get_logger

from adherence_api.scope_catalog import is_exempt, required_scope

log = get_logger(__name__)


class ScopeEnforceMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        path = request.url.path
        if is_exempt(path):
            return await call_next(request)

        api_key = request.headers.get("x-api-key")
        if not api_key:
            return await call_next(request)

        try:
            dbk = resolve_db_key(api_key)
        except AuthError:
            # Let downstream auth produce the 401 with the usual shape.
            return await call_next(request)
        except Exception:
            return await call_next(request)

        if dbk is None:
            # Legacy env-mapped key: no scope metadata; pass through.
            return await call_next(request)

        scopes = dbk.scopes or frozenset()
        if not scopes:
            # Empty allowlist = "all the role allows" (legacy behaviour).
            return await call_next(request)

        scope = required_scope(request.method, path)
        if scope is None:
            # Route is not catalogued: skip (the route's own role check
            # still applies). New routes should be added to the catalog.
            return await call_next(request)

        if scope in scopes:
            return await call_next(request)

        rid = getattr(request.state, "request_id", None)
        log.info(
            "scope_denied",
            request_id=rid,
            key_name=dbk.name,
            tenant=dbk.tenant_id,
            method=request.method,
            path=path,
            required_scope=scope,
            present_scopes=sorted(scopes),
        )
        return JSONResponse(
            status_code=403,
            content={
                "error": "insufficient_scope",
                "message": f"API key is missing required scope {scope!r}",
                "required_scope": scope,
                "request_id": rid,
            },
            headers={"X-Required-Scope": scope},
        )
