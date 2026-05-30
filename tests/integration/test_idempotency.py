"""Tests for Idempotency-Key handling on /v1/predict."""
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
    from adherence_trainer.pipeline import run_training
    run_training(synthetic=True, users=80, days=10, seed=5,
                 register_as="default", use_mlflow=False, cv_splits=0)


_PAYLOAD = {
    "user_id": "u_idem",
    "schedule": [{
        "dose_id": "d1",
        "scheduled_at": "2026-06-01T08:00:00Z",
        "dose_class": "cardio",
        "dose_strength_mg": 10.0,
    }],
    "top_k_reasons": 2,
}


def test_idempotency_replay_returns_cached_body(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    h = {"x-api-key": "svc", "Idempotency-Key": "key-abc-123"}

    r1 = client.post("/v1/predict", headers=h, json=_PAYLOAD)
    assert r1.status_code == 200
    assert r1.headers.get("Idempotent-Replay") is None
    body1 = r1.json()

    r2 = client.post("/v1/predict", headers=h, json=_PAYLOAD)
    assert r2.status_code == 200
    assert r2.headers.get("Idempotent-Replay") == "true"
    assert r2.json() == body1

    # Audit log should have exactly ONE row for the user (replay skipped work)
    from sqlalchemy import select, func
    from adherence_common.db import PredictionAudit, session
    with session() as s:
        n = s.execute(
            select(func.count(PredictionAudit.id))
            .where(PredictionAudit.user_id == "u_idem")
        ).scalar_one()
    assert n == 1


def test_idempotency_conflict_on_payload_mismatch(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    h = {"x-api-key": "svc", "Idempotency-Key": "key-conflict"}

    r1 = client.post("/v1/predict", headers=h, json=_PAYLOAD)
    assert r1.status_code == 200

    mutated = {**_PAYLOAD, "user_id": "u_different"}
    r2 = client.post("/v1/predict", headers=h, json=mutated)
    assert r2.status_code == 409
    assert "different payload" in r2.json()["detail"]


def test_idempotency_no_key_works_normally(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    h = {"x-api-key": "svc"}

    r1 = client.post("/v1/predict", headers=h, json=_PAYLOAD)
    r2 = client.post("/v1/predict", headers=h, json=_PAYLOAD)
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.headers.get("Idempotent-Replay") is None
    assert r2.headers.get("Idempotent-Replay") is None


def test_idempotency_key_too_long_rejected(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    h = {"x-api-key": "svc", "Idempotency-Key": "k" * 200}
    r = client.post("/v1/predict", headers=h, json=_PAYLOAD)
    assert r.status_code == 400
