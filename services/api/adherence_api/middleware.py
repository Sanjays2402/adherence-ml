"""Middleware: request ID + access log."""
from __future__ import annotations

import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from adherence_common.logging import get_logger

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
