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


def test_admin_audit_since_until_window(tmp_path, monkeypatch):
    """``since`` / ``until`` scope the admin audit reader to an absolute
    window so SOC 2 evidence packs can be pulled for a fixed quarter."""
    _setup_env(tmp_path, monkeypatch)
    from datetime import datetime, timedelta

    from adherence_common.admin_audit import list_admin_actions, record_admin_action
    from adherence_common.db import AdminAuditLog, session
    from adherence_api.app import create_app

    # Seed three rows across a 30-day spread by backdating created_at.
    principal = {"sub": "adm", "role": "admin", "tenant": "acme"}
    for i in range(3):
        record_admin_action(
            action="token.mint",
            principal=principal,
            target=f"subj-{i}",
            ok=True,
            details={"i": i},
            request_id=f"req-{i}",
            tenant_id="acme",
        )
    now = datetime.utcnow().replace(microsecond=0)
    backdates = [now - timedelta(days=20), now - timedelta(days=10), now]
    with session() as s:
        rows = (
            s.query(AdminAuditLog)
            .filter(AdminAuditLog.tenant_id == "acme")
            .order_by(AdminAuditLog.id.asc())
            .all()
        )
        for row, dt in zip(rows[-3:], backdates):
            row.created_at = dt
        s.commit()

    client = TestClient(create_app())

    # Wide-open window picks up all three.
    r_all = client.get(
        "/v1/admin/audit/admin?action=token.mint&tenant=acme&limit=50",
        headers={"x-api-key": "adm"},
    )
    assert r_all.status_code == 200, r_all.text
    assert len(r_all.json()) == 3

    # since cuts off the oldest row.
    since = (now - timedelta(days=15)).isoformat() + "Z"
    r_since = client.get(
        f"/v1/admin/audit/admin?action=token.mint&tenant=acme&since={since}",
        headers={"x-api-key": "adm"},
    )
    assert r_since.status_code == 200, r_since.text
    assert len(r_since.json()) == 2

    # since + until brackets just the middle row.
    until = (now - timedelta(days=1)).isoformat() + "Z"
    r_bracket = client.get(
        f"/v1/admin/audit/admin?action=token.mint&tenant=acme&since={since}&until={until}",
        headers={"x-api-key": "adm"},
    )
    assert r_bracket.status_code == 200, r_bracket.text
    bracket = r_bracket.json()
    assert len(bracket) == 1
    assert bracket[0]["target"] == "subj-1"

    # Helper accepts plain date strings (no time component).
    r_date = client.get(
        "/v1/admin/audit/admin?action=token.mint&tenant=acme"
        f"&since={(now - timedelta(days=25)).date().isoformat()}",
        headers={"x-api-key": "adm"},
    )
    assert r_date.status_code == 200, r_date.text
    assert len(r_date.json()) == 3


def test_admin_audit_since_until_rejects_bad_input(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    r_bad = client.get(
        "/v1/admin/audit/admin?since=not-a-date",
        headers={"x-api-key": "adm"},
    )
    assert r_bad.status_code == 400
    assert "since" in r_bad.json()["detail"]

    r_inv = client.get(
        "/v1/admin/audit/admin?since=2026-02-01&until=2026-01-01",
        headers={"x-api-key": "adm"},
    )
    assert r_inv.status_code == 400
    assert "until must be after since" in r_inv.json()["detail"]


def test_list_admin_actions_since_until_kwargs(tmp_path, monkeypatch):
    """The common helper accepts since/until kwargs directly."""
    _setup_env(tmp_path, monkeypatch)
    from datetime import datetime, timedelta

    from adherence_common.admin_audit import list_admin_actions, record_admin_action
    from adherence_common.db import AdminAuditLog, session

    principal = {"sub": "adm", "role": "admin", "tenant": "acme"}
    record_admin_action(
        action="api_key.create",
        principal=principal,
        target="k1",
        ok=True,
        request_id="req-a",
        tenant_id="acme",
    )
    record_admin_action(
        action="api_key.create",
        principal=principal,
        target="k2",
        ok=True,
        request_id="req-b",
        tenant_id="acme",
    )
    now = datetime.utcnow().replace(microsecond=0)
    with session() as s:
        rows = (
            s.query(AdminAuditLog)
            .filter(AdminAuditLog.tenant_id == "acme")
            .order_by(AdminAuditLog.id.asc())
            .all()
        )
        rows[-2].created_at = now - timedelta(days=5)
        rows[-1].created_at = now
        s.commit()

    out = list_admin_actions(
        tenant_id="acme",
        action="api_key.create",
        since=now - timedelta(days=1),
    )
    assert [r["target"] for r in out] == ["k2"]
