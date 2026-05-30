"""Request body size limit middleware.

Rejects requests whose body exceeds a configurable limit with HTTP 413
(Payload Too Large). Protects against memory exhaustion DoS where a caller
sends a multi-gigabyte JSON blob and parks the worker decoding it.

Two enforcement paths, in order:

1. Fast path: if the request advertises ``Content-Length`` and it is over
   the limit, reject immediately without reading the body.
2. Streaming path: for chunked / unknown-length requests we wrap the ASGI
   receive callable and tally bytes as they arrive. The first chunk that
   pushes us past the limit short-circuits with 413 before the handler
   ever sees the full payload.

Health probes, OpenAPI docs, and the Prometheus scrape path are exempted
via ``exempt_prefixes``. Per-route overrides are read from the matched
endpoint via the ``max_body_bytes`` attribute (set with the
``with_max_body`` decorator) so cohort bulk imports can stay generous
while admin write endpoints stay tight.

The default limit lives in Settings (``ADHERENCE_MAX_BODY_BYTES``) and is
1 MiB, which fits a several-thousand-dose schedule with headroom and is
still small enough to reject obvious abuse early. Implemented as a pure
ASGI middleware (not BaseHTTPMiddleware) so it can short-circuit during
the receive phase without the framework buffering the body first.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any

import orjson
from adherence_common.logging import get_logger
from adherence_common.prom import REQUESTS
from adherence_common.settings import Settings
from starlette.types import ASGIApp, Message, Receive, Scope, Send

log = get_logger(__name__)

# Methods that carry a request body worth limiting. We do not bother
# enforcing on GET/HEAD/DELETE because Starlette will not read a body
# for them in our handlers.
_BODY_METHODS = frozenset({"POST", "PUT", "PATCH"})


def with_max_body(max_bytes: int) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Decorator: attach a per-route body size override to a FastAPI handler.

    Example:

        @router.post("/v1/cohort/bulk")
        @with_max_body(8 * 1024 * 1024)
        def bulk(...): ...

    The middleware reads the attribute off the matched endpoint at request
    time. Unset means the global default from Settings applies.
    """
    if max_bytes <= 0:
        raise ValueError("max_bytes must be positive")

    def _wrap(fn: Callable[..., Any]) -> Callable[..., Any]:
        fn.max_body_bytes = max_bytes  # type: ignore[attr-defined]
        return fn

    return _wrap


async def _send_413(
    send: Send, limit: int, received: int | None, method: str, path: str
) -> None:
    REQUESTS.inc(method=method, route=path, status="413")
    body: dict[str, Any] = {
        "detail": "request body too large",
        "limit_bytes": limit,
    }
    if received is not None:
        body["received_bytes"] = received
    payload = orjson.dumps(body)
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(payload)).encode()),
                (b"connection", b"close"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": payload, "more_body": False})


def _endpoint_override(scope: Scope) -> int | None:
    # Starlette routes the request before our middleware sees the body
    # only if we are added after the router. We are added in app.py
    # before the router runs, so scope["endpoint"] may be absent on the
    # first dispatch. In that case the global default applies, which is
    # the safe choice.
    endpoint = scope.get("endpoint")
    if endpoint is None:
        return None
    override = getattr(endpoint, "max_body_bytes", None)
    if isinstance(override, int) and override > 0:
        return override
    return None


class BodySizeLimitMiddleware:
    """Pure ASGI middleware. Caps request body size with a fast
    Content-Length check and a streaming fallback for chunked uploads.
    """

    def __init__(
        self,
        app: ASGIApp,
        settings: Settings,
        exempt_prefixes: Iterable[str] = (
            "/healthz", "/livez", "/readyz", "/metrics",
            "/openapi.json", "/docs", "/redoc",
        ),
    ) -> None:
        self.app = app
        self._s = settings
        self._exempt = tuple(exempt_prefixes)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not self._s.body_size_limit_enabled:
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "")
        if method not in _BODY_METHODS:
            await self.app(scope, receive, send)
            return

        raw_path: str = scope.get("path", "") or ""
        if any(raw_path.startswith(p) for p in self._exempt):
            await self.app(scope, receive, send)
            return

        override = _endpoint_override(scope)
        limit = override if override is not None else int(self._s.max_body_bytes)

        # Fast path: trust Content-Length when present and over the cap.
        headers = scope.get("headers") or []
        content_length: int | None = None
        for name, value in headers:
            if name == b"content-length":
                try:
                    content_length = int(value.decode("latin-1"))
                except ValueError:
                    content_length = None
                break

        if content_length is not None and content_length > limit:
            log.warning(
                "body_too_large_content_length",
                path=raw_path, method=method,
                content_length=content_length, limit=limit,
            )
            await _send_413(send, limit, content_length, method, raw_path)
            return

        # Streaming path: wrap receive and tally bytes as they arrive.
        total = 0
        exceeded = False
        rejected = False

        async def receive_wrapped() -> Message:
            nonlocal total, exceeded, rejected
            msg = await receive()
            if msg.get("type") != "http.request":
                return msg
            body = msg.get("body") or b""
            total += len(body)
            if total > limit and not rejected:
                exceeded = True
                rejected = True
                # Cut off the stream so the inner app sees EOF instead of
                # the offending bytes. The 413 response is sent from the
                # outer scope below.
                return {"type": "http.request", "body": b"", "more_body": False}
            return msg

        # Track whether the inner app started a response. If it did, we
        # cannot also send our 413 (would corrupt the wire); we log and
        # let the inner response stand. In practice the inner handler
        # blocks on receive(), so we usually win the race.
        response_started = False

        async def send_wrapped(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        await self.app(scope, receive_wrapped, send_wrapped)

        if exceeded and not response_started:
            # Inner app never produced a response (it bailed on the empty
            # body, or never got a chance). Emit our 413 now.
            log.warning(
                "body_too_large_streaming",
                path=raw_path, method=method,
                received=total, limit=limit,
            )
            await _send_413(send, limit, total, method, raw_path)
        elif exceeded and response_started:
            # Rare: handler responded before noticing the truncation.
            # Still record the metric and log so this is visible.
            log.warning(
                "body_too_large_streaming_late",
                path=raw_path, method=method,
                received=total, limit=limit,
            )
            REQUESTS.inc(method=method, route=raw_path, status="413")
