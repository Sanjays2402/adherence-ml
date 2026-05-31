"""Tests for W3C Trace Context propagation.

Covers two layers:

* The pure-python parser in ``adherence_common.trace_context`` (no FastAPI).
* The wired-up ``RequestIdMiddleware`` that must echo trace headers on
  every response, honor an inbound traceparent so downstream services
  inherit the trace_id, and mint a fresh spec-compliant one when no
  upstream context is provided.

This is the contract enterprise observability stacks (Datadog, Honeycomb,
Grafana Tempo, Jaeger) require to stitch a customer trace end-to-end.
"""
from __future__ import annotations

import re

from fastapi import FastAPI
from fastapi.testclient import TestClient

from adherence_api.middleware import RequestIdMiddleware
from adherence_common.trace_context import (
    context_for,
    mint_context,
    parse_traceparent,
)


_TRACEPARENT_RE = re.compile(
    r"^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$"
)


def _app() -> TestClient:
    app = FastAPI()
    app.add_middleware(RequestIdMiddleware)

    @app.get("/ping")
    def ping():
        return {"ok": True}

    return TestClient(app)


def test_parse_traceparent_accepts_valid_header():
    h = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    ctx = parse_traceparent(h)
    assert ctx is not None
    assert ctx.trace_id == "4bf92f3577b34da6a3ce929d0e0e4736"
    assert ctx.span_id == "00f067aa0ba902b7"
    assert ctx.flags == "01"
    assert ctx.inbound is True


def test_parse_traceparent_rejects_garbage_and_all_zero_ids():
    assert parse_traceparent(None) is None
    assert parse_traceparent("") is None
    assert parse_traceparent("not-a-header") is None
    # all-zero trace_id is invalid per spec
    bad = "00-" + ("0" * 32) + "-00f067aa0ba902b7-01"
    assert parse_traceparent(bad) is None
    # forbidden version
    bad2 = "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    assert parse_traceparent(bad2) is None


def test_mint_context_is_spec_compliant():
    ctx = mint_context()
    assert ctx.inbound is False
    assert _TRACEPARENT_RE.match(ctx.traceparent())


def test_context_for_falls_back_to_mint_on_invalid_header():
    ctx = context_for("garbage")
    assert ctx.inbound is False
    assert _TRACEPARENT_RE.match(ctx.traceparent())


def test_middleware_mints_trace_headers_when_no_inbound_context():
    r = _app().get("/ping")
    assert r.status_code == 200
    assert r.headers.get("x-request-id")
    tp = r.headers.get("traceparent")
    assert tp and _TRACEPARENT_RE.match(tp)
    trace_id = r.headers.get("x-trace-id")
    assert trace_id and trace_id == tp.split("-")[1]


def test_middleware_honors_inbound_traceparent_for_correlation():
    incoming = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    r = _app().get("/ping", headers={"traceparent": incoming})
    assert r.status_code == 200
    # trace_id must survive end-to-end so a downstream span the caller
    # already opened correlates with this request in their APM dashboard.
    assert r.headers["x-trace-id"] == "4bf92f3577b34da6a3ce929d0e0e4736"
    assert r.headers["traceparent"].startswith(
        "00-4bf92f3577b34da6a3ce929d0e0e4736-"
    )


def test_middleware_echoes_supplied_request_id():
    r = _app().get("/ping", headers={"x-request-id": "rid-abc-123"})
    assert r.headers["x-request-id"] == "rid-abc-123"
