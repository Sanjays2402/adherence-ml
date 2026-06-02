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


def test_export_csv_format_streams_with_header_and_safe_cells(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    r = c.post(
        "/v1/cohort/risk/export",
        params={"format": "csv", "limit": 25},
        json={"synthetic": {"n_users": 30, "n_days": 5, "seed": 2}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/csv")
    assert r.headers["content-disposition"].endswith('.csv"')

    import csv as _csv
    import io as _io
    rows = list(_csv.reader(_io.StringIO(r.text)))
    assert rows, "expected at least a header row"
    header = rows[0]
    assert header == [
        "user_id", "dose_id", "dose_class", "time_bucket",
        "miss_probability", "risk_tier", "model_name", "model_version",
    ]
    body = rows[1:]
    assert body, "expected at least one data row"
    assert len(body) <= 25
    for row in body:
        assert len(row) == len(header)
        prob = float(row[4])
        assert 0.0 <= prob <= 1.0
        assert row[5] in {"low", "medium", "high"}
        # CSV formula-injection defense: no cell may start with an active prefix.
        for cell in row:
            assert not cell or cell[0] not in {"=", "+", "-", "@", "\t", "\r"}


def test_export_rejects_unknown_format(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())
    r = c.post(
        "/v1/cohort/risk/export",
        params={"format": "parquet"},
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


def test_export_sort_risk_desc_returns_top_n(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    # Unsorted baseline at limit=20.
    r_base = c.post(
        "/v1/cohort/risk/export",
        params={"limit": 20},
        json={"synthetic": {"n_users": 50, "n_days": 7, "seed": 4}},
        headers={"x-api-key": "svc"},
    )
    assert r_base.status_code == 200
    base_rows = [x for x in _parse_ndjson(r_base.content) if x["kind"] == "row"]
    assert base_rows

    r = c.post(
        "/v1/cohort/risk/export",
        params={"limit": 20, "sort": "risk_desc"},
        json={"synthetic": {"n_users": 50, "n_days": 7, "seed": 4}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200
    rows = [x for x in _parse_ndjson(r.content) if x["kind"] == "row"]
    assert rows
    probs = [row["miss_probability"] for row in rows]
    assert probs == sorted(probs, reverse=True)
    # Top-N by definition: max risk in sorted result >= max risk in unsorted slice.
    assert max(probs) >= max(row["miss_probability"] for row in base_rows)


def test_export_sort_risk_asc_orders_ascending(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())
    r = c.post(
        "/v1/cohort/risk/export",
        params={"limit": 15, "sort": "risk_asc"},
        json={"synthetic": {"n_users": 40, "n_days": 6, "seed": 8}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200
    rows = [x for x in _parse_ndjson(r.content) if x["kind"] == "row"]
    probs = [row["miss_probability"] for row in rows]
    assert probs == sorted(probs)


def test_export_filters_by_max_probability_band(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    r = c.post(
        "/v1/cohort/risk/export",
        params={"min_probability": 0.2, "max_probability": 0.6},
        json={"synthetic": {"n_users": 60, "n_days": 7, "seed": 9}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200
    rows = [x for x in _parse_ndjson(r.content) if x["kind"] == "row"]
    assert rows, "expected at least one row in the 0.2..0.6 band"
    for row in rows:
        assert 0.2 <= row["miss_probability"] <= 0.6


def test_export_rejects_inverted_probability_band(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())
    r = c.post(
        "/v1/cohort/risk/export",
        params={"min_probability": 0.8, "max_probability": 0.2},
        json={"synthetic": {"n_users": 10, "n_days": 3, "seed": 1}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 400


def test_export_rejects_unknown_sort(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())
    r = c.post(
        "/v1/cohort/risk/export",
        params={"sort": "alphabetical"},
        json={"synthetic": {"n_users": 10, "n_days": 3, "seed": 1}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 400


def test_export_filters_by_time_bucket(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    r = c.post(
        "/v1/cohort/risk/export",
        params={"limit": 200},
        json={"synthetic": {"n_users": 40, "n_days": 5, "seed": 7}},
        headers={"x-api-key": "svc"},
    )
    base_rows = [x for x in _parse_ndjson(r.content) if x["kind"] == "row"]
    buckets = sorted({row["time_bucket"] for row in base_rows})
    assert len(buckets) >= 2, "need >=2 buckets in baseline to exercise filter"
    chosen = buckets[:2]

    r = c.post(
        "/v1/cohort/risk/export",
        params={"time_bucket": ",".join(chosen)},
        json={"synthetic": {"n_users": 40, "n_days": 5, "seed": 7}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    rows = [x for x in _parse_ndjson(r.content) if x["kind"] == "row"]
    assert rows
    for row in rows:
        assert row["time_bucket"] in set(chosen)


def test_export_rejects_bad_time_bucket(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    r = c.post(
        "/v1/cohort/risk/export",
        params={"time_bucket": "lunchtime"},
        json={"synthetic": {"n_users": 10, "n_days": 3, "seed": 1}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 400


def test_export_excludes_users_via_denylist(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    # Baseline to learn real user ids in the synthetic cohort.
    r = c.post(
        "/v1/cohort/risk/export",
        json={"synthetic": {"n_users": 20, "n_days": 4, "seed": 7}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200
    base_rows = [x for x in _parse_ndjson(r.content) if x["kind"] == "row"]
    all_users = sorted({row["user_id"] for row in base_rows})
    assert len(all_users) >= 3
    excluded = all_users[:2]

    r = c.post(
        "/v1/cohort/risk/export",
        params={"exclude_user_ids": ",".join(excluded)},
        json={"synthetic": {"n_users": 20, "n_days": 4, "seed": 7}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200
    rows = [x for x in _parse_ndjson(r.content) if x["kind"] == "row"]
    assert rows
    seen = {row["user_id"] for row in rows}
    for uid in excluded:
        assert uid not in seen
    # And non-excluded users still appear.
    assert seen & set(all_users[2:])


def test_export_denylist_wins_over_allowlist(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    r = c.post(
        "/v1/cohort/risk/export",
        json={"synthetic": {"n_users": 15, "n_days": 3, "seed": 9}},
        headers={"x-api-key": "svc"},
    )
    base_rows = [x for x in _parse_ndjson(r.content) if x["kind"] == "row"]
    chosen = sorted({row["user_id"] for row in base_rows})[:3]
    assert len(chosen) == 3

    r = c.post(
        "/v1/cohort/risk/export",
        params={
            "user_ids": ",".join(chosen),
            "exclude_user_ids": chosen[0],
        },
        json={"synthetic": {"n_users": 15, "n_days": 3, "seed": 9}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200
    rows = [x for x in _parse_ndjson(r.content) if x["kind"] == "row"]
    seen = {row["user_id"] for row in rows}
    assert chosen[0] not in seen
    assert seen.issubset(set(chosen[1:]))


def test_export_offset_pages_through_sorted_cohort(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {"synthetic": {"n_users": 50, "n_days": 7, "seed": 17}}

    # Baseline: top-30 highest-risk doses.
    r_full = c.post(
        "/v1/cohort/risk/export",
        params={"sort": "risk_desc", "limit": 30},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_full.status_code == 200
    full = [x for x in _parse_ndjson(r_full.content) if x["kind"] == "row"]
    assert len(full) == 30

    # Page 1: offset=0, limit=10. Page 2: offset=10, limit=10. Page 3: offset=20, limit=10.
    pages = []
    for off in (0, 10, 20):
        r = c.post(
            "/v1/cohort/risk/export",
            params={"sort": "risk_desc", "offset": off, "limit": 10},
            json=payload,
            headers={"x-api-key": "svc"},
        )
        assert r.status_code == 200
        page_rows = [x for x in _parse_ndjson(r.content) if x["kind"] == "row"]
        assert len(page_rows) == 10
        pages.extend(page_rows)

    # Paged concatenation matches the single sorted top-30 export.
    assert [(p["user_id"], p["dose_id"], p["miss_probability"]) for p in pages] == \
        [(f["user_id"], f["dose_id"], f["miss_probability"]) for f in full]


def test_export_offset_past_end_emits_no_rows(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    r = c.post(
        "/v1/cohort/risk/export",
        params={"offset": 10_000_000},
        json={"synthetic": {"n_users": 20, "n_days": 4, "seed": 2}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200
    rows = _parse_ndjson(r.content)
    body_rows = [x for x in rows if x["kind"] == "row"]
    assert body_rows == []
    assert rows[-1]["kind"] == "footer"
    assert rows[-1]["emitted"] == 0


def test_export_offset_rejects_negative(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    r = c.post(
        "/v1/cohort/risk/export",
        params={"offset": -1},
        json={"synthetic": {"n_users": 10, "n_days": 3, "seed": 5}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 422


def test_export_csv_offset_pages_after_sort(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {"synthetic": {"n_users": 40, "n_days": 6, "seed": 21}}

    r_full = c.post(
        "/v1/cohort/risk/export",
        params={"format": "csv", "sort": "risk_desc", "limit": 20},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_full.status_code == 200
    full_lines = r_full.content.decode("utf-8").splitlines()
    full_header, full_rows = full_lines[0], full_lines[1:]
    assert len(full_rows) == 20

    r_page = c.post(
        "/v1/cohort/risk/export",
        params={"format": "csv", "sort": "risk_desc", "offset": 5, "limit": 10},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_page.status_code == 200
    page_lines = r_page.content.decode("utf-8").splitlines()
    assert page_lines[0] == full_header
    page_rows = page_lines[1:]
    assert len(page_rows) == 10
    assert page_rows == full_rows[5:15]


def test_export_count_only_matches_streamed_row_count(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {"synthetic": {"n_users": 50, "n_days": 6, "seed": 17}}
    filters = {"risk_tier": "high,medium", "min_probability": 0.2}

    r_stream = c.post(
        "/v1/cohort/risk/export",
        params=filters,
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_stream.status_code == 200
    rows = [x for x in _parse_ndjson(r_stream.content) if x["kind"] == "row"]
    by_tier_stream = {"low": 0, "medium": 0, "high": 0}
    for row in rows:
        by_tier_stream[row["risk_tier"]] += 1

    r_count = c.post(
        "/v1/cohort/risk/export",
        params={**filters, "count_only": "true"},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_count.status_code == 200
    assert r_count.headers["content-type"].startswith("application/json")
    body = r_count.json()
    assert body["model_name"] == "default"
    assert body["model_version"]
    assert body["total_candidates"] > 0
    assert body["count"] == len(rows)
    assert body["by_tier"] == by_tier_stream


def test_export_count_only_includes_dose_class_and_time_bucket_breakdown(
    tmp_path, monkeypatch
):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {"synthetic": {"n_users": 60, "n_days": 6, "seed": 21}}

    r_stream = c.post(
        "/v1/cohort/risk/export",
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_stream.status_code == 200
    rows = [x for x in _parse_ndjson(r_stream.content) if x["kind"] == "row"]
    by_class_stream: dict[str, int] = {}
    by_bucket_stream: dict[str, int] = {}
    for row in rows:
        by_class_stream[row["dose_class"]] = by_class_stream.get(row["dose_class"], 0) + 1
        by_bucket_stream[row["time_bucket"]] = by_bucket_stream.get(row["time_bucket"], 0) + 1

    r_count = c.post(
        "/v1/cohort/risk/export",
        params={"count_only": "true"},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_count.status_code == 200
    body = r_count.json()
    assert body["by_dose_class"] == by_class_stream
    assert body["by_time_bucket"] == by_bucket_stream
    assert sum(body["by_dose_class"].values()) == body["count"]
    assert sum(body["by_time_bucket"].values()) == body["count"]


def test_export_count_only_breakdown_respects_filters(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {"synthetic": {"n_users": 50, "n_days": 6, "seed": 33}}

    # baseline: see which dose classes exist in the cohort
    r_all = c.post(
        "/v1/cohort/risk/export",
        params={"count_only": "true"},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_all.status_code == 200
    classes = list(r_all.json()["by_dose_class"].keys())
    assert classes, "expected at least one dose_class in synthetic cohort"
    pick = classes[0]

    r_filt = c.post(
        "/v1/cohort/risk/export",
        params={"count_only": "true", "dose_class": pick},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_filt.status_code == 200
    body = r_filt.json()
    assert list(body["by_dose_class"].keys()) == [pick]
    assert body["by_dose_class"][pick] == body["count"]


def test_export_count_only_includes_probability_stats(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {"synthetic": {"n_users": 60, "n_days": 6, "seed": 21}}

    r_stream = c.post(
        "/v1/cohort/risk/export",
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_stream.status_code == 200
    probs = sorted(
        x["miss_probability"]
        for x in _parse_ndjson(r_stream.content)
        if x["kind"] == "row"
    )
    assert probs, "expected at least one scored row in synthetic cohort"

    r_count = c.post(
        "/v1/cohort/risk/export",
        params={"count_only": "true"},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_count.status_code == 200
    stats = r_count.json()["probability_stats"]
    assert stats is not None
    assert stats["min"] == round(probs[0], 6)
    assert stats["max"] == round(probs[-1], 6)
    assert stats["mean"] == round(sum(probs) / len(probs), 6)
    # nearest-rank percentiles, 1-indexed
    n = len(probs)
    p50_idx = max(1, min(n, -(-50 * n // 100))) - 1
    p95_idx = max(1, min(n, -(-95 * n // 100))) - 1
    assert stats["p50"] == round(probs[p50_idx], 6)
    assert stats["p95"] == round(probs[p95_idx], 6)
    assert stats["min"] <= stats["p50"] <= stats["p95"] <= stats["max"]


def test_export_count_only_probability_stats_null_when_empty(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {"synthetic": {"n_users": 20, "n_days": 4, "seed": 7}}

    # filter that matches zero rows: user_ids allowlist with a bogus id
    r = c.post(
        "/v1/cohort/risk/export",
        params={"count_only": "true", "user_ids": "definitely-not-a-real-user"},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 0
    assert body["probability_stats"] is None


def test_export_count_only_ignores_limit_and_offset(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {"synthetic": {"n_users": 25, "n_days": 5, "seed": 4}}

    r_a = c.post(
        "/v1/cohort/risk/export",
        params={"count_only": "true"},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    r_b = c.post(
        "/v1/cohort/risk/export",
        params={"count_only": "true", "limit": 1, "offset": 999999},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_a.status_code == 200
    assert r_b.status_code == 200
    assert r_a.json()["count"] == r_b.json()["count"]


def test_export_footer_includes_by_tier_breakdown(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    r = c.post(
        "/v1/cohort/risk/export",
        json={"synthetic": {"n_users": 40, "n_days": 6, "seed": 7}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    rows = _parse_ndjson(r.content)
    body_rows = [x for x in rows if x["kind"] == "row"]
    footer = rows[-1]
    assert footer["kind"] == "footer"
    assert "by_tier" in footer
    assert set(footer["by_tier"].keys()) == {"low", "medium", "high"}
    expected = {"low": 0, "medium": 0, "high": 0}
    for row in body_rows:
        expected[row["risk_tier"]] += 1
    assert footer["by_tier"] == expected
    assert sum(footer["by_tier"].values()) == footer["emitted"]


def test_export_envelopes_include_scored_at_timestamp(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    r = c.post(
        "/v1/cohort/risk/export",
        json={"synthetic": {"n_users": 25, "n_days": 5, "seed": 4}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    rows = _parse_ndjson(r.content)
    header = rows[0]
    footer = rows[-1]
    assert header["kind"] == "header"
    assert footer["kind"] == "footer"
    assert "scored_at" in header and header["scored_at"].endswith("Z")
    assert "scored_at" in footer
    # one timestamp per export: header and footer agree
    assert header["scored_at"] == footer["scored_at"]
    # parses as ISO-8601 UTC
    from datetime import datetime
    datetime.fromisoformat(header["scored_at"].replace("Z", "+00:00"))

    # count_only response surfaces the same field
    r2 = c.post(
        "/v1/cohort/risk/export",
        params={"count_only": "true"},
        json={"synthetic": {"n_users": 25, "n_days": 5, "seed": 4}},
        headers={"x-api-key": "svc"},
    )
    assert r2.status_code == 200, r2.text
    body = r2.json()
    assert "scored_at" in body and body["scored_at"].endswith("Z")


def test_export_response_headers_expose_snapshot_identity(tmp_path, monkeypatch):
    """X-Scored-At / X-Model-Name / X-Model-Version on all export shapes.

    Nightly snapshot pipelines (and reverse proxies / audit loggers) need to
    know which model version produced an export and what UTC instant it was
    scored at without parsing the response body. NDJSON callers can get this
    from the header envelope but CSV consumers and count_only callers
    historically could not. Surfacing it as response headers lets every
    consumer partition by run identically.
    """
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())
    from datetime import datetime

    def _check(resp):
        assert resp.status_code == 200, resp.text
        assert "x-scored-at" in {k.lower() for k in resp.headers.keys()}
        scored_at = resp.headers["x-scored-at"]
        assert scored_at.endswith("Z")
        datetime.fromisoformat(scored_at.replace("Z", "+00:00"))
        assert resp.headers["x-model-name"] == "default"
        assert resp.headers["x-model-version"]

    # NDJSON
    r = c.post(
        "/v1/cohort/risk/export",
        params={"limit": 5},
        json={"synthetic": {"n_users": 20, "n_days": 4, "seed": 7}},
        headers={"x-api-key": "svc"},
    )
    _check(r)
    # NDJSON header envelope agrees with the response header
    header = _parse_ndjson(r.content)[0]
    assert header["scored_at"] == r.headers["x-scored-at"]
    assert header["model_version"] == r.headers["x-model-version"]

    # CSV
    r = c.post(
        "/v1/cohort/risk/export",
        params={"format": "csv", "limit": 5},
        json={"synthetic": {"n_users": 20, "n_days": 4, "seed": 7}},
        headers={"x-api-key": "svc"},
    )
    _check(r)
    assert r.headers["content-type"].startswith("text/csv")

    # count_only
    r = c.post(
        "/v1/cohort/risk/export",
        params={"count_only": "true"},
        json={"synthetic": {"n_users": 20, "n_days": 4, "seed": 7}},
        headers={"x-api-key": "svc"},
    )
    _check(r)
    assert r.json()["scored_at"] == r.headers["x-scored-at"]


def test_export_response_header_exposes_total_candidates(tmp_path, monkeypatch):
    """X-Total-Candidates on every export shape.

    Snapshot pipelines compute filter selectivity (emitted / total) per
    run for drift monitoring. NDJSON exposes total_candidates in the
    header envelope and count_only in the body, but CSV consumers
    historically had to count rows themselves. Surfacing it as a
    response header lets every consumer get the cohort denominator
    identically without parsing the body.
    """
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {"synthetic": {"n_users": 20, "n_days": 4, "seed": 7}}

    # NDJSON: header value matches envelope total_candidates
    r = c.post(
        "/v1/cohort/risk/export",
        params={"limit": 5},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    total = int(r.headers["x-total-candidates"])
    assert total > 0
    env = _parse_ndjson(r.content)[0]
    assert env["total_candidates"] == total

    # CSV: header value present and positive, no body field to compare to
    r = c.post(
        "/v1/cohort/risk/export",
        params={"format": "csv", "limit": 5},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    assert int(r.headers["x-total-candidates"]) == total

    # count_only: header value matches body total_candidates
    r = c.post(
        "/v1/cohort/risk/export",
        params={"count_only": "true"},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    assert int(r.headers["x-total-candidates"]) == r.json()["total_candidates"]


def test_export_filename_includes_scored_at_date(tmp_path, monkeypatch):
    """Content-Disposition filename embeds the scored_at date (YYYY-MM-DD).

    Nightly snapshot pipelines and ops users that download successive
    exports through a browser or `curl -OJ` would otherwise overwrite
    yesterday's file with today's, losing the historical snapshot. The
    filename now carries the same date the X-Scored-At header advertises
    so files on disk sort chronologically and never collide across runs.
    """
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {"synthetic": {"n_users": 10, "n_days": 3, "seed": 4}}

    for fmt, ext in (("ndjson", "ndjson"), ("csv", "csv")):
        r = c.post(
            "/v1/cohort/risk/export",
            params={"format": fmt, "limit": 3},
            json=payload,
            headers={"x-api-key": "svc"},
        )
        assert r.status_code == 200, r.text
        scored_at = r.headers["x-scored-at"]
        date_part = scored_at[:10]
        # YYYY-MM-DD shape
        assert len(date_part) == 10 and date_part[4] == "-" and date_part[7] == "-"
        cd = r.headers["content-disposition"]
        assert f"_{date_part}.{ext}" in cd, cd


def test_export_count_only_includes_tier_cross_tabs(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {"synthetic": {"n_users": 60, "n_days": 6, "seed": 21}}

    r = c.post(
        "/v1/cohort/risk/export",
        params={"count_only": "true"},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200
    body = r.json()

    # Cross-tabs are present and shaped correctly.
    by_tier_dc = body["by_tier_dose_class"]
    by_tier_tb = body["by_tier_time_bucket"]
    assert set(by_tier_dc.keys()) == set(body["by_dose_class"].keys())
    assert set(by_tier_tb.keys()) == set(body["by_time_bucket"].keys())

    # Each cell has the three tier buckets and integer counts.
    for cls, tiers in by_tier_dc.items():
        assert set(tiers.keys()) == {"low", "medium", "high"}
        assert sum(tiers.values()) == body["by_dose_class"][cls]
    for bucket, tiers in by_tier_tb.items():
        assert set(tiers.keys()) == {"low", "medium", "high"}
        assert sum(tiers.values()) == body["by_time_bucket"][bucket]

    # Row totals across both cross-tabs equal the overall count.
    assert sum(sum(t.values()) for t in by_tier_dc.values()) == body["count"]
    assert sum(sum(t.values()) for t in by_tier_tb.values()) == body["count"]

    # Per-tier totals across cross-tabs match the flat by_tier breakdown.
    for tier in ("low", "medium", "high"):
        assert sum(t[tier] for t in by_tier_dc.values()) == body["by_tier"][tier]
        assert sum(t[tier] for t in by_tier_tb.values()) == body["by_tier"][tier]


def test_export_count_only_tier_cross_tabs_respect_filters(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {"synthetic": {"n_users": 50, "n_days": 6, "seed": 33}}

    r_all = c.post(
        "/v1/cohort/risk/export",
        params={"count_only": "true"},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_all.status_code == 200
    pick = next(iter(r_all.json()["by_dose_class"]))

    r = c.post(
        "/v1/cohort/risk/export",
        params={"count_only": "true", "dose_class": pick},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200
    body = r.json()
    assert list(body["by_tier_dose_class"].keys()) == [pick]
    assert sum(body["by_tier_dose_class"][pick].values()) == body["count"]


def test_export_footer_includes_by_dose_class_and_time_bucket(tmp_path, monkeypatch):
    """Streaming consumers get the same per-class / per-bucket tallies
    count_only already returns, without a second pass over the NDJSON.
    """
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    r = c.post(
        "/v1/cohort/risk/export",
        json={"synthetic": {"n_users": 40, "n_days": 6, "seed": 9}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    rows = _parse_ndjson(r.content)
    body_rows = [x for x in rows if x["kind"] == "row"]
    footer = rows[-1]
    assert footer["kind"] == "footer"
    assert "by_dose_class" in footer
    assert "by_time_bucket" in footer

    expected_class: dict[str, int] = {}
    expected_bucket: dict[str, int] = {}
    for row in body_rows:
        expected_class[row["dose_class"]] = expected_class.get(row["dose_class"], 0) + 1
        expected_bucket[row["time_bucket"]] = expected_bucket.get(row["time_bucket"], 0) + 1

    assert footer["by_dose_class"] == dict(sorted(expected_class.items()))
    assert footer["by_time_bucket"] == dict(sorted(expected_bucket.items()))
    assert sum(footer["by_dose_class"].values()) == footer["emitted"]
    assert sum(footer["by_time_bucket"].values()) == footer["emitted"]
    # keys are sorted for stable downstream diffs
    assert list(footer["by_dose_class"].keys()) == sorted(footer["by_dose_class"].keys())
    assert list(footer["by_time_bucket"].keys()) == sorted(footer["by_time_bucket"].keys())


def test_worst_per_user_collapses_to_one_row_per_user(tmp_path, monkeypatch):
    """worst_per_user keeps the single highest-risk dose per user_id."""
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    body = {"synthetic": {"n_users": 25, "n_days": 7, "seed": 4}}

    # baseline: how many distinct users are in the cohort
    baseline = c.post(
        "/v1/cohort/risk/export",
        json=body,
        headers={"x-api-key": "svc"},
    )
    assert baseline.status_code == 200
    base_rows = [x for x in _parse_ndjson(baseline.content) if x["kind"] == "row"]
    distinct_users = {r["user_id"] for r in base_rows}
    user_to_max = {
        uid: max(r["miss_probability"] for r in base_rows if r["user_id"] == uid)
        for uid in distinct_users
    }

    r = c.post(
        "/v1/cohort/risk/export",
        params={"worst_per_user": "true"},
        json=body,
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200
    rows = [x for x in _parse_ndjson(r.content) if x["kind"] == "row"]
    seen_users = [r["user_id"] for r in rows]
    # one row per user, no duplicates
    assert len(seen_users) == len(set(seen_users))
    assert set(seen_users) == distinct_users
    # each emitted row is that user's max miss_probability
    for r_ in rows:
        assert r_["miss_probability"] == user_to_max[r_["user_id"]]


def test_worst_per_user_count_only_equals_distinct_users(tmp_path, monkeypatch):
    """count_only with worst_per_user reports distinct-user count."""
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    body = {"synthetic": {"n_users": 20, "n_days": 6, "seed": 9}}

    baseline = c.post(
        "/v1/cohort/risk/export",
        json=body,
        headers={"x-api-key": "svc"},
    )
    base_rows = [x for x in _parse_ndjson(baseline.content) if x["kind"] == "row"]
    distinct_users = len({r["user_id"] for r in base_rows})

    r = c.post(
        "/v1/cohort/risk/export",
        params={"worst_per_user": "true", "count_only": "true"},
        json=body,
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200
    payload = r.json()
    assert payload["count"] == distinct_users
    # total_candidates is the pre-dedupe cohort size and stays >= count
    assert payload["total_candidates"] >= payload["count"]


def test_export_footer_includes_probability_stats(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {"synthetic": {"n_users": 60, "n_days": 6, "seed": 21}}

    r_stream = c.post(
        "/v1/cohort/risk/export",
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_stream.status_code == 200
    rows = _parse_ndjson(r_stream.content)
    body_rows = [x for x in rows if x["kind"] == "row"]
    footer = rows[-1]
    assert footer["kind"] == "footer"
    assert "probability_stats" in footer
    stats = footer["probability_stats"]
    assert stats is not None
    probs = sorted(x["miss_probability"] for x in body_rows)
    assert stats["min"] == round(probs[0], 6)
    assert stats["max"] == round(probs[-1], 6)
    assert stats["mean"] == round(sum(probs) / len(probs), 6)
    n = len(probs)
    p50_idx = max(1, min(n, -(-50 * n // 100))) - 1
    p95_idx = max(1, min(n, -(-95 * n // 100))) - 1
    assert stats["p50"] == round(probs[p50_idx], 6)
    assert stats["p95"] == round(probs[p95_idx], 6)
    assert stats["min"] <= stats["p50"] <= stats["p95"] <= stats["max"]

    # Parity with count_only: same request, same emitted rows, same stats.
    r_count = c.post(
        "/v1/cohort/risk/export",
        params={"count_only": "true"},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_count.status_code == 200
    assert r_count.json()["probability_stats"] == stats


def test_export_footer_probability_stats_null_when_no_rows(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {"synthetic": {"n_users": 20, "n_days": 4, "seed": 7}}

    r = c.post(
        "/v1/cohort/risk/export",
        params={"user_ids": "definitely-not-a-real-user"},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200
    rows = _parse_ndjson(r.content)
    footer = rows[-1]
    assert footer["kind"] == "footer"
    assert footer["emitted"] == 0
    assert footer["probability_stats"] is None


def test_export_footer_includes_tier_cross_tabs(tmp_path, monkeypatch):
    """Streaming consumers get the same (tier x dose_class) and
    (tier x time_bucket) cross-tabs count_only already returns, so a
    staffing manifest can be written from the NDJSON footer without a
    second pass.
    """
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    r = c.post(
        "/v1/cohort/risk/export",
        json={"synthetic": {"n_users": 40, "n_days": 6, "seed": 9}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    rows = _parse_ndjson(r.content)
    body_rows = [x for x in rows if x["kind"] == "row"]
    footer = rows[-1]
    assert footer["kind"] == "footer"
    assert "by_tier_dose_class" in footer
    assert "by_tier_time_bucket" in footer

    expected_dc: dict[str, dict[str, int]] = {}
    expected_tb: dict[str, dict[str, int]] = {}
    for row in body_rows:
        dc = expected_dc.setdefault(
            row["dose_class"], {"low": 0, "medium": 0, "high": 0}
        )
        dc[row["risk_tier"]] += 1
        tb = expected_tb.setdefault(
            row["time_bucket"], {"low": 0, "medium": 0, "high": 0}
        )
        tb[row["risk_tier"]] += 1

    assert footer["by_tier_dose_class"] == {k: expected_dc[k] for k in sorted(expected_dc)}
    assert footer["by_tier_time_bucket"] == {k: expected_tb[k] for k in sorted(expected_tb)}
    # cross-tab keys mirror the flat per-class / per-bucket breakdowns
    assert set(footer["by_tier_dose_class"].keys()) == set(footer["by_dose_class"].keys())
    assert set(footer["by_tier_time_bucket"].keys()) == set(footer["by_time_bucket"].keys())
    # row sums per (class, *) and (bucket, *) reconcile against the flat tallies
    for cls, tiers in footer["by_tier_dose_class"].items():
        assert sum(tiers.values()) == footer["by_dose_class"][cls]
        assert set(tiers.keys()) == {"low", "medium", "high"}
    for bucket, tiers in footer["by_tier_time_bucket"].items():
        assert sum(tiers.values()) == footer["by_time_bucket"][bucket]
        assert set(tiers.keys()) == {"low", "medium", "high"}
    # tier totals across the cross-tab match the flat by_tier counts
    for tier in ("low", "medium", "high"):
        from_dc = sum(t[tier] for t in footer["by_tier_dose_class"].values())
        from_tb = sum(t[tier] for t in footer["by_tier_time_bucket"].values())
        assert from_dc == footer["by_tier"][tier]
        assert from_tb == footer["by_tier"][tier]


def test_export_count_only_and_footer_include_n_users(tmp_path, monkeypatch):
    """count_only response and NDJSON footer should expose the distinct
    post-filter user count so dashboards can size the outreach queue
    (`this band spans N patients`) without paging the full export."""
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {"synthetic": {"n_users": 50, "n_days": 6, "seed": 23}}

    r_stream = c.post(
        "/v1/cohort/risk/export",
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_stream.status_code == 200
    parsed = _parse_ndjson(r_stream.content)
    rows = [x for x in parsed if x["kind"] == "row"]
    footer = parsed[-1]
    expected_users = len({r["user_id"] for r in rows})
    assert "n_users" in footer
    assert footer["n_users"] == expected_users

    r_count = c.post(
        "/v1/cohort/risk/export",
        params={"count_only": "true"},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_count.status_code == 200
    body = r_count.json()
    assert body.get("n_users") == expected_users


def test_export_count_only_n_users_respects_user_filter(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {"synthetic": {"n_users": 40, "n_days": 5, "seed": 11}}

    r = c.post(
        "/v1/cohort/risk/export",
        params={"limit": 500},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    base_rows = [x for x in _parse_ndjson(r.content) if x["kind"] == "row"]
    chosen = sorted({row["user_id"] for row in base_rows})[:3]
    assert len(chosen) == 3

    r_count = c.post(
        "/v1/cohort/risk/export",
        params={"count_only": "true", "user_ids": ",".join(chosen)},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_count.status_code == 200
    body = r_count.json()
    assert body["n_users"] == 3


def test_export_count_only_includes_patient_level_tier_counts(tmp_path, monkeypatch):
    """count_only response should expose n_users_with_high_risk and
    n_users_with_medium_risk so staffing planners can size the patient-level
    outreach queue (one phone call per high-risk patient, not one per dose)
    without paging the full /export. Symmetric with /cohort/risk."""
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    from adherence_common.constants import DEFAULT_RISK_THRESHOLDS

    c = TestClient(create_app())

    payload = {"synthetic": {"n_users": 60, "n_days": 7, "seed": 29}}

    # Stream the full export so we can compute the expected patient-level
    # tier counts from the same rows the count_only path iterates over.
    r_stream = c.post(
        "/v1/cohort/risk/export",
        params={"limit": 100000},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_stream.status_code == 200
    rows = [x for x in _parse_ndjson(r_stream.content) if x["kind"] == "row"]
    high_t = DEFAULT_RISK_THRESHOLDS["high"]
    med_t = DEFAULT_RISK_THRESHOLDS["medium"]
    worst: dict[str, float] = {}
    for r in rows:
        uid = r["user_id"]
        p = float(r["miss_probability"])
        if uid not in worst or p > worst[uid]:
            worst[uid] = p
    expected_high = sum(1 for v in worst.values() if v >= high_t)
    expected_medium = sum(1 for v in worst.values() if med_t <= v < high_t)

    r_count = c.post(
        "/v1/cohort/risk/export",
        params={"count_only": "true"},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_count.status_code == 200
    body = r_count.json()
    assert body["n_users_with_high_risk"] == expected_high
    assert body["n_users_with_medium_risk"] == expected_medium
    # Disjoint: a user with any high-risk dose never lands in the medium
    # bucket, so the two patient-level counts can be summed without
    # double-counting an outreach.
    assert (
        body["n_users_with_high_risk"] + body["n_users_with_medium_risk"]
        <= body["n_users"]
    )


def test_export_min_doses_filters_low_volume_users(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {"synthetic": {"n_users": 40, "n_days": 7, "seed": 13}}

    # Baseline: full cohort, no min_doses filter.
    r_all = c.post(
        "/v1/cohort/risk/export",
        params={"worst_per_user": "true"},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_all.status_code == 200
    rows_all = [x for x in _parse_ndjson(r_all.content) if x["kind"] == "row"]
    users_all = {r["user_id"] for r in rows_all}
    # Per-user dose counts from the underlying scored cohort. Re-stream
    # without dedupe so we can identify which user_ids carry >= min_doses.
    r_full = c.post(
        "/v1/cohort/risk/export",
        json=payload,
        headers={"x-api-key": "svc"},
    )
    full_rows = [x for x in _parse_ndjson(r_full.content) if x["kind"] == "row"]
    dose_counts: dict[str, int] = {}
    for row in full_rows:
        dose_counts[row["user_id"]] = dose_counts.get(row["user_id"], 0) + 1
    # Pick a threshold somewhere between min and max so the filter is observable.
    counts_sorted = sorted(dose_counts.values())
    assert counts_sorted, "expected at least one scoreable dose"
    threshold = counts_sorted[len(counts_sorted) // 2] + 1
    expected_users = {uid for uid, n in dose_counts.items() if n >= threshold}

    r_filt = c.post(
        "/v1/cohort/risk/export",
        params={"worst_per_user": "true", "min_doses": threshold},
        json=payload,
        headers={"x-api-key": "svc"},
    )
    assert r_filt.status_code == 200
    rows_filt = [x for x in _parse_ndjson(r_filt.content) if x["kind"] == "row"]
    users_filt = {r["user_id"] for r in rows_filt}
    assert users_filt == expected_users
    assert users_filt.issubset(users_all)
    # If the threshold actually removed someone, the filtered set must shrink.
    if expected_users != set(dose_counts.keys()):
        assert len(users_filt) < len(users_all)


def test_export_min_doses_404s_when_no_user_qualifies(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    r = c.post(
        "/v1/cohort/risk/export",
        params={"min_doses": 9999},
        json={"synthetic": {"n_users": 20, "n_days": 5, "seed": 4}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 400
    assert "scoreable doses" in r.json()["detail"]
