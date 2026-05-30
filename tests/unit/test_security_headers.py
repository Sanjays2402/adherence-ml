"""Tests for the security headers middleware."""
from __future__ import annotations

from adherence_api.security_headers_middleware import (
    DEFAULT_PERMISSIONS_POLICY,
    SecurityHeadersMiddleware,
    build_headers,
)
from adherence_common.settings import Settings
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _app(settings: Settings) -> TestClient:
    app = FastAPI()
    app.add_middleware(SecurityHeadersMiddleware, settings=settings)

    @app.get("/ping")
    def ping() -> dict[str, str]:
        return {"ok": "yes"}

    @app.get("/custom-csp")
    def custom_csp():
        from starlette.responses import JSONResponse
        return JSONResponse(
            {"ok": "yes"},
            headers={"Content-Security-Policy": "default-src 'self' route-override"},
        )

    return TestClient(app)


def test_default_headers_present():
    s = Settings(jwt_secret="x" * 32)
    client = _app(s)
    r = client.get("/ping")
    assert r.status_code == 200
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"
    assert r.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert r.headers["Permissions-Policy"] == DEFAULT_PERMISSIONS_POLICY
    assert r.headers["Cross-Origin-Opener-Policy"] == "same-origin"
    assert r.headers["Cross-Origin-Resource-Policy"] == "same-site"
    # HSTS off by default
    assert "Strict-Transport-Security" not in r.headers
    # CSP off by default
    assert "Content-Security-Policy" not in r.headers


def test_hsts_emitted_when_enabled():
    s = Settings(
        jwt_secret="x" * 32,
        hsts_enabled=True,
        hsts_max_age_seconds=3600,
        hsts_include_subdomains=True,
        hsts_preload=True,
    )
    r = _app(s).get("/ping")
    hsts = r.headers["Strict-Transport-Security"]
    assert "max-age=3600" in hsts
    assert "includeSubDomains" in hsts
    assert "preload" in hsts


def test_csp_emitted_when_policy_set():
    policy = "default-src 'self'"
    s = Settings(jwt_secret="x" * 32, csp_policy=policy)
    r = _app(s).get("/ping")
    assert r.headers["Content-Security-Policy"] == policy


def test_disabled_middleware_skips_all_headers():
    s = Settings(jwt_secret="x" * 32, security_headers_enabled=False)
    r = _app(s).get("/ping")
    assert "X-Content-Type-Options" not in r.headers
    assert "X-Frame-Options" not in r.headers


def test_does_not_clobber_route_csp():
    policy = "default-src 'self' globally"
    s = Settings(jwt_secret="x" * 32, csp_policy=policy)
    r = _app(s).get("/custom-csp")
    # Route's own CSP wins.
    assert r.headers["Content-Security-Policy"] == "default-src 'self' route-override"


def test_build_headers_pure_helper_matches_disabled_hsts_default():
    s = Settings(jwt_secret="x" * 32)
    h = build_headers(s)
    assert "Strict-Transport-Security" not in h
    assert h["X-Frame-Options"] == "DENY"
