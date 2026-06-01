"""Audit-coverage tests for mutating admin/service routes.

Each test confirms an ``admin_audit_log`` row is written when the
corresponding mutation runs, including the failure path where applicable.
These cover routes that historically were not instrumented: mutes,
risk policies, experiments, and train.
"""
from __future__ import annotations

from adherence_common.settings import reload_settings
from fastapi.testclient import TestClient


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/audit_coverage.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()


def _audit(client, action):
    r = client.get(
        f"/v1/admin/audit/admin?action={action}&limit=10",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_mute_set_and_clear_audited(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    r = client.put(
        "/v1/users/u-1/mute",
        json={"duration_minutes": 30, "reason": "outage"},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text

    rows = _audit(client, "user.mute.set")
    assert any(r["target"] == "u-1" and r["ok"] for r in rows)
    set_row = next(r for r in rows if r["target"] == "u-1")
    assert set_row["details"]["duration_minutes"] == 30
    assert set_row["details"]["reason"] == "outage"
    assert "muted_until" in set_row["details"]

    r2 = client.delete("/v1/users/u-1/mute", headers={"x-api-key": "svc"})
    assert r2.status_code == 200

    clear_rows = _audit(client, "user.mute.clear")
    assert any(r["target"] == "u-1" and r["ok"] for r in clear_rows)

    # Clearing for a user that never had a mute is a failure path.
    r3 = client.delete("/v1/users/u-never-muted/mute", headers={"x-api-key": "svc"})
    assert r3.status_code == 404
    clear_rows2 = _audit(client, "user.mute.clear")
    assert any(r["target"] == "u-never-muted" and not r["ok"] for r in clear_rows2)


def test_risk_policy_upsert_and_delete_audited(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    body = {
        "scope_type": "user",
        "scope_id": "u-42",
        "low_max": 0.2,
        "medium_max": 0.6,
        "note": "vip",
    }
    r = client.put("/v1/policies/risk", json=body, headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text

    rows = _audit(client, "risk_policy.upsert")
    assert any(r["target"] == "user:u-42" and r["ok"] for r in rows)
    row = next(r for r in rows if r["target"] == "user:u-42")
    assert row["details"]["low_max"] == 0.2
    assert row["details"]["note"] == "vip"

    r2 = client.delete(
        "/v1/policies/risk?scope_type=user&scope_id=u-42",
        headers={"x-api-key": "adm"},
    )
    assert r2.status_code == 200
    del_rows = _audit(client, "risk_policy.delete")
    assert any(r["target"] == "user:u-42" and r["ok"] for r in del_rows)


def test_experiment_create_and_state_change_audited(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    body = {
        "key": "nudge-copy-v1",
        "description": "test copy variants",
        "variants": [
            {"name": "control", "weight": 1},
            {"name": "treatment", "weight": 1},
        ],
        "state": "running",
    }
    r = client.post("/v1/experiments", json=body, headers={"x-api-key": "adm"})
    assert r.status_code == 201, r.text

    rows = _audit(client, "experiment.create")
    assert any(r["target"] == "nudge-copy-v1" and r["ok"] for r in rows)
    row = next(r for r in rows if r["target"] == "nudge-copy-v1")
    assert row["details"]["state"] == "running"
    assert len(row["details"]["variants"]) == 2

    r2 = client.patch(
        "/v1/experiments/nudge-copy-v1/state",
        json={"state": "paused"},
        headers={"x-api-key": "adm"},
    )
    assert r2.status_code == 200, r2.text
    state_rows = _audit(client, "experiment.state.set")
    assert any(
        r["target"] == "nudge-copy-v1"
        and r["details"]["from"] == "running"
        and r["details"]["to"] == "paused"
        for r in state_rows
    )


def test_viewer_cannot_trigger_audited_mutations(tmp_path, monkeypatch):
    """Defense-in-depth: viewer role must be rejected before audit fires.

    Confirms no audit row leaks for an unauthorized caller.
    """
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    r = client.put(
        "/v1/policies/risk",
        json={
            "scope_type": "user",
            "scope_id": "viewer-attempt",
            "low_max": 0.1,
            "medium_max": 0.5,
        },
        headers={"x-api-key": "vwr"},
    )
    assert r.status_code == 403

    rows = _audit(client, "risk_policy.upsert")
    assert all(r["target"] != "user:viewer-attempt" for r in rows)
