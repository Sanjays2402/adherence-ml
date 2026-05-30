"""Tests for CORS settings hardening and middleware wiring."""
from __future__ import annotations

import pytest
from adherence_common.settings import Settings
from fastapi.testclient import TestClient
from pydantic import ValidationError


def _ok_kwargs(**overrides):
    base = dict(jwt_secret="x" * 32, env="dev")
    base.update(overrides)
    return base


def test_cors_defaults_are_dev_permissive():
    s = Settings(**_ok_kwargs())
    assert s.api_cors_origins == ["*"]
    assert "GET" in s.api_cors_methods and "OPTIONS" in s.api_cors_methods
    assert "Authorization" in s.api_cors_headers
    assert s.api_cors_allow_credentials is False
    assert s.api_cors_max_age_seconds == 600


def test_cors_origins_csv_env_string_is_split():
    s = Settings(**_ok_kwargs(api_cors_origins="https://a.example.com, https://b.example.com"))
    assert s.api_cors_origins == ["https://a.example.com", "https://b.example.com"]


def test_wildcard_origin_with_credentials_is_rejected():
    with pytest.raises(ValidationError) as exc:
        Settings(**_ok_kwargs(api_cors_origins=["*"], api_cors_allow_credentials=True))
    assert "credentials" in str(exc.value).lower()


def test_prod_env_rejects_wildcard_origin():
    with pytest.raises(ValidationError) as exc:
        Settings(**_ok_kwargs(env="prod", api_cors_origins=["*"]))
    assert "prod" in str(exc.value).lower()


def test_prod_env_rejects_wildcard_methods_and_headers():
    with pytest.raises(ValidationError):
        Settings(
            **_ok_kwargs(
                env="prod",
                api_cors_origins=["https://app.example.com"],
                api_cors_methods=["*"],
            )
        )
    with pytest.raises(ValidationError):
        Settings(
            **_ok_kwargs(
                env="prod",
                api_cors_origins=["https://app.example.com"],
                api_cors_headers=["*"],
            )
        )


def test_prod_env_accepts_explicit_allowlist():
    s = Settings(
        **_ok_kwargs(
            env="prod",
            api_cors_origins=["https://app.example.com"],
            api_cors_allow_credentials=True,
        )
    )
    assert s.api_cors_origins == ["https://app.example.com"]
    assert s.api_cors_allow_credentials is True


def test_app_emits_explicit_cors_headers(monkeypatch):
    # Force a strict allowlist via env so the app factory builds with it.
    monkeypatch.setenv("ADHERENCE_ENV", "prod")
    monkeypatch.setenv("ADHERENCE_API_CORS_ORIGINS", "https://app.example.com")
    monkeypatch.setenv("ADHERENCE_API_CORS_ALLOW_CREDENTIALS", "true")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    from adherence_common.settings import reload_settings
    reload_settings()

    from adherence_api.app import create_app

    app = create_app()
    client = TestClient(app)

    # Allowed origin: echoed back, credentials advertised.
    r = client.options(
        "/livez",
        headers={
            "Origin": "https://app.example.com",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") == "https://app.example.com"
    assert r.headers.get("access-control-allow-credentials") == "true"
    assert "GET" in r.headers.get("access-control-allow-methods", "")

    # Disallowed origin: no allow-origin header echoed.
    r2 = client.options(
        "/livez",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert r2.headers.get("access-control-allow-origin") != "https://evil.example.com"

    # Reset for sibling tests that rely on the default singleton.
    for k in (
        "ADHERENCE_ENV",
        "ADHERENCE_API_CORS_ORIGINS",
        "ADHERENCE_API_CORS_ALLOW_CREDENTIALS",
        "ADHERENCE_JWT_SECRET",
    ):
        monkeypatch.delenv(k, raising=False)
    reload_settings()
