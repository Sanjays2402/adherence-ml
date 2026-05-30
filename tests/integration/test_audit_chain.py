"""Integration tests for the tamper-evident audit hash chain.

Walks the same path as ``test_audit.py``: trains a tiny model, hits
``/v1/predict`` a few times to seed audit rows, then asserts:

* every row gets ``prev_hash`` / ``row_hash`` populated,
* ``/v1/audit/verify`` reports ``ok`` and a non-null head hash,
* an out-of-band edit to one row is detected as a chain break.
"""
from __future__ import annotations

from itertools import pairwise

from adherence_common.settings import reload_settings
from fastapi.testclient import TestClient
from sqlalchemy import update


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/audit_chain.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


def _train(tmp_path):
    from adherence_worker import inference as inf
    inf.load_model.cache_clear()
    from adherence_trainer.pipeline import run_training
    run_training(synthetic=True, users=80, days=10, seed=13,
                 register_as="default", use_mlflow=False, cv_splits=0)


def _seed_predictions(client: TestClient, n: int = 3) -> None:
    schedule = [
        {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
         "dose_class": "cardio", "dose_strength_mg": 10.0},
    ]
    for i in range(n):
        payload = {"user_id": f"u_00000{i + 1}", "schedule": schedule}
        r = client.post("/v1/predict", json=payload, headers={"x-api-key": "svc"})
        assert r.status_code == 200, r.text


def test_audit_chain_is_populated_and_verifies(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    _seed_predictions(client, n=3)

    from adherence_common.db import PredictionAudit, session
    from sqlalchemy import select
    with session() as s:
        rows = list(s.scalars(select(PredictionAudit).order_by(PredictionAudit.id.asc())))
    assert len(rows) >= 3
    assert rows[0].prev_hash is None, "genesis row must have NULL prev_hash"
    assert rows[0].row_hash and len(rows[0].row_hash) == 64
    for prev, cur in pairwise(rows):
        assert cur.prev_hash == prev.row_hash, "prev_hash must link to prior row_hash"
        assert cur.row_hash and cur.row_hash != prev.row_hash

    r = client.get("/v1/audit/verify", headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["n_hashed"] >= 3
    assert body["head_hash"] == rows[-1].row_hash
    assert body["breaks"] == []


def test_audit_chain_detects_tampering(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    _seed_predictions(client, n=3)

    # Simulate an attacker editing an audit row in place (e.g. hiding which
    # user was scored). The hash will no longer match the canonical payload.
    from adherence_common.db import PredictionAudit, session
    with session() as s:
        s.execute(
            update(PredictionAudit)
            .where(PredictionAudit.id == 2)
            .values(user_id="tampered_user")
        )
        s.commit()

    r = client.get("/v1/audit/verify", headers={"x-api-key": "adm"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    reasons = {b["reason"] for b in body["breaks"]}
    # The edit breaks row 2's own hash and (since row 3 still points at row
    # 2's original hash) leaves row 2's stored prev_hash dangling only if the
    # adversary also edited prev_hash. Here only ``row_hash_mismatch`` is
    # guaranteed; ``prev_hash_mismatch`` on row 3 is not, since we did not
    # touch row 2's hash columns.
    assert "row_hash_mismatch" in reasons
    assert any(b["row_id"] == 2 for b in body["breaks"])


def test_audit_verify_requires_admin(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    r = client.get("/v1/audit/verify", headers={"x-api-key": "vwr"})
    assert r.status_code == 403
    r = client.get("/v1/audit/verify", headers={"x-api-key": "svc"})
    assert r.status_code == 403
