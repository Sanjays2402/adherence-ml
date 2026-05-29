"""End-to-end tests for /v1/explain/* and /v1/cohort/risk."""
from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/test.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    reload_settings()


def _train_tiny(name="default"):
    from adherence_worker import inference as inf
    inf.load_model.cache_clear()
    from adherence_trainer.pipeline import run_training
    return run_training(
        synthetic=True, users=120, days=14, seed=5,
        register_as=name, use_mlflow=False, cv_splits=0,
    )


def test_explain_global_endpoint(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train_tiny()
    from adherence_api.app import create_app
    client = TestClient(create_app())

    r = client.get("/v1/explain/global", params={"n_users": 80, "n_days": 7})
    assert r.status_code == 401

    r = client.get(
        "/v1/explain/global",
        params={"n_users": 80, "n_days": 7},
        headers={"x-api-key": "vwr"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["model_name"] == "default"
    assert body["sample_size"] > 0
    feats = body["features"]
    assert len(feats) >= 10
    # ranks 1..N, no dupes
    ranks = [f["rank"] for f in feats]
    assert sorted(ranks) == list(range(1, len(feats) + 1))
    # mean_abs_shap sorted descending
    shap_vals = [f["mean_abs_shap"] for f in feats]
    assert shap_vals == sorted(shap_vals, reverse=True)
    # human label populated
    assert all(isinstance(f["human"], str) and f["human"] for f in feats)


def test_explain_sample_endpoint(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train_tiny()
    from adherence_api.app import create_app
    client = TestClient(create_app())
    r = client.get(
        "/v1/explain/sample",
        params={"n": 4, "seed": 99},
        headers={"x-api-key": "vwr"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["rows"]) == 4
    for row in body["rows"]:
        assert 0.0 <= row["miss_probability"] <= 1.0
        assert set(row["feature_values"].keys()) == set(row["shap_values"].keys())
        assert len(row["feature_values"]) >= 10


def test_cohort_risk_synthetic(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train_tiny()
    from adherence_api.app import create_app
    client = TestClient(create_app())

    payload = {"synthetic": {"n_users": 80, "n_days": 10, "seed": 21}}
    r = client.post("/v1/cohort/risk", json=payload)
    assert r.status_code == 401

    r = client.post(
        "/v1/cohort/risk?top_users=5",
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_doses"] > 0
    assert 0.0 <= body["overall_mean_risk"] <= 1.0
    assert len(body["top_users"]) <= 5
    # by_dose_class buckets nonempty & sorted by risk desc
    assert len(body["by_dose_class"]) >= 1
    risks = [b["mean_miss_probability"] for b in body["by_dose_class"]]
    assert risks == sorted(risks, reverse=True)
    assert len(body["by_time_bucket"]) >= 1
    for b in body["by_dose_class"]:
        assert 0.0 <= b["pct_high_risk"] <= 1.0
        assert b["n_doses"] >= 1
