"""Smoke tests for the OpenAPI export script and the Python client."""
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def test_export_openapi_produces_valid_json(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/test.db")
    monkeypatch.setenv("ADHERENCE_LOG_LEVEL", "WARNING")

    script = REPO / "scripts" / "export_openapi.py"
    out = subprocess.run(
        [sys.executable, str(script)],
        check=True, capture_output=True, cwd=REPO,
    )
    spec = json.loads(out.stdout.decode())
    assert spec["info"]["title"] == "adherence-ml"
    paths = set(spec["paths"].keys())
    for required in {
        "/healthz",
        "/v1/predict",
        "/v1/train",
        "/v1/explain/global",
        "/v1/cohort/risk",
    }:
        assert required in paths, f"missing {required} in OpenAPI spec"


def test_python_client_against_test_app(tmp_path, monkeypatch):
    """The shipped Python client should work against a TestClient transport."""
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/test.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")

    from adherence_common.settings import reload_settings
    reload_settings()

    # Train a tiny model so /predict actually serves
    from adherence_worker import inference as inf
    inf.load_model.cache_clear()
    from adherence_trainer.pipeline import run_training
    run_training(synthetic=True, users=80, days=10, seed=3,
                 register_as="default", use_mlflow=False, cv_splits=0)

    from adherence_api.app import create_app
    from fastapi.testclient import TestClient

    app = create_app()
    tc = TestClient(app)

    # Import the shipped client and stub its transport with TestClient
    sys.path.insert(0, str(REPO / "clients" / "python"))
    from adherence_client import AdherenceClient  # type: ignore

    client = AdherenceClient(base_url="http://testserver", api_key="svc")

    def _req(method, path, **kw):
        r = tc.request(method, path, headers={"x-api-key": "svc"}, **kw)
        r.raise_for_status()
        return r.json()
    client._req = _req  # type: ignore[assignment]

    body = client.predict(
        user_id="u_42",
        schedule=[
            {"dose_id": "d1", "scheduled_at": "2026-06-01T08:00:00Z",
             "dose_class": "cardio", "dose_strength_mg": 10.0},
        ],
    )
    assert body["user_id"] == "u_42"
    assert len(body["predictions"]) == 1
    assert 0.0 <= body["predictions"][0]["miss_probability"] <= 1.0

    cohort = client.cohort_risk(synthetic={"n_users": 40, "n_days": 7, "seed": 1})
    assert cohort["total_doses"] > 0
