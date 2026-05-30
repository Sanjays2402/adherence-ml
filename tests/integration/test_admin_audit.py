"""Integration tests for the admin-plane audit log.

Exercises ``admin_audit_log`` rows written by mint_token, api-key
create/revoke, retention sweep, and gdpr erase, plus the
``GET /v1/admin/audit/admin`` reader and the secret-redaction helper.
"""
from __future__ import annotations

from adherence_common.settings import reload_settings
from fastapi.testclient import TestClient


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/admin_audit.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()


def test_mint_token_records_admin_audit(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    r = client.post(
        "/v1/admin/token",
        json={"subject": "ops-bot", "role": "service", "tenant": "acme"},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text

    r2 = client.get(
        "/v1/admin/audit/admin?action=token.mint&limit=5",
        headers={"x-api-key": "adm"},
    )
    assert r2.status_code == 200, r2.text
    rows = r2.json()
    assert len(rows) >= 1
    row = rows[0]
    assert row["action"] == "token.mint"
    assert row["target"] == "ops-bot"
    assert row["caller_role"] == "admin"
    assert row["ok"] is True
    assert row["details"]["role"] == "service"
    assert row["details"]["tenant"] == "acme"


def test_api_key_create_and_revoke_audited(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    r = client.post(
        "/v1/admin/api-keys",
        json={"name": "ci-bot", "role": "service", "scopes": ["gdpr:read"]},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 201, r.text
    plain_key = r.json()["key"]
    assert plain_key  # raw key returned to caller but never persisted

    r2 = client.post(
        "/v1/admin/api-keys/ci-bot/revoke",
        headers={"x-api-key": "adm"},
    )
    assert r2.status_code == 200

    r3 = client.get(
        "/v1/admin/audit/admin?limit=20",
        headers={"x-api-key": "adm"},
    )
    assert r3.status_code == 200
    actions = [r["action"] for r in r3.json()]
    assert "api_key.create" in actions
    assert "api_key.revoke" in actions

    create_row = next(r for r in r3.json() if r["action"] == "api_key.create")
    assert create_row["target"] == "ci-bot"
    assert create_row["details"]["role"] == "service"
    assert "gdpr:read" in create_row["details"]["scopes"]
    # The raw key value must never be persisted to the audit row.
    serialized = str(create_row["details"])
    assert plain_key not in serialized


def test_revoke_missing_key_records_failure(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    r = client.post(
        "/v1/admin/api-keys/does-not-exist/revoke",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 404

    r2 = client.get(
        "/v1/admin/audit/admin?action=api_key.revoke&limit=5",
        headers={"x-api-key": "adm"},
    )
    rows = r2.json()
    assert len(rows) == 1
    assert rows[0]["ok"] is False
    assert rows[0]["error"] == "api key not found"
    assert rows[0]["target"] == "does-not-exist"


def test_retention_sweep_audited(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    r = client.post(
        "/v1/admin/audit/retention",
        json={"dry_run": True},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text

    r2 = client.get(
        "/v1/admin/audit/admin?action=retention.sweep",
        headers={"x-api-key": "adm"},
    )
    rows = r2.json()
    assert len(rows) >= 1
    assert rows[0]["details"]["dry_run"] is True
    assert isinstance(rows[0]["details"]["results"], list)


def test_viewer_cannot_read_admin_audit(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    r = client.get("/v1/admin/audit/admin", headers={"x-api-key": "vwr"})
    assert r.status_code == 403


def test_redact_details_scrubs_secrets():
    from adherence_common.admin_audit import redact_details

    payload = {
        "name": "ci-bot",
        "api_key": "ak_supersecret",
        "headers": {"Authorization": "Bearer abc", "X-Request-ID": "rid-1"},
        "nested": [{"token": "tok"}, {"role": "admin"}],
        "jwt_secret": "should-go",
    }
    out = redact_details(payload)
    assert out["name"] == "ci-bot"
    assert out["api_key"] == "***"
    assert out["headers"]["Authorization"] == "***"
    assert out["headers"]["X-Request-ID"] == "rid-1"
    assert out["nested"][0]["token"] == "***"
    assert out["nested"][1]["role"] == "admin"
    assert out["jwt_secret"] == "***"
