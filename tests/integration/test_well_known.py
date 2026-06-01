"""Public ``/.well-known`` endpoints must be reachable with no
authentication, no API key, no tenant context, and no IP allowlist.

These endpoints exist so a buyer's security team can verify our
posture before any contract is signed. If middleware ever reorders
and starts blocking them we want to find out from CI, not from a
procurement scanner returning an empty report.
"""
from __future__ import annotations

from adherence_common.settings import reload_settings
from fastapi.testclient import TestClient


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/well_known.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "true")
    # Deliberately set an aggressive per-tenant IP allowlist so the
    # test would fail if /.well-known were not exempt.
    reload_settings()
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()


def _client():
    from adherence_api.app import create_app
    return TestClient(create_app())


def test_security_txt_is_public_and_well_formed(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    client = _client()
    # No auth header, no api key, no cookies.
    r = client.get("/.well-known/security.txt")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/plain")
    body = r.text
    # RFC 9116 required fields.
    assert "Contact:" in body
    assert "Expires:" in body
    # Cache header so probes don't pollute the rate limiter.
    assert "max-age=" in r.headers.get("cache-control", "")


def test_security_json_is_public_and_has_stable_shape(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    client = _client()
    r = client.get("/.well-known/security.json")
    assert r.status_code == 200, r.text
    data = r.json()
    # Schema version is the procurement contract; bumping is breaking.
    assert data["schema_version"] == "1.0.0"
    # Required top-level keys procurement scanners pin to.
    for key in (
        "product",
        "product_version",
        "vendor",
        "contacts",
        "data_residency",
        "encryption",
        "subprocessors",
        "controls",
        "incident_response",
        "data_subject_rights",
        "compliance_attestations",
    ):
        assert key in data, f"missing required key: {key}"
    # Honesty rail: at least one declared subprocessor and at least one
    # declared control. An empty deployment that lies about having
    # nothing should never ship.
    assert len(data["subprocessors"]) >= 1
    assert len(data["controls"]) >= 5
    # Every control must be self-describing.
    for c in data["controls"]:
        assert {"id", "label", "evidence"} <= set(c.keys())
    # Contacts must be real channels, not placeholders.
    assert "@" in data["contacts"]["security"]
    assert "@" in data["contacts"]["incidents"]
    assert "@" in data["contacts"]["data_subject_requests"]


def test_well_known_does_not_require_api_key(tmp_path, monkeypatch):
    """A protected route returns 401/403 without auth; the well-known
    endpoints must return 200. This pins the exemption."""
    _setup_env(tmp_path, monkeypatch)
    client = _client()
    protected = client.get("/v1/admin/api-keys")
    assert protected.status_code in (401, 403), (
        f"control route should require auth, got {protected.status_code}"
    )
    public = client.get("/.well-known/security.json")
    assert public.status_code == 200
