"""Tests for /v1/experiments A/B framework."""
from __future__ import annotations

from collections import Counter

import pytest
from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/e.db")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


def test_assignment_is_deterministic_and_weighted(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_common import experiments as ex
    ex.create_experiment(
        key="reminder_copy",
        variants=[
            {"name": "control", "weight": 1},
            {"name": "short", "weight": 1},
            {"name": "long", "weight": 2},
        ],
        salt="reminder_copy_v1",
    )
    counts: Counter = Counter()
    for i in range(2000):
        out = ex.assign("reminder_copy", f"u{i}", record=False)
        counts[out["variant"]] += 1
    # Weights 1:1:2 -> roughly 25/25/50. Loose tolerance.
    assert 0.20 <= counts["control"] / 2000 <= 0.30
    assert 0.20 <= counts["short"] / 2000 <= 0.30
    assert 0.45 <= counts["long"] / 2000 <= 0.55

    # Determinism: same user -> same arm across calls.
    first = ex.assign("reminder_copy", "u42", record=False)["variant"]
    for _ in range(20):
        assert ex.assign("reminder_copy", "u42", record=False)["variant"] == first


def test_exposure_is_idempotent(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_common import experiments as ex
    ex.create_experiment(
        key="x1",
        variants=[{"name": "a", "weight": 1}, {"name": "b", "weight": 1}],
    )
    first = ex.assign("x1", "alice")
    second = ex.assign("x1", "alice")
    assert first["recorded"] is True
    assert second["recorded"] is False
    assert first["variant"] == second["variant"]


def test_paused_experiment_returns_control_without_recording(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_common import experiments as ex
    ex.create_experiment(
        key="paused_one",
        variants=[{"name": "ctrl", "weight": 1}, {"name": "treat", "weight": 1}],
    )
    ex.set_state("paused_one", "paused")
    out = ex.assign("paused_one", "u1")
    assert out["variant"] == "ctrl"
    assert out["recorded"] is False


def test_log_event_requires_prior_exposure(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_common import experiments as ex
    ex.create_experiment(
        key="x2",
        variants=[{"name": "a", "weight": 1}, {"name": "b", "weight": 1}],
    )
    with pytest.raises(ex.ExperimentError):
        ex.log_event("x2", user_id="ghost", event_name="taken")

    ex.assign("x2", "alice")
    row = ex.log_event("x2", user_id="alice", event_name="taken")
    assert row.variant in {"a", "b"}


def test_results_compute_rates_and_lift(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_common import experiments as ex
    ex.create_experiment(
        key="rx",
        variants=[{"name": "control", "weight": 1}, {"name": "treat", "weight": 1}],
    )
    # Force a controlled scenario by directly inserting exposures/events.
    from adherence_common.db import ExperimentEvent, ExperimentExposure, session
    with session() as s:
        for i in range(100):
            s.add(ExperimentExposure(experiment_key="rx", user_id=f"c{i}", variant="control"))
        for i in range(100):
            s.add(ExperimentExposure(experiment_key="rx", user_id=f"t{i}", variant="treat"))
        # 30 of 100 control convert, 50 of 100 treat convert.
        for i in range(30):
            s.add(ExperimentEvent(experiment_key="rx", user_id=f"c{i}",
                                  variant="control", event_name="taken"))
        for i in range(50):
            s.add(ExperimentEvent(experiment_key="rx", user_id=f"t{i}",
                                  variant="treat", event_name="taken"))
        s.commit()

    out = ex.results("rx", event_name="taken")
    by_v = {a["variant"]: a for a in out["arms"]}
    assert by_v["control"]["rate"] == pytest.approx(0.30, abs=1e-9)
    assert by_v["treat"]["rate"] == pytest.approx(0.50, abs=1e-9)
    assert by_v["treat"]["lift_vs_control"] == pytest.approx(0.20, abs=1e-9)
    # Wilson CI sanity.
    assert by_v["control"]["rate_ci_low"] < 0.30 < by_v["control"]["rate_ci_high"]
    # 30/100 vs 50/100 is significant.
    assert by_v["treat"]["p_value"] is not None
    assert by_v["treat"]["p_value"] < 0.01
    # Idempotency: log same user twice, distinct converters unchanged.
    ex.log_event("rx", user_id="t0", event_name="taken")
    out2 = ex.results("rx", event_name="taken")
    assert {a["variant"]: a["conversions"] for a in out2["arms"]} == \
           {"control": 30, "treat": 50}


def test_api_end_to_end(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    c = TestClient(create_app())
    adm = {"x-api-key": "adm"}
    svc = {"x-api-key": "svc"}
    vwr = {"x-api-key": "vwr"}

    # Viewer cannot create.
    r = c.post("/v1/experiments", json={
        "key": "copy_test",
        "variants": [{"name": "a", "weight": 1}, {"name": "b", "weight": 1}],
    }, headers=vwr)
    assert r.status_code == 403

    r = c.post("/v1/experiments", json={
        "key": "copy_test",
        "description": "Reminder copy A/B",
        "variants": [{"name": "a", "weight": 1}, {"name": "b", "weight": 1}],
    }, headers=adm)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["state"] == "running"
    assert body["salt"] == "copy_test"

    # Duplicate key rejected.
    r = c.post("/v1/experiments", json={
        "key": "copy_test",
        "variants": [{"name": "a", "weight": 1}, {"name": "b", "weight": 1}],
    }, headers=adm)
    assert r.status_code == 400

    # Assign + log + results.
    r = c.post("/v1/experiments/copy_test/assign",
               json={"user_id": "u1"}, headers=svc)
    assert r.status_code == 200
    v1 = r.json()["variant"]
    assert v1 in {"a", "b"}

    r = c.post("/v1/experiments/copy_test/events",
               json={"user_id": "u1", "event_name": "taken"}, headers=svc)
    assert r.status_code == 201

    r = c.get("/v1/experiments/copy_test/results",
              params={"event_name": "taken"}, headers=svc)
    assert r.status_code == 200
    arms = {a["variant"]: a for a in r.json()["arms"]}
    assert arms[v1]["exposures"] == 1
    assert arms[v1]["conversions"] == 1

    # Pause via admin patch, then assignment short-circuits to control.
    r = c.patch("/v1/experiments/copy_test/state",
                json={"state": "paused"}, headers=adm)
    assert r.status_code == 200
    r = c.post("/v1/experiments/copy_test/assign",
               json={"user_id": "u_new"}, headers=svc)
    assert r.status_code == 200
    body = r.json()
    assert body["variant"] == "a"
    assert body["recorded"] is False
    assert body["state"] == "paused"

    # 404s for unknown experiment.
    r = c.get("/v1/experiments/missing", headers=svc)
    assert r.status_code == 404
    r = c.post("/v1/experiments/missing/assign",
               json={"user_id": "x"}, headers=svc)
    assert r.status_code == 404
