"""Middleware: request ID + access log."""
from __future__ import annotations

import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from adherence_common.logging import get_logger
from adherence_common.prom import LATENCY, REQUESTS

log = get_logger(__name__)


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        rid = request.headers.get("x-request-id", uuid.uuid4().hex[:12])
        request.state.request_id = rid
        t0 = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception as exc:
            log.exception(
                "request error",
                request_id=rid,
                path=request.url.path,
                method=request.method,
                error=str(exc),
            )
            raise
        dt = (time.perf_counter() - t0) * 1000.0
        route_label = _route_template(request) or request.url.path
        REQUESTS.inc(
            method=request.method, route=route_label,
            status=str(response.status_code),
        )
        LATENCY.observe(
            dt, method=request.method, route=route_label,
        )
        log.info(
            "request",
            request_id=rid,
            path=request.url.path,
            method=request.method,
            status=response.status_code,
            duration_ms=round(dt, 2),
        )
        response.headers["x-request-id"] = rid
        return response


def _route_template(request: Request) -> str | None:
    """Use the matched route template (low cardinality) when available."""
    route = request.scope.get("route")
    path = getattr(route, "path", None)
    return path
