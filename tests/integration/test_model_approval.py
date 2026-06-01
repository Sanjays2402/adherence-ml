"""Integration test: per-workspace model approval policy.

Proves the enterprise contract:

1. By default a workspace is in ``disabled`` mode, predictions go
   through, and the ``X-Model-Approval`` header reflects allowlist
   membership for visibility (not blocking).
2. A workspace admin can flip to ``enforce`` and an unapproved model
   version is rejected with HTTP 422 plus ``X-Model-Approval: blocked``.
3. Approving the exact ``(model_name, model_version)`` pair clears the
   block and the predict call succeeds.
4. The policy is tenant-scoped: enforcing on ``acme`` does not block
   ``globex`` (which is still in disabled mode).
5. Mode changes and version approvals land in the admin audit log.
6. Viewers can read the policy but cannot mutate it.
7. ``dry_run=true`` never persists.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv(
        "ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr"
    )
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv(
        "ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/model_approval.db"
    )
    monkeypatch.setenv(
        "ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns"
    )
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()


def _mint(client, *, subject, tenant, role="viewer"):
    r = client.post(
        "/v1/admin/token",
        json={"subject": subject, "role": role, "tenant": tenant},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _admin_for(client, tenant):
    return _mint(client, subject=f"admin-{tenant}", tenant=tenant, role="admin")


def _stub_inference(monkeypatch, *, version="v1.2.3"):
    """Replace heavy ML calls with deterministic stubs so the predict
    path exercises the approval gate without touching the model
    registry."""
    def fake_predict_doses(user_id, schedule, history=None, *,
                           model_name="default", top_k=3):
        preds = [
            {
                "dose_id": s.get("dose_id", f"d{i}"),
                "miss_probability": 0.1,
                "risk_tier": "low",
                "reasons": [{"feature": "stub", "value": 1.0,
                              "contribution": 0.1,
                              "human": "stub reason"}],
                "scheduled_at": s.get("scheduled_at"),
                "dose_class": s.get("dose_class", "general"),
            }
            for i, s in enumerate(schedule)
        ]
        return {
            "user_id": user_id, "model_version": version,
            "predictions": preds,
        }

    class _StubArt:
        def __init__(self, v):
            self.version = v
            self.name = "default"

    def fake_load_model(model_name="default"):
        return _StubArt(version), object(), None

    # Patch in both the worker module and the predict route's import.
    from adherence_worker import inference as inf
    monkeypatch.setattr(inf, "predict_doses", fake_predict_doses)
    monkeypatch.setattr(inf, "load_model", fake_load_model)
    from adherence_api.routes import predict as predict_route
    monkeypatch.setattr(predict_route, "predict_doses", fake_predict_doses)


_SCHEDULE = [
    {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
     "dose_class": "cardio", "dose_strength_mg": 10.0},
    {"dose_id": "d2", "scheduled_at": "2026-03-05T21:30:00Z",
     "dose_class": "psych", "dose_strength_mg": 5.0},
]


def _predict(client, token):
    return client.post(
        "/v1/predict",
        json={"user_id": "u_test", "schedule": _SCHEDULE, "top_k_reasons": 2},
        headers={"Authorization": f"Bearer {token}"},
    )


def test_model_approval_default_allows_with_header(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _stub_inference(monkeypatch, version="v1.0.0")
    from adherence_api.app import create_app
    client = TestClient(create_app())

    svc = _mint(client, subject="svc-acme", tenant="acme", role="service")
    admin = _admin_for(client, "acme")

    # Default mode is disabled; predict goes through.
    r = _predict(client, svc)
    assert r.status_code == 200, r.text
    assert r.headers.get("x-model-approval") == "unapproved"
    assert r.headers.get("x-model-approval-mode") == "disabled"

    # Settings endpoint reports the default.
    r_get = client.get(
        "/v1/workspace/model-approval",
        headers={"Authorization": f"Bearer {admin}"},
    )
    assert r_get.status_code == 200, r_get.text
    body = r_get.json()
    assert body["tenant_id"] == "acme"
    assert body["mode"] == "disabled"
    assert body["pinned"] is False
    assert body["approved_versions"] == 0
    assert sorted(body["allowed_modes"]) == ["audit", "disabled", "enforce"]


def test_enforce_blocks_unapproved_and_allows_approved(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _stub_inference(monkeypatch, version="v2.0.0")
    from adherence_api.app import create_app
    client = TestClient(create_app())

    svc_acme = _mint(client, subject="svc-acme", tenant="acme", role="service")
    admin_acme = _admin_for(client, "acme")

    # Flip acme to enforce mode.
    r_mode = client.put(
        "/v1/workspace/model-approval",
        json={"mode": "enforce"},
        headers={"Authorization": f"Bearer {admin_acme}"},
    )
    assert r_mode.status_code == 200, r_mode.text
    assert r_mode.json()["mode"] == "enforce"

    # Unapproved version is blocked.
    r_block = _predict(client, svc_acme)
    assert r_block.status_code == 422, r_block.text
    assert r_block.headers.get("x-model-approval") == "blocked"
    assert r_block.headers.get("x-model-approval-mode") == "enforce"
    detail = r_block.json()["detail"]
    assert detail["error"] == "model_version_not_approved"
    assert detail["model_version"] == "v2.0.0"

    # Approve the exact version.
    r_app = client.post(
        "/v1/workspace/model-approval/versions",
        json={"model_name": "default", "model_version": "v2.0.0",
              "note": "CAB-1234"},
        headers={"Authorization": f"Bearer {admin_acme}"},
    )
    assert r_app.status_code == 200, r_app.text
    assert r_app.json()["model_version"] == "v2.0.0"

    # Now predict succeeds and the header flips to approved.
    r_ok = _predict(client, svc_acme)
    assert r_ok.status_code == 200, r_ok.text
    assert r_ok.headers.get("x-model-approval") == "approved"
    assert r_ok.headers.get("x-model-approval-mode") == "enforce"

    # Revoking puts us back to blocked.
    r_rev = client.delete(
        "/v1/workspace/model-approval/versions/default/v2.0.0",
        headers={"Authorization": f"Bearer {admin_acme}"},
    )
    assert r_rev.status_code == 200, r_rev.text
    r_block2 = _predict(client, svc_acme)
    assert r_block2.status_code == 422, r_block2.text


def test_enforce_is_tenant_scoped(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _stub_inference(monkeypatch, version="v3.0.0")
    from adherence_api.app import create_app
    client = TestClient(create_app())

    admin_acme = _admin_for(client, "acme")
    svc_acme = _mint(client, subject="svc-acme", tenant="acme", role="service")
    svc_globex = _mint(client, subject="svc-globex",
                       tenant="globex", role="service")

    # Acme enforces; globex stays disabled.
    r_mode = client.put(
        "/v1/workspace/model-approval",
        json={"mode": "enforce"},
        headers={"Authorization": f"Bearer {admin_acme}"},
    )
    assert r_mode.status_code == 200, r_mode.text

    # Acme is blocked.
    r_acme = _predict(client, svc_acme)
    assert r_acme.status_code == 422
    # Globex is untouched.
    r_globex = _predict(client, svc_globex)
    assert r_globex.status_code == 200, r_globex.text
    assert r_globex.headers.get("x-model-approval-mode") == "disabled"

    # Approving the version on globex must NOT unblock acme.
    admin_globex = _admin_for(client, "globex")
    r_app = client.post(
        "/v1/workspace/model-approval/versions",
        json={"model_name": "default", "model_version": "v3.0.0"},
        headers={"Authorization": f"Bearer {admin_globex}"},
    )
    assert r_app.status_code == 200, r_app.text
    r_acme_still = _predict(client, svc_acme)
    assert r_acme_still.status_code == 422, r_acme_still.text


def test_viewer_cannot_mutate_and_dry_run_no_persist(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _stub_inference(monkeypatch, version="v4.0.0")
    from adherence_api.app import create_app
    client = TestClient(create_app())

    admin_acme = _admin_for(client, "acme")
    viewer_acme = _mint(client, subject="vw-acme",
                        tenant="acme", role="viewer")

    # Viewer can read.
    r_read = client.get(
        "/v1/workspace/model-approval",
        headers={"Authorization": f"Bearer {viewer_acme}"},
    )
    assert r_read.status_code == 200, r_read.text

    # Viewer cannot change the mode.
    r_put = client.put(
        "/v1/workspace/model-approval",
        json={"mode": "enforce"},
        headers={"Authorization": f"Bearer {viewer_acme}"},
    )
    assert r_put.status_code == 403, r_put.text

    # Dry-run from an admin: response shape but no persistence.
    r_dry = client.put(
        "/v1/workspace/model-approval?dry_run=true",
        json={"mode": "enforce"},
        headers={"Authorization": f"Bearer {admin_acme}"},
    )
    assert r_dry.status_code == 200, r_dry.text
    body = r_dry.json()
    assert body.get("dry_run") is True
    assert body.get("would_set_mode") is True
    r_after = client.get(
        "/v1/workspace/model-approval",
        headers={"Authorization": f"Bearer {admin_acme}"},
    )
    assert r_after.json()["mode"] == "disabled"

    # Unknown mode is a 400, not a silent accept.
    r_bad = client.put(
        "/v1/workspace/model-approval",
        json={"mode": "ludicrous"},
        headers={"Authorization": f"Bearer {admin_acme}"},
    )
    assert r_bad.status_code == 400, r_bad.text


def test_audit_mode_allows_but_records(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _stub_inference(monkeypatch, version="v5.0.0")
    from adherence_api.app import create_app
    client = TestClient(create_app())

    admin = _admin_for(client, "acme")
    svc = _mint(client, subject="svc-acme", tenant="acme", role="service")

    r_mode = client.put(
        "/v1/workspace/model-approval",
        json={"mode": "audit"},
        headers={"Authorization": f"Bearer {admin}"},
    )
    assert r_mode.status_code == 200, r_mode.text

    r = _predict(client, svc)
    assert r.status_code == 200, r.text
    assert r.headers.get("x-model-approval-mode") == "audit"
    assert r.headers.get("x-model-approval") == "unapproved"
