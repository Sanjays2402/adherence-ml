"""Tests for /v1/cohort/risk/export NDJSON streaming."""
from __future__ import annotations

import json

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/x.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


def _train(name="default"):
    from adherence_worker import inference as inf
    inf.load_model.cache_clear()
    from adherence_trainer.pipeline import run_training
    return run_training(
        synthetic=True, users=80, days=10, seed=3,
        register_as=name, use_mlflow=False, cv_splits=0,
    )


def _parse_ndjson(body: bytes) -> list[dict]:
    return [json.loads(line) for line in body.splitlines() if line.strip()]


def test_export_streams_header_rows_footer(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    r = c.post(
        "/v1/cohort/risk/export",
        params={"limit": 50},
        json={"synthetic": {"n_users": 30, "n_days": 5, "seed": 1}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/x-ndjson")
    rows = _parse_ndjson(r.content)
    assert rows[0]["kind"] == "header"
    assert rows[0]["model_name"] == "default"
    assert rows[0]["total_candidates"] > 0
    body_rows = [x for x in rows if x["kind"] == "row"]
    footer = rows[-1]
    assert footer["kind"] == "footer"
    assert footer["emitted"] == len(body_rows)
    assert len(body_rows) <= 50
    for row in body_rows:
        assert 0.0 <= row["miss_probability"] <= 1.0
        assert row["risk_tier"] in {"low", "medium", "high"}
        assert row["dose_class"]


def test_export_filters_by_tier_and_min_probability(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    r = c.post(
        "/v1/cohort/risk/export",
        params={"risk_tier": "high,medium", "min_probability": 0.3},
        json={"synthetic": {"n_users": 60, "n_days": 7, "seed": 9}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200
    rows = [x for x in _parse_ndjson(r.content) if x["kind"] == "row"]
    assert rows, "expected at least one row given a 60-user synthetic cohort"
    for row in rows:
        assert row["risk_tier"] in {"high", "medium"}
        assert row["miss_probability"] >= 0.3


def test_export_filters_by_dose_class_and_user_ids(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    # First get a baseline to discover real user ids in the synthetic set.
    r = c.post(
        "/v1/cohort/risk/export",
        params={"limit": 200},
        json={"synthetic": {"n_users": 40, "n_days": 5, "seed": 4}},
        headers={"x-api-key": "svc"},
    )
    base_rows = [x for x in _parse_ndjson(r.content) if x["kind"] == "row"]
    classes = sorted({row["dose_class"] for row in base_rows})
    assert classes, "no rows in baseline"
    chosen_class = classes[0]
    chosen_users = sorted({row["user_id"] for row in base_rows})[:3]

    r = c.post(
        "/v1/cohort/risk/export",
        params={
            "dose_class": chosen_class,
            "user_ids": ",".join(chosen_users),
        },
        json={"synthetic": {"n_users": 40, "n_days": 5, "seed": 4}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200
    rows = [x for x in _parse_ndjson(r.content) if x["kind"] == "row"]
    for row in rows:
        assert row["dose_class"] == chosen_class
        assert row["user_id"] in set(chosen_users)


def test_export_rejects_bad_tier_and_class(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    r = c.post(
        "/v1/cohort/risk/export",
        params={"risk_tier": "extreme"},
        json={"synthetic": {"n_users": 10, "n_days": 3, "seed": 1}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 400

    r = c.post(
        "/v1/cohort/risk/export",
        params={"dose_class": "nonexistent"},
        json={"synthetic": {"n_users": 10, "n_days": 3, "seed": 1}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 400


def test_export_requires_service_role(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())
    r = c.post(
        "/v1/cohort/risk/export",
        json={"synthetic": {"n_users": 10, "n_days": 3, "seed": 1}},
        headers={"x-api-key": "vwr"},
    )
    assert r.status_code == 403
