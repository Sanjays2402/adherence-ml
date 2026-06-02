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
