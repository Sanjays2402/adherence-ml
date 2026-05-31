"""Middleware: request ID, W3C trace context propagation, access log."""
from __future__ import annotations

import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from adherence_common.logging import get_logger
from adherence_common.prom import LATENCY, REQUESTS
from adherence_common.trace_context import context_for

log = get_logger(__name__)


class RequestIdMiddleware(BaseHTTPMiddleware):
    """Attach a request id + W3C trace context to every request.

    Behavior:

    * ``X-Request-Id`` is honored when supplied, otherwise minted. It is
      echoed back on the response and stored on ``request.state`` so
      downstream code can include it in audit rows and structured logs.
    * ``traceparent`` (W3C Trace Context) is parsed when present; the
      caller's trace_id is preserved so logs and downstream spans
      correlate across services. When absent or malformed, a fresh
      spec-compliant traceparent is minted.
    * The response carries the (potentially fresh) ``traceparent`` plus
      a convenience ``X-Trace-Id`` header that ops dashboards and
      curl-driven debugging can grep on without a regex.
    * The access log line carries ``request_id`` and ``trace_id`` so a
      single grep stitches request → trace → downstream span.
    """

    async def dispatch(self, request: Request, call_next):
        rid = request.headers.get("x-request-id", uuid.uuid4().hex[:12])
        ctx = context_for(request.headers.get("traceparent"))
        request.state.request_id = rid
        request.state.trace_id = ctx.trace_id
        request.state.span_id = ctx.span_id
        request.state.trace_context_inbound = ctx.inbound
        t0 = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception as exc:
            log.exception(
                "request error",
                request_id=rid,
                trace_id=ctx.trace_id,
                span_id=ctx.span_id,
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
            trace_id=ctx.trace_id,
            span_id=ctx.span_id,
            trace_inbound=ctx.inbound,
            path=request.url.path,
            method=request.method,
            status=response.status_code,
            duration_ms=round(dt, 2),
        )
        response.headers["x-request-id"] = rid
        response.headers["x-trace-id"] = ctx.trace_id
        response.headers["traceparent"] = ctx.traceparent()
        # Stamp the active data-residency region for tenant-bound
        # requests so callers (and security reviewers running curl) can
        # confirm the contractual region without reading docs. We only
        # stamp when a tenant was resolved on the request, which keeps
        # public endpoints (health, metrics, docs) unaffected.
        tenant = getattr(request.state, "tenant", None)
        if tenant:
            try:
                from adherence_common.residency import get_region
                response.headers["x-data-residency"] = get_region(str(tenant))
            except Exception:  # pragma: no cover - defensive
                pass
        return response


def _route_template(request: Request) -> str | None:
    """Use the matched route template (low cardinality) when available."""
    route = request.scope.get("route")
    path = getattr(route, "path", None)
    return path
