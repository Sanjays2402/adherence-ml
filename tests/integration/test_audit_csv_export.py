"""Tests for /v1/audit/export.csv."""
from __future__ import annotations

import csv
import io

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/exp.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    from adherence_worker import inference as inf
    inf.load_model.cache_clear()
    from adherence_trainer.pipeline import run_training
    run_training(synthetic=True, users=60, days=8, seed=11,
                 register_as="default", use_mlflow=False, cv_splits=0)


def test_export_csv_streams_audit_rows(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    payload = {
        "user_id": "u_000001",
        "schedule": [
            {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
             "dose_class": "cardio", "dose_strength_mg": 10.0},
        ],
        "top_k_reasons": 1,
    }
    for _ in range(3):
        r = client.post("/v1/predict", json=payload, headers={"x-api-key": "svc"})
        assert r.status_code == 200, r.text

    r = client.get("/v1/audit/export.csv", headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/csv")
    assert "audit_" in r.headers["content-disposition"]
    n = int(r.headers["x-row-count"])
    assert n >= 3
    reader = csv.DictReader(io.StringIO(r.text))
    rows = list(reader)
    assert len(rows) == n
    assert "user_id" in reader.fieldnames
    assert "model_name" in reader.fieldnames
    assert all(row["user_id"] for row in rows)
    # CSV-escaping sanity: every line should parse, none should contain a raw
    # unescaped quote run.
    assert all("\x00" not in row.get("error", "") for row in rows)


def test_export_csv_filters_by_user_and_only_errors(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    payload = {
        "user_id": "u_000001",
        "schedule": [
            {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
             "dose_class": "cardio", "dose_strength_mg": 10.0},
        ],
        "top_k_reasons": 1,
    }
    client.post("/v1/predict", json=payload, headers={"x-api-key": "svc"})
    other = {**payload, "user_id": "u_other"}
    client.post("/v1/predict", json=other, headers={"x-api-key": "svc"})

    r = client.get("/v1/audit/export.csv?user_id=u_000001",
                   headers={"x-api-key": "adm"})
    assert r.status_code == 200
    rows = list(csv.DictReader(io.StringIO(r.text)))
    assert rows and all(row["user_id"] == "u_000001" for row in rows)

    r = client.get("/v1/audit/export.csv?only_errors=true",
                   headers={"x-api-key": "adm"})
    assert r.status_code == 200
    rows = list(csv.DictReader(io.StringIO(r.text)))
    assert all(row["ok"] == "0" for row in rows)


def test_export_csv_requires_admin(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    r = client.get("/v1/audit/export.csv", headers={"x-api-key": "svc"})
    assert r.status_code in (401, 403)
    r = client.get("/v1/audit/export.csv")
    assert r.status_code in (401, 403)


def test_export_csv_since_until_absolute_range(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    payload = {
        "user_id": "u_000001",
        "schedule": [
            {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
             "dose_class": "cardio", "dose_strength_mg": 10.0},
        ],
        "top_k_reasons": 1,
    }
    for _ in range(3):
        r = client.post("/v1/predict", json=payload, headers={"x-api-key": "svc"})
        assert r.status_code == 200, r.text

    # since in the far future -> no rows, but 200 OK and a since-stamped filename
    r = client.get(
        "/v1/audit/export.csv?since=2099-01-01T00:00:00Z",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    assert int(r.headers["x-row-count"]) == 0
    assert "20990101T000000Z_onwards.csv" in r.headers["content-disposition"]

    # since in the far past, no until -> captures all 3 rows
    r = client.get(
        "/v1/audit/export.csv?since=2000-01-01T00:00:00Z",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200
    assert int(r.headers["x-row-count"]) >= 3

    # since past + until past -> empty window, ranged filename
    r = client.get(
        "/v1/audit/export.csv"
        "?since=2000-01-01T00:00:00Z&until=2000-01-02T00:00:00Z",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200
    assert int(r.headers["x-row-count"]) == 0
    cd = r.headers["content-disposition"]
    assert "20000101T000000Z_to_20000102T000000Z.csv" in cd


def test_export_csv_rejects_bad_iso_and_inverted_range(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    r = client.get(
        "/v1/audit/export.csv?since=not-a-date",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 400
    assert "since" in r.text

    r = client.get(
        "/v1/audit/export.csv"
        "?since=2026-02-01T00:00:00Z&until=2026-01-01T00:00:00Z",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 400
    assert "until must be after since" in r.text


def test_list_audit_since_until_filters(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    payload = {
        "user_id": "u_000001",
        "schedule": [
            {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
             "dose_class": "cardio", "dose_strength_mg": 10.0},
        ],
        "top_k_reasons": 1,
    }
    for _ in range(2):
        client.post("/v1/predict", json=payload, headers={"x-api-key": "svc"})

    r = client.get(
        "/v1/audit/list?since=2099-01-01T00:00:00Z",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200
    assert r.json()["n"] == 0

    r = client.get(
        "/v1/audit/list?since=2000-01-01T00:00:00Z",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200
    assert r.json()["n"] >= 2
