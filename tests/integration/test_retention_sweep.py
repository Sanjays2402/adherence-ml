"""Tests for audit / outcomes / webhook retention sweeper."""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/r.db")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()


def _seed_rows(now: datetime) -> None:
    """Insert 5 rows per table at varying ages."""
    from adherence_common.db import (
        DoseOutcome,
        IdempotencyRecord,
        PredictionAudit,
        WebhookDelivery,
        session,
    )
    ages_days = [1, 30, 95, 200, 400]
    with session() as s:
        for i, age in enumerate(ages_days):
            ts = now - timedelta(days=age)
            s.add(PredictionAudit(
                request_id=f"r{i}", route="/v1/predict",
                user_id=f"u{i}", caller="k:test", caller_role="service",
                model_name="default", model_version="v1",
                n_doses=1, mean_miss_prob=0.1, max_miss_prob=0.1,
                high_risk_count=0, latency_ms=1.0, ok=1,
                created_at=ts,
            ))
            s.add(DoseOutcome(
                source="medtracker", external_event_id=f"e{i}",
                user_id=f"u{i}", dose_id=f"d{i}",
                scheduled_at=ts, observed_at=ts, outcome="taken",
                received_at=ts,
            ))
            s.add(WebhookDelivery(
                subscription_id=1, event_type="intervention.recommended",
                payload_json={}, attempt=1, status_code=200,
                latency_ms=10.0, state="success", created_at=ts,
            ))
            s.add(IdempotencyRecord(
                key=f"k{i}", caller="c", route="/v1/predict",
                request_hash="h", status_code=200, response_json={},
                created_at=ts - timedelta(days=1),
                expires_at=ts,  # expires_at is the timestamp checked
            ))
        s.commit()


def test_sweep_dry_run_counts_without_deleting(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    now = datetime.utcnow()
    _seed_rows(now)
    from adherence_common import retention
    rows = retention.sweep(dry_run=True, now=now)
    by_table = {r.table: r for r in rows}
    # defaults: audit 90d, outcomes 180d, webhooks 30d, idem 2d
    assert by_table["prediction_audit"].candidates == 3     # 95, 200, 400
    assert by_table["prediction_audit"].deleted == 0
    assert by_table["dose_outcomes"].candidates == 2        # 200, 400
    assert by_table["webhook_deliveries"].candidates == 3   # 95, 200, 400
    assert by_table["idempotency_records"].candidates >= 3

    # Nothing actually deleted on dry run.
    from sqlalchemy import func, select
    from adherence_common.db import PredictionAudit, session
    with session() as s:
        n = s.execute(select(func.count()).select_from(PredictionAudit)).scalar_one()
    assert n == 5


def test_sweep_deletes_old_rows(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    now = datetime.utcnow()
    _seed_rows(now)
    from adherence_common import retention
    rows = retention.sweep(now=now)
    by_table = {r.table: r for r in rows}
    assert by_table["prediction_audit"].deleted == 3
    assert by_table["dose_outcomes"].deleted == 2

    from sqlalchemy import func, select
    from adherence_common.db import PredictionAudit, session
    with session() as s:
        n = s.execute(select(func.count()).select_from(PredictionAudit)).scalar_one()
    assert n == 2


def test_sweep_respects_table_filter_and_override(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    now = datetime.utcnow()
    _seed_rows(now)
    from adherence_common import retention
    rows = retention.sweep(
        tables=["prediction_audit"],
        ttls_days={"prediction_audit": 10},
        now=now,
    )
    assert len(rows) == 1
    assert rows[0].table == "prediction_audit"
    assert rows[0].deleted == 4  # 30, 95, 200, 400


def test_sweep_rejects_unknown_table(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_common import retention
    with pytest.raises(ValueError):
        retention.sweep(tables=["bogus"])
    with pytest.raises(ValueError):
        retention.sweep(ttls_days={"bogus": 5})
    with pytest.raises(ValueError):
        retention.sweep(ttls_days={"prediction_audit": -1})


def test_admin_endpoint_dry_run_then_delete(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    now = datetime.utcnow()
    _seed_rows(now)
    from adherence_api.app import create_app
    c = TestClient(create_app())
    adm = {"x-api-key": "adm"}
    svc = {"x-api-key": "svc"}

    # Viewer/service forbidden.
    r = c.post("/v1/admin/audit/retention", json={"dry_run": True}, headers=svc)
    assert r.status_code == 403

    r = c.post("/v1/admin/audit/retention", json={"dry_run": True}, headers=adm)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dry_run"] is True
    tables = {row["table"]: row for row in body["results"]}
    assert tables["prediction_audit"]["deleted"] == 0
    assert tables["prediction_audit"]["candidates"] >= 2

    r = c.post(
        "/v1/admin/audit/retention",
        json={"tables": ["prediction_audit"], "ttls_days": {"prediction_audit": 10}},
        headers=adm,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dry_run"] is False
    assert body["results"][0]["table"] == "prediction_audit"
    assert body["results"][0]["deleted"] >= 1
