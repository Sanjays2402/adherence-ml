"""Tests for per-user / per-dose-class risk tier policies."""
from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/test.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    reload_settings()
    from adherence_worker import inference as inf
    inf.load_model.cache_clear()
    from adherence_common import risk_policy as rp
    rp.clear_cache()
    from adherence_trainer.pipeline import run_training
    run_training(synthetic=True, users=80, days=10, seed=8,
                 register_as="default", use_mlflow=False, cv_splits=0)


def test_resolve_default_thresholds(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_common.risk_policy import resolve, GLOBAL
    t = resolve("u_none", "cardio")
    assert t == GLOBAL
    assert t.tier(0.05) == "low"
    assert t.tier(0.40) == "medium"
    assert t.tier(0.80) == "high"


def test_user_policy_overrides_class_and_default(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_common.risk_policy import upsert, resolve, clear_cache
    upsert(scope_type="dose_class", scope_id="cardio",
           low_max=0.20, medium_max=0.50, updated_by="t")
    upsert(scope_type="user", scope_id="u_strict",
           low_max=0.10, medium_max=0.25, updated_by="t")
    clear_cache()
    t_user = resolve("u_strict", "cardio")
    assert (t_user.low_max, t_user.medium_max) == (0.10, 0.25)
    t_class = resolve("u_other", "cardio")
    assert (t_class.low_max, t_class.medium_max) == (0.20, 0.50)


def test_predict_applies_user_policy(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    from adherence_common.risk_policy import upsert, clear_cache
    # Aggressive cutoffs: anything > 0.05 is high. We expect at least one
    # high-risk classification with this policy.
    upsert(scope_type="user", scope_id="u_policy",
           low_max=0.03, medium_max=0.05, updated_by="t")
    clear_cache()
    client = TestClient(create_app())
    payload = {
        "user_id": "u_policy",
        "schedule": [{
            "dose_id": "d1",
            "scheduled_at": "2026-06-01T08:00:00Z",
            "dose_class": "cardio",
            "dose_strength_mg": 10.0,
        }],
        "top_k_reasons": 0,
    }
    r = client.post("/v1/predict", headers={"x-api-key": "svc"}, json=payload)
    assert r.status_code == 200
    tier = r.json()["predictions"][0]["risk_tier"]
    # Default global thresholds (med=0.30, high=0.60) would almost certainly
    # call this "low" for synthetic data. The user policy should escalate it.
    assert tier in ("medium", "high")


def test_policy_admin_routes_crud(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    h_admin = {"x-api-key": "adm"}
    h_svc = {"x-api-key": "svc"}

    # service role cannot manage policies
    r = client.get("/v1/policies/risk", headers=h_svc)
    assert r.status_code == 403

    # create
    body = {"scope_type": "user", "scope_id": "u_clin",
            "low_max": 0.15, "medium_max": 0.35, "note": "transplant"}
    r = client.put("/v1/policies/risk", headers=h_admin, json=body)
    assert r.status_code == 200, r.text
    assert r.json()["low_max"] == 0.15

    # list contains it
    r = client.get("/v1/policies/risk", headers=h_admin)
    assert any(p["scope_id"] == "u_clin" for p in r.json())

    # bad bounds rejected
    bad = {**body, "low_max": 0.5, "medium_max": 0.4}
    r = client.put("/v1/policies/risk", headers=h_admin, json=bad)
    assert r.status_code == 400

    # delete
    r = client.delete(
        "/v1/policies/risk?scope_type=user&scope_id=u_clin", headers=h_admin)
    assert r.status_code == 200 and r.json()["deleted"] is True

    # 404 on second delete
    r = client.delete(
        "/v1/policies/risk?scope_type=user&scope_id=u_clin", headers=h_admin)
    assert r.status_code == 404
