"""Rate limit middleware.

Applies a token-bucket limit per caller identity. Identity is, in order:
1. `x-api-key` header value (hashed for log/key safety)
2. `Authorization: Bearer <jwt>` subject (decoded best-effort)
3. Client IP (X-Forwarded-For first hop, then peer)

On allow: adds X-RateLimit-{Limit,Remaining,Reset} headers.
On block: returns 429 with Retry-After and the same headers.

Paths in `exempt_prefixes` skip the check (health probes, openapi).
"""
from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Iterable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from adherence_common.logging import get_logger
from adherence_common.ratelimit import RateLimiterBackend, build_backend
from adherence_common.settings import Settings

log = get_logger(__name__)


def _caller_id(request: Request) -> tuple[str, str]:
    """Return (identity_key, source) for the request."""
    api_key = request.headers.get("x-api-key")
    if api_key:
        return "k:" + hashlib.sha256(api_key.encode()).hexdigest()[:24], "api_key"
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        token = auth.split(" ", 1)[1]
        sub = _jwt_sub_unverified(token)
        if sub:
            return "j:" + sub, "jwt"
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        ip = xff.split(",")[0].strip()
    else:
        ip = request.client.host if request.client else "unknown"
    return "i:" + ip, "ip"


def _jwt_sub_unverified(token: str) -> str | None:
    """Read `sub` from JWT payload without signature check.

    Auth middleware does the real verification; we just need a stable key.
    """
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return None
        import base64
        pad = "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + pad))
        sub = payload.get("sub")
        return str(sub) if sub else None
    except Exception:
        return None


def _is_admin_path(path: str) -> bool:
    return path.startswith("/v1/admin") or path.startswith("/v1/train")


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(
        self,
        app,
        settings: Settings,
        backend: RateLimiterBackend | None = None,
        exempt_prefixes: Iterable[str] = (
            "/healthz", "/livez", "/readyz", "/openapi.json", "/docs", "/redoc",
        ),
    ) -> None:
        super().__init__(app)
        self._s = settings
        self._backend = backend or build_backend(settings.redis_url)
        self._exempt = tuple(exempt_prefixes)

    def _limits_for(self, path: str) -> tuple[int, float]:
        if _is_admin_path(path):
            return self._s.rate_limit_admin_capacity, self._s.rate_limit_admin_refill_per_sec
        return self._s.rate_limit_capacity, self._s.rate_limit_refill_per_sec

    async def dispatch(self, request: Request, call_next):
        if not self._s.rate_limit_enabled:
            return await call_next(request)
        path = request.url.path
        if any(path.startswith(p) for p in self._exempt):
            return await call_next(request)

        ident, source = _caller_id(request)
        capacity, refill = self._limits_for(path)
        key = f"{ident}:{'admin' if _is_admin_path(path) else 'default'}"
        decision = self._backend.check(key, capacity, refill)

        if not decision.allowed:
            retry = math.ceil(decision.retry_after) if math.isfinite(decision.retry_after) else 1
            log.warning(
                "rate_limited",
                path=path, source=source, key=ident[:12],
                retry_after=retry, capacity=capacity,
            )
            resp = JSONResponse(
                {"detail": "rate limit exceeded", "retry_after": retry},
                status_code=429,
            )
            resp.headers["Retry-After"] = str(retry)
            resp.headers["X-RateLimit-Limit"] = str(decision.limit)
            resp.headers["X-RateLimit-Remaining"] = "0"
            resp.headers["X-RateLimit-Reset"] = str(math.ceil(decision.reset))
            return resp

        response: Response = await call_next(request)
        response.headers["X-RateLimit-Limit"] = str(decision.limit)
        response.headers["X-RateLimit-Remaining"] = str(max(0, decision.remaining))
        response.headers["X-RateLimit-Reset"] = str(math.ceil(decision.reset))
        return response
