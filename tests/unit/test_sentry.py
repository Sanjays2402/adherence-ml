"""Tests for Sentry initialization wiring (adherence_common.sentry)."""
from __future__ import annotations

import pytest
from adherence_common import sentry as sentry_mod
from adherence_common.settings import reload_settings
from pydantic import ValidationError


@pytest.fixture(autouse=True)
def _reset_state(monkeypatch):
    # Make sure each test starts fresh
    monkeypatch.delenv("ADHERENCE_SENTRY_DSN", raising=False)
    monkeypatch.delenv("ADHERENCE_SENTRY_ENVIRONMENT", raising=False)
    monkeypatch.delenv("ADHERENCE_SENTRY_TRACES_SAMPLE_RATE", raising=False)
    monkeypatch.delenv("ADHERENCE_SENTRY_PROFILES_SAMPLE_RATE", raising=False)
    sentry_mod.reset_for_tests()
    reload_settings()
    yield
    sentry_mod.reset_for_tests()
    reload_settings()


def test_init_sentry_noop_without_dsn():
    assert sentry_mod.init_sentry("test-service") is False
    assert sentry_mod.is_initialized() is False


def test_init_sentry_noop_with_blank_dsn(monkeypatch):
    monkeypatch.setenv("ADHERENCE_SENTRY_DSN", "   ")
    reload_settings()
    assert sentry_mod.init_sentry("test-service") is False
    assert sentry_mod.is_initialized() is False


def test_sample_rate_validation():
    import os
    os.environ["ADHERENCE_SENTRY_TRACES_SAMPLE_RATE"] = "1.5"
    try:
        with pytest.raises(ValidationError):
            reload_settings()
    finally:
        os.environ.pop("ADHERENCE_SENTRY_TRACES_SAMPLE_RATE", None)
        reload_settings()


def test_init_sentry_with_dsn_activates_sdk(monkeypatch):
    sentry_sdk = pytest.importorskip("sentry_sdk")
    monkeypatch.setenv(
        "ADHERENCE_SENTRY_DSN",
        "https://public@o0.ingest.sentry.io/0",
    )
    monkeypatch.setenv("ADHERENCE_SENTRY_TRACES_SAMPLE_RATE", "0.25")
    reload_settings()

    assert sentry_mod.init_sentry("adherence-api-test") is True
    assert sentry_mod.is_initialized() is True

    client = sentry_sdk.get_client()
    assert client is not None
    opts = client.options
    assert opts["traces_sample_rate"] == 0.25
    assert opts["send_default_pii"] is False
    # before_send hook must be wired so we can scrub headers
    assert callable(opts.get("before_send"))


def test_before_send_scrubs_auth_headers():
    event = {
        "request": {
            "headers": {
                "Authorization": "Bearer secret-token",
                "X-API-Key": "live-key",
                "Cookie": "session=abc",
                "User-Agent": "pytest",
            },
            "query_string": "api_key=oops&page=2",
        }
    }
    out = sentry_mod._scrub_sensitive(event, {})
    assert out is not None
    h = out["request"]["headers"]
    assert h["Authorization"] == "[Filtered]"
    assert h["X-API-Key"] == "[Filtered]"
    assert h["Cookie"] == "[Filtered]"
    assert h["User-Agent"] == "pytest"
    assert out["request"]["query_string"] == "[Filtered]"


def test_app_factory_does_not_crash_with_sentry_disabled():
    # Smoke: importing and constructing the FastAPI app must not blow up
    # when Sentry is disabled.
    from adherence_api.app import create_app
    app = create_app()
    assert app is not None
    routes = {r.path for r in app.routes}
    assert "/metrics" in routes
