"""Tests for the token-bucket rate limiter (in-memory backend) and middleware."""
from __future__ import annotations

import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from adherence_common.ratelimit import InMemoryBackend
from adherence_common.settings import Settings
from adherence_api.ratelimit_middleware import RateLimitMiddleware


def test_inmemory_allows_burst_then_blocks():
    b = InMemoryBackend()
    for _ in range(5):
        d = b.check("user-a", capacity=5, refill_per_sec=10.0)
        assert d.allowed
    d = b.check("user-a", capacity=5, refill_per_sec=10.0)
    assert not d.allowed
    assert d.retry_after > 0
    assert d.limit == 5


def test_inmemory_refills_over_time():
    b = InMemoryBackend()
    # drain
    for _ in range(3):
        b.check("u", capacity=3, refill_per_sec=100.0)
    assert not b.check("u", capacity=3, refill_per_sec=100.0).allowed
    time.sleep(0.05)  # 5 tokens worth
    assert b.check("u", capacity=3, refill_per_sec=100.0).allowed


def test_inmemory_isolates_keys():
    b = InMemoryBackend()
    for _ in range(2):
        b.check("a", capacity=2, refill_per_sec=0.1)
    assert not b.check("a", capacity=2, refill_per_sec=0.1).allowed
    # different key still has a fresh bucket
    assert b.check("b", capacity=2, refill_per_sec=0.1).allowed


def test_zero_refill_returns_infinite_retry_when_empty():
    b = InMemoryBackend()
    b.check("z", capacity=1, refill_per_sec=0.0)
    d = b.check("z", capacity=1, refill_per_sec=0.0)
    assert not d.allowed
    assert d.retry_after == float("inf")


def _build_app(settings: Settings) -> TestClient:
    app = FastAPI()
    backend = InMemoryBackend()
    app.add_middleware(RateLimitMiddleware, settings=settings, backend=backend)

    @app.get("/ping")
    def ping():
        return {"ok": True}

    @app.get("/healthz")
    def health():
        return {"ok": True}

    @app.get("/v1/admin/whoami")
    def admin():
        return {"ok": True}

    return TestClient(app)


def test_middleware_blocks_after_capacity():
    s = Settings(
        rate_limit_enabled=True,
        rate_limit_capacity=3,
        rate_limit_refill_per_sec=0.1,
    )
    c = _build_app(s)
    for _ in range(3):
        r = c.get("/ping", headers={"x-api-key": "abc"})
        assert r.status_code == 200
        assert r.headers["X-RateLimit-Limit"] == "3"
    r = c.get("/ping", headers={"x-api-key": "abc"})
    assert r.status_code == 429
    assert int(r.headers["Retry-After"]) >= 1
    assert r.headers["X-RateLimit-Remaining"] == "0"


def test_middleware_skips_health_probes():
    s = Settings(rate_limit_enabled=True, rate_limit_capacity=1, rate_limit_refill_per_sec=0.01)
    c = _build_app(s)
    for _ in range(10):
        assert c.get("/healthz").status_code == 200


def test_middleware_uses_admin_limits_for_admin_paths():
    s = Settings(
        rate_limit_enabled=True,
        rate_limit_capacity=100,
        rate_limit_refill_per_sec=10.0,
        rate_limit_admin_capacity=2,
        rate_limit_admin_refill_per_sec=0.01,
    )
    c = _build_app(s)
    headers = {"x-api-key": "k1"}
    for _ in range(2):
        assert c.get("/v1/admin/whoami", headers=headers).status_code == 200
    assert c.get("/v1/admin/whoami", headers=headers).status_code == 429
    # default bucket is unrelated and still wide open
    assert c.get("/ping", headers=headers).status_code == 200


def test_middleware_distinguishes_api_keys():
    s = Settings(rate_limit_enabled=True, rate_limit_capacity=1, rate_limit_refill_per_sec=0.001)
    c = _build_app(s)
    assert c.get("/ping", headers={"x-api-key": "alpha"}).status_code == 200
    assert c.get("/ping", headers={"x-api-key": "alpha"}).status_code == 429
    assert c.get("/ping", headers={"x-api-key": "beta"}).status_code == 200


def test_middleware_disabled_passes_through():
    s = Settings(rate_limit_enabled=False, rate_limit_capacity=1, rate_limit_refill_per_sec=0.001)
    c = _build_app(s)
    for _ in range(5):
        assert c.get("/ping").status_code == 200


def test_middleware_falls_back_to_ip_when_no_credentials():
    s = Settings(rate_limit_enabled=True, rate_limit_capacity=2, rate_limit_refill_per_sec=0.001)
    c = _build_app(s)
    assert c.get("/ping").status_code == 200
    assert c.get("/ping").status_code == 200
    assert c.get("/ping").status_code == 429
