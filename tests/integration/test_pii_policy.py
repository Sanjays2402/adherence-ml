"""Integration test: per-workspace PII redaction policy.

Proves the enterprise guarantee that a workspace admin can configure
which built-in and custom PII patterns are scrubbed from narrative
fields the platform persists for their tenant. Specifically:

1. After ``PUT /v1/workspace/pii-policy`` enables built-ins and a
   custom regex, ``admin_audit_log.details`` rows for that tenant have
   matches masked end-to-end through ``record_admin_action``.
2. The policy is strictly tenant-scoped: enabling scrubbing for
   ``acme`` does not affect ``globex``.
3. The medtracker inbound webhook scrubs ``DoseOutcome.notes`` per the
   source's mapped tenant policy.
4. Mutations are themselves logged so SOC2 reviewers can see who
   changed the redaction policy and when.
5. Viewer role can read but cannot mutate; invalid regex returns 422.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup_env(tmp_path, monkeypatch, *, source_tenants: str = ""):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/pii.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    if source_tenants:
        monkeypatch.setenv("ADHERENCE_INBOUND_SOURCE_TENANTS", source_tenants)
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()


def _mint(client, *, subject, tenant, role="admin"):
    r = client.post(
        "/v1/admin/token",
        json={"subject": subject, "role": role, "tenant": tenant},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _latest_audit_details(action, tenant):
    from adherence_common.db import AdminAuditLog, session
    from sqlalchemy import select
    with session() as s:
        row = s.execute(
            select(AdminAuditLog)
            .where(AdminAuditLog.action == action)
            .where(AdminAuditLog.tenant_id == tenant)
            .order_by(AdminAuditLog.id.desc())
        ).scalars().first()
        assert row is not None, f"no audit row for {action} in {tenant}"
        return dict(row.details or {})


def test_pii_policy_scrubs_admin_audit_details(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    acme_admin = _mint(client, subject="alice", tenant="acme")
    _ = _mint(client, subject="bob", tenant="globex")

    r0 = client.get(
        "/v1/workspace/pii-policy",
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r0.status_code == 200, r0.text
    body = r0.json()
    assert body["tenant_id"] == "acme"
    assert body["enabled_builtins"] == []
    assert "email" in body["supported_builtins"]

    r_set = client.put(
        "/v1/workspace/pii-policy",
        json={
            "enabled_builtins": ["email", "ssn"],
            "custom_patterns": [r"PT\d{6}"],
            "mask": "[X]",
        },
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_set.status_code == 200, r_set.text
    out = r_set.json()
    assert out["enabled_builtins"] == ["email", "ssn"]
    assert out["custom_patterns"] == [r"PT\d{6}"]
    assert out["mask"] == "[X]"

    from adherence_common.admin_audit import record_admin_action
    record_admin_action(
        action="test.pii.scrub",
        principal={"sub": "alice", "role": "admin", "tenant": "acme"},
        target="acme",
        details={
            "note": "patient PT123456 emailed alice@example.com ssn 111-22-3333",
        },
    )
    row_acme = _latest_audit_details("test.pii.scrub", "acme")
    note = row_acme["note"]
    assert "alice@example.com" not in note, note
    assert "111-22-3333" not in note, note
    assert "PT123456" not in note, note
    assert "[X]" in note, note

    record_admin_action(
        action="test.pii.scrub",
        principal={"sub": "bob", "role": "admin", "tenant": "globex"},
        target="globex",
        details={"note": "patient PT123456 emailed bob@example.com"},
    )
    row_globex = _latest_audit_details("test.pii.scrub", "globex")
    assert row_globex["note"] == "patient PT123456 emailed bob@example.com"

    from adherence_common.db import AdminAuditLog, session
    from sqlalchemy import select
    with session() as s:
        rows = s.execute(
            select(AdminAuditLog).where(
                AdminAuditLog.action == "workspace.pii_policy.set"
            )
        ).scalars().all()
        assert any(r.tenant_id == "acme" for r in rows)


def test_pii_policy_validates_custom_regex(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    tok = _mint(client, subject="alice", tenant="acme")
    r = client.put(
        "/v1/workspace/pii-policy",
        json={
            "enabled_builtins": [],
            "custom_patterns": ["[unterminated"],
            "mask": "[REDACTED]",
        },
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert r.status_code == 422, r.text
    assert "pattern" in r.text.lower()


def test_pii_policy_requires_admin_for_mutation(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    r_get = client.get(
        "/v1/workspace/pii-policy",
        headers={"x-api-key": "vwr"},
    )
    assert r_get.status_code == 200, r_get.text

    r_put = client.put(
        "/v1/workspace/pii-policy",
        json={"enabled_builtins": ["email"], "custom_patterns": [], "mask": "[X]"},
        headers={"x-api-key": "vwr"},
    )
    assert r_put.status_code in (401, 403), r_put.text


def test_pii_policy_scrubs_inbound_webhook_notes(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch, source_tenants="medtracker:acme")
    from adherence_api.app import create_app
    client = TestClient(create_app())

    acme_admin = _mint(client, subject="alice", tenant="acme")
    r_set = client.put(
        "/v1/workspace/pii-policy",
        json={
            "enabled_builtins": ["email", "ssn"],
            "custom_patterns": [],
            "mask": "[X]",
        },
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_set.status_code == 200, r_set.text

    payload = {
        "source": "medtracker",
        "events": [
            {
                "event_id": "evt-1",
                "user_id": "u1",
                "dose_id": "d1",
                "scheduled_at": "2025-01-01T08:00:00Z",
                "observed_at": "2025-01-01T08:15:00Z",
                "outcome": "taken",
                "notes": "patient emailed alice@example.com, ssn 111-22-3333",
            }
        ],
    }
    r = client.post(
        "/v1/webhooks/medtracker/event",
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["accepted"] == 1

    from adherence_common.db import DoseOutcome, session
    from sqlalchemy import select
    with session() as s:
        row = s.execute(
            select(DoseOutcome).where(DoseOutcome.external_event_id == "evt-1")
        ).scalar_one()
        assert "alice@example.com" not in (row.notes or ""), row.notes
        assert "111-22-3333" not in (row.notes or ""), row.notes
        assert "[X]" in (row.notes or "")
