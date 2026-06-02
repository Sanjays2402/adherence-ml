"""Integration tests for prediction audit log + /v1/audit endpoints."""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/audit.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    # disable rate limiter so a tight test loop doesn't get throttled
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    # reset audit init flag so it picks up the new DB
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


def _train(tmp_path):
    from adherence_worker import inference as inf
    inf.load_model.cache_clear()
    from adherence_trainer.pipeline import run_training
    run_training(synthetic=True, users=80, days=10, seed=11,
                 register_as="default", use_mlflow=False, cv_splits=0)


def test_predict_writes_audit_row(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    schedule = [
        {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
         "dose_class": "cardio", "dose_strength_mg": 10.0},
    ]
    payload = {"user_id": "u_000007", "schedule": schedule, "top_k_reasons": 2}
    r = client.post("/v1/predict", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200

    # admin can list it back
    r = client.get("/v1/audit/list?limit=10", headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n"] >= 1
    row = next(x for x in body["items"] if x["user_id"] == "u_000007")
    assert row["route"] == "/v1/predict"
    assert row["ok"] is True
    assert row["n_doses"] == 1
    assert row["model_version"]
    assert row["latency_ms"] is not None and row["latency_ms"] >= 0
    assert row["caller_role"] == "service"
    assert row["caller"].startswith("k:")


def test_audit_filters_by_user_and_only_errors(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    base = {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
            "dose_class": "cardio", "dose_strength_mg": 10.0}
    for uid in ["alice", "bob", "alice"]:
        client.post("/v1/predict",
                    json={"user_id": uid, "schedule": [base], "top_k_reasons": 1},
                    headers={"x-api-key": "svc"})

    r = client.get("/v1/audit/list?user_id=alice", headers={"x-api-key": "adm"})
    assert r.status_code == 200
    rows = r.json()["items"]
    assert rows and all(x["user_id"] == "alice" for x in rows)

    # errors filter on a clean run should return empty
    r = client.get("/v1/audit/list?only_errors=true", headers={"x-api-key": "adm"})
    assert r.status_code == 200
    assert r.json()["items"] == []


def test_audit_stats_aggregates(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    base = {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
            "dose_class": "cardio", "dose_strength_mg": 10.0}
    for i in range(4):
        client.post("/v1/predict",
                    json={"user_id": f"u_{i}", "schedule": [base], "top_k_reasons": 1},
                    headers={"x-api-key": "svc"})

    r = client.get("/v1/audit/stats?window_hours=1", headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["n_calls"] >= 4
    assert s["error_rate"] == 0.0
    assert s["p50_latency_ms"] is not None
    assert s["p95_latency_ms"] is not None
    assert s["by_route"].get("/v1/predict", 0) >= 4
    assert "default" in s["by_model"]


def test_audit_endpoints_require_admin(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    r = client.get("/v1/audit/list", headers={"x-api-key": "svc"})
    assert r.status_code == 403
    r = client.get("/v1/audit/stats", headers={"x-api-key": "vwr"})
    assert r.status_code == 403


def test_batch_predict_writes_per_item_audit(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    item = {
        "user_id": "u_batch",
        "schedule": [{
            "dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
            "dose_class": "cardio", "dose_strength_mg": 10.0,
        }],
        "top_k_reasons": 1,
    }
    r = client.post("/v1/predict/batch",
                    json={"items": [item, item, item]},
                    headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text

    r = client.get("/v1/audit/list?route=/v1/predict/batch&user_id=u_batch",
                   headers={"x-api-key": "adm"})
    assert r.status_code == 200
    rows = r.json()["items"]
    assert len(rows) >= 3


def test_audit_filter_by_request_id(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    base = {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
            "dose_class": "cardio", "dose_strength_mg": 10.0}
    # fire a few requests, capture the request id of the middle one
    for _ in range(2):
        client.post("/v1/predict",
                    json={"user_id": "u_rid", "schedule": [base], "top_k_reasons": 1},
                    headers={"x-api-key": "svc"})
    target = client.post(
        "/v1/predict",
        json={"user_id": "u_rid", "schedule": [base], "top_k_reasons": 1},
        headers={"x-api-key": "svc", "x-request-id": "req-test-1234"},
    )
    assert target.status_code == 200
    for _ in range(2):
        client.post("/v1/predict",
                    json={"user_id": "u_rid", "schedule": [base], "top_k_reasons": 1},
                    headers={"x-api-key": "svc"})

    r = client.get("/v1/audit/list?request_id=req-test-1234",
                   headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    rows = r.json()["items"]
    assert len(rows) == 1
    assert rows[0]["request_id"] == "req-test-1234"

    # CSV export honors the same filter
    r = client.get("/v1/audit/export.csv?request_id=req-test-1234",
                   headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    assert r.headers.get("X-Row-Count") == "1"
    body = r.text.splitlines()
    assert len(body) == 2  # header + 1 row
    assert "req-test-1234" in body[1]

    # unknown request id returns empty
    r = client.get("/v1/audit/list?request_id=does-not-exist",
                   headers={"x-api-key": "adm"})
    assert r.status_code == 200
    assert r.json()["items"] == []


def test_audit_filter_by_caller(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    base = {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
            "dose_class": "cardio", "dose_strength_mg": 10.0}
    # mix calls from the svc key and the adm key so we can prove the
    # filter actually narrows the result set
    for _ in range(3):
        client.post("/v1/predict",
                    json={"user_id": "u_caller", "schedule": [base], "top_k_reasons": 1},
                    headers={"x-api-key": "svc"})
    client.post("/v1/predict",
                json={"user_id": "u_caller", "schedule": [base], "top_k_reasons": 1},
                headers={"x-api-key": "adm"})

    # discover the caller principal recorded for the svc key by reading
    # one of its rows back, then filter on it
    r = client.get("/v1/audit/list?user_id=u_caller",
                   headers={"x-api-key": "adm"})
    assert r.status_code == 200
    items = r.json()["items"]
    svc_caller = next(it["caller"] for it in items if it["caller_role"] == "service")

    r = client.get(f"/v1/audit/list?caller={svc_caller}",
                   headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    rows = r.json()["items"]
    assert len(rows) >= 3
    assert all(row["caller"] == svc_caller for row in rows)

    # CSV export honors the same filter
    r = client.get(f"/v1/audit/export.csv?caller={svc_caller}",
                   headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    body = r.text.splitlines()
    assert len(body) >= 2
    header = body[0].split(",")
    caller_idx = header.index("caller")
    for line in body[1:]:
        assert line.split(",")[caller_idx] == svc_caller

    # unknown caller returns empty
    r = client.get("/v1/audit/list?caller=k:does-not-exist",
                   headers={"x-api-key": "adm"})
    assert r.status_code == 200
    assert r.json()["items"] == []


def test_audit_list_before_id_cursor_pagination(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    base = {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
            "dose_class": "cardio", "dose_strength_mg": 10.0}
    for i in range(5):
        client.post(
            "/v1/predict",
            json={"user_id": f"pg_{i}", "schedule": [base], "top_k_reasons": 1},
            headers={"x-api-key": "svc"},
        )

    # First page of 2 rows: newest first.
    r = client.get("/v1/audit/list?limit=2", headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n"] == 2
    page1_ids = [row["id"] for row in body["items"]]
    assert page1_ids == sorted(page1_ids, reverse=True)
    cursor = body["next_before_id"]
    assert cursor == page1_ids[-1]

    # Second page using cursor: strictly older ids, no overlap.
    r = client.get(
        f"/v1/audit/list?limit=2&before_id={cursor}",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200
    body2 = r.json()
    page2_ids = [row["id"] for row in body2["items"]]
    assert all(i < cursor for i in page2_ids)
    assert not set(page1_ids) & set(page2_ids)

    # Walk to the end: last page returns next_before_id=None.
    seen: list[int] = list(page1_ids) + list(page2_ids)
    next_cur = body2["next_before_id"]
    guard = 0
    while next_cur is not None and guard < 20:
        guard += 1
        r = client.get(
            f"/v1/audit/list?limit=2&before_id={next_cur}",
            headers={"x-api-key": "adm"},
        )
        assert r.status_code == 200
        bod = r.json()
        for row in bod["items"]:
            assert row["id"] < next_cur
            seen.append(row["id"])
        next_cur = bod["next_before_id"]
    # No duplicates across pages.
    assert len(seen) == len(set(seen))


def test_audit_list_before_id_rejects_zero(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    r = client.get("/v1/audit/list?before_id=0", headers={"x-api-key": "adm"})
    assert r.status_code == 422


def test_audit_filter_by_model_version(tmp_path, monkeypatch):
    """``model_version`` narrows list + CSV export to a single rollout.

    Triage scenario: a customer reports flaky predictions after a rollout.
    On-call wants every audit row answered by the new version, separate
    from prior-version traffic still in the window, without scanning the
    full log by hand.
    """
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    from adherence_common.db import PredictionAudit, session

    client = TestClient(create_app())
    base = {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
            "dose_class": "cardio", "dose_strength_mg": 10.0}
    for _ in range(3):
        client.post(
            "/v1/predict",
            json={"user_id": "u_mv", "schedule": [base], "top_k_reasons": 1},
            headers={"x-api-key": "svc"},
        )
    # Stamp some rows with a synthetic prior version so we have a mix.
    with session() as s:
        all_rows = list(s.scalars(
            __import__("sqlalchemy").select(PredictionAudit)
            .where(PredictionAudit.user_id == "u_mv")
            .order_by(PredictionAudit.id.asc())
        ))
        # Mark the oldest one as the prior version.
        all_rows[0].model_version = "v-prior-test"
        s.commit()
        current_version = all_rows[-1].model_version

    # List: only current-version rows come back.
    r = client.get(
        f"/v1/audit/list?model_version={current_version}&user_id=u_mv",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    rows = r.json()["items"]
    assert rows and all(row["model_version"] == current_version for row in rows)
    assert all(row["model_version"] != "v-prior-test" for row in rows)

    # List: filter on prior version returns the seeded one.
    r = client.get(
        "/v1/audit/list?model_version=v-prior-test&user_id=u_mv",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200
    rows = r.json()["items"]
    assert len(rows) == 1 and rows[0]["model_version"] == "v-prior-test"

    # CSV export honors the same filter.
    r = client.get(
        "/v1/audit/export.csv?model_version=v-prior-test",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    assert r.headers.get("X-Row-Count") == "1"
    lines = r.text.splitlines()
    header = lines[0].split(",")
    mv_idx = header.index("model_version")
    for line in lines[1:]:
        assert line.split(",")[mv_idx] == "v-prior-test"

    # Unknown version returns empty.
    r = client.get(
        "/v1/audit/list?model_version=does-not-exist",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200
    assert r.json()["items"] == []


def test_audit_stats_filters(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    base = {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
            "dose_class": "cardio", "dose_strength_mg": 10.0}
    # mix calls from two users via two different api keys so we can
    # narrow by user_id and by caller principal
    for _ in range(3):
        client.post("/v1/predict",
                    json={"user_id": "u_alpha", "schedule": [base], "top_k_reasons": 1},
                    headers={"x-api-key": "svc"})
    for _ in range(2):
        client.post("/v1/predict",
                    json={"user_id": "u_beta", "schedule": [base], "top_k_reasons": 1},
                    headers={"x-api-key": "adm"})
    # one batch call so we have a second route to filter on
    client.post(
        "/v1/predict/batch",
        json={"items": [{"user_id": "u_alpha", "schedule": [base], "top_k_reasons": 1}]},
        headers={"x-api-key": "svc"},
    )

    # baseline: no filter sees everything
    r = client.get("/v1/audit/stats?window_hours=1", headers={"x-api-key": "adm"})
    assert r.status_code == 200
    total = r.json()["n_calls"]
    assert total >= 6

    # filter by user_id
    r = client.get("/v1/audit/stats?window_hours=1&user_id=u_alpha",
                   headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_calls"] == 4  # 3 predict + 1 batch
    assert set(body["by_route"].keys()) <= {"/v1/predict", "/v1/predict/batch"}

    # filter by route narrows to predict only
    r = client.get(
        "/v1/audit/stats?window_hours=1&user_id=u_alpha&route=/v1/predict",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["n_calls"] == 3
    assert body["by_route"] == {"/v1/predict": 3}

    # filter by caller principal: discover the svc caller, then filter
    r = client.get("/v1/audit/list?user_id=u_alpha&limit=10",
                   headers={"x-api-key": "adm"})
    svc_caller = next(it["caller"] for it in r.json()["items"]
                      if it["caller_role"] == "service")
    r = client.get(f"/v1/audit/stats?window_hours=1&caller={svc_caller}",
                   headers={"x-api-key": "adm"})
    assert r.status_code == 200
    body = r.json()
    # svc made 3 predicts for u_alpha plus 1 batch = 4 calls
    assert body["n_calls"] == 4
    assert body["error_rate"] == 0.0

    # filter by model_name + model_version, scoped to the deployed default
    r = client.get("/v1/audit/list?limit=1", headers={"x-api-key": "adm"})
    sample = r.json()["items"][0]
    mv = sample["model_version"]
    r = client.get(
        f"/v1/audit/stats?window_hours=1&model_name=default&model_version={mv}",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["n_calls"] == total
    assert body["by_model"] == {"default": total}

    # unknown model_version returns an empty rollup, not a crash
    r = client.get(
        "/v1/audit/stats?window_hours=1&model_version=does-not-exist",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["n_calls"] == 0
    assert body["error_rate"] == 0.0
    assert body["p50_latency_ms"] is None
    assert body["by_model"] == {}


def test_audit_stats_since_until_absolute_window(tmp_path, monkeypatch):
    """`/v1/audit/stats` accepts ISO-8601 since/until like /list and export.csv,
    so a compliance reviewer can rollup an exact window (e.g. one calendar
    day) without back-computing window_hours."""
    from datetime import datetime, timedelta

    from adherence_common.db import PredictionAudit, init_db, session

    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    base = {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
            "dose_class": "cardio", "dose_strength_mg": 10.0}
    # generate a handful of audit rows in the normal flow
    for _ in range(4):
        client.post("/v1/predict",
                    json={"user_id": "u_since", "schedule": [base], "top_k_reasons": 1},
                    headers={"x-api-key": "adm"})

    # backdate two of them to one week ago so a tight since-window can
    # exclude them but a wide window includes them
    init_db()
    week_ago = datetime.utcnow() - timedelta(days=7)
    with session() as s:
        rows = list(s.scalars(
            __import__("sqlalchemy").select(PredictionAudit)
            .where(PredictionAudit.user_id == "u_since")
            .order_by(PredictionAudit.id.asc())
        ))
        assert len(rows) >= 4
        for r in rows[:2]:
            r.created_at = week_ago
        s.commit()

    # tight since=now-1h still sees the two recent rows
    one_hour_ago = (datetime.utcnow() - timedelta(hours=1)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    r = client.get(
        f"/v1/audit/stats?user_id=u_since&since={one_hour_ago}",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["n_calls"] == 2

    # wide since=now-30d sees all four
    thirty_days_ago = (datetime.utcnow() - timedelta(days=30)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    r = client.get(
        f"/v1/audit/stats?user_id=u_since&since={thirty_days_ago}",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200
    assert r.json()["n_calls"] == 4

    # explicit until carves out only the backdated rows
    eight_days_ago = (datetime.utcnow() - timedelta(days=8)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    six_days_ago = (datetime.utcnow() - timedelta(days=6)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    r = client.get(
        f"/v1/audit/stats?user_id=u_since&since={eight_days_ago}&until={six_days_ago}",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200
    assert r.json()["n_calls"] == 2

    # until <= since is a 400, matching /list and /export.csv
    r = client.get(
        f"/v1/audit/stats?since={six_days_ago}&until={eight_days_ago}",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 400

    # malformed since is a 400 with a useful message
    r = client.get(
        "/v1/audit/stats?since=not-a-date",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 400
    assert "since" in r.json()["detail"]


def test_audit_filter_by_high_risk_only(tmp_path, monkeypatch):
    """list + export.csv accept high_risk_only=true and return only rows
    where high_risk_count > 0, so clinical ops can pull alert-only traffic
    without paging the full firehose."""
    _setup_env(tmp_path, monkeypatch)
    from datetime import datetime
    from adherence_common.db import PredictionAudit, init_db, session
    from adherence_api.app import create_app

    init_db()
    with session() as s:
        for i in range(3):
            s.add(PredictionAudit(
                tenant_id="default", request_id=f"req-low-{i}",
                route="/v1/predict", user_id="u_hr", caller="k:test",
                caller_role="service", model_name="default", model_version="v1",
                n_doses=1, mean_miss_prob=0.1, max_miss_prob=0.1,
                high_risk_count=0, latency_ms=1.0, ok=1,
                created_at=datetime.utcnow(),
            ))
        for i in range(2):
            s.add(PredictionAudit(
                tenant_id="default", request_id=f"req-hi-{i}",
                route="/v1/predict", user_id="u_hr", caller="k:test",
                caller_role="service", model_name="default", model_version="v1",
                n_doses=1, mean_miss_prob=0.9, max_miss_prob=0.95,
                high_risk_count=2, latency_ms=1.0, ok=1,
                created_at=datetime.utcnow(),
            ))
        s.commit()

    client = TestClient(create_app())

    # without the filter we see all 5 rows
    r = client.get("/v1/audit/list?user_id=u_hr",
                   headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    assert len(r.json()["items"]) == 5

    # high_risk_only narrows to the 2 alert rows
    r = client.get("/v1/audit/list?user_id=u_hr&high_risk_only=true",
                   headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    rows = r.json()["items"]
    assert len(rows) == 2
    assert all(row["high_risk_count"] > 0 for row in rows)
    assert {row["request_id"] for row in rows} == {"req-hi-0", "req-hi-1"}

    # CSV export honors the same filter
    r = client.get(
        "/v1/audit/export.csv?user_id=u_hr&high_risk_only=true&window_hours=24",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    assert r.headers.get("X-Row-Count") == "2"
    lines = r.text.splitlines()
    assert len(lines) == 3  # header + 2 rows
    for line in lines[1:]:
        assert "req-hi" in line
