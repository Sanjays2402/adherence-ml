"""Per-workspace monthly quota enforcement.

Covers: tenant isolation (one workspace using its cap does not affect
another), 429 + Retry-After + X-RateLimit-* headers on overage, and
admin override raising the cap.
"""
from __future__ import annotations

import os
import sys

import pytest


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    db_file = tmp_path / "quota.db"
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{db_file}")
    # Reset cached engine/session factory + module state.
    for mod in list(sys.modules):
        if mod.startswith("adherence_common"):
            sys.modules.pop(mod, None)
    yield


def _fresh():
    from adherence_common import db, quota
    db.init_db()
    return db, quota


def test_consume_below_cap_allows_and_decrements_remaining():
    _, q = _fresh()
    q.set_plan("acme", plan="free")  # 1000/month
    d1 = q.check_and_consume("acme", cost=10)
    assert d1.allowed
    assert d1.used == 10
    assert d1.remaining == 990
    assert d1.limit == 1000
    assert d1.plan == "free"


def test_quota_isolates_workspaces():
    _, q = _fresh()
    q.set_plan("acme", plan="free", monthly_predictions_override=5)
    q.set_plan("beta", plan="free", monthly_predictions_override=5)
    # Drain acme.
    for _ in range(5):
        assert q.check_and_consume("acme").allowed
    blocked = q.check_and_consume("acme")
    assert not blocked.allowed
    # beta must still be wide open.
    ok = q.check_and_consume("beta")
    assert ok.allowed
    assert ok.used == 1


def test_overage_returns_retry_after_pointing_at_next_month():
    _, q = _fresh()
    q.set_plan("acme", plan="free", monthly_predictions_override=2)
    assert q.check_and_consume("acme").allowed
    assert q.check_and_consume("acme").allowed
    blocked = q.check_and_consume("acme")
    assert not blocked.allowed
    assert blocked.retry_after > 0
    # Reset must be on the 1st of some month at 00:00 UTC.
    assert blocked.reset_at.day == 1
    assert blocked.reset_at.hour == 0


def test_override_raises_effective_cap():
    _, q = _fresh()
    q.set_plan("acme", plan="free", monthly_predictions_override=10)
    _, cap, _ = q.get_plan("acme")
    assert cap == 10
    q.set_plan("acme", monthly_predictions_override=50_000)
    _, cap, _ = q.get_plan("acme")
    assert cap == 50_000


def test_api_returns_429_with_headers_on_overage(monkeypatch):
    # Build a tiny app with just the predict endpoint patched to skip ML,
    # but reuse the real quota helper to prove header wiring.
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse
    from fastapi.testclient import TestClient
    from starlette.responses import Response as StarletteResponse

    _, q = _fresh()
    q.set_plan("acme", plan="free", monthly_predictions_override=1)

    from adherence_api.quota_enforce import enforce_prediction_quota

    app = FastAPI()

    @app.post("/score")
    def score():
        carrier = StarletteResponse()
        enforce_prediction_quota("acme", carrier, cost=1)
        return JSONResponse({"ok": True}, headers=dict(carrier.headers))

    client = TestClient(app, raise_server_exceptions=False)
    r1 = client.post("/score")
    assert r1.status_code == 200
    assert r1.headers["X-RateLimit-Limit"] == "1"
    assert r1.headers["X-RateLimit-Remaining"] == "0"
    assert r1.headers["X-Quota-Plan"] == "free"

    r2 = client.post("/score")
    assert r2.status_code == 429
    assert int(r2.headers["Retry-After"]) >= 1
    assert r2.headers["X-RateLimit-Limit"] == "1"
    assert r2.headers["X-RateLimit-Remaining"] == "0"
    body = r2.json()
    assert body["detail"]["error"] == "quota_exceeded"
    assert body["detail"]["plan"] == "free"
