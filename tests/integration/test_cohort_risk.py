"""Tests for /v1/cohort/risk aggregation response."""
from __future__ import annotations

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


def test_cohort_risk_buckets_include_n_high_risk(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    client = TestClient(create_app())

    r = client.post(
        "/v1/cohort/risk",
        params={"top_users": 5},
        json={"synthetic": {"n_users": 40, "n_days": 7, "seed": 1}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    body = r.json()

    # by_tier.high (overall) must equal the sum of n_high_risk across the
    # per-class breakdown and the per-bucket breakdown (every dose lands in
    # exactly one class and exactly one bucket).
    overall_high = body["by_tier"]["high"]
    assert sum(b["n_high_risk"] for b in body["by_dose_class"]) == overall_high
    assert sum(b["n_high_risk"] for b in body["by_time_bucket"]) == overall_high

    # User counts let dashboards show 'Top N of M' without paging /export.
    # With default min_doses=1, every user with any scored dose is eligible,
    # so n_users_eligible == n_users_total. top_users is bounded by the
    # requested page size and by the eligible pool.
    assert body["n_users_total"] >= 1
    assert body["n_users_eligible"] == body["n_users_total"]
    assert len(body["top_users"]) == min(5, body["n_users_eligible"])

    # A high min_doses must shrink (or hold) n_users_eligible but never
    # change n_users_total, since the cohort itself is unchanged.
    r2 = client.post(
        "/v1/cohort/risk",
        params={"top_users": 5, "min_doses": 9999},
        json={"synthetic": {"n_users": 40, "n_days": 7, "seed": 1}},
        headers={"x-api-key": "svc"},
    )
    assert r2.status_code == 200, r2.text
    body2 = r2.json()
    assert body2["n_users_total"] == body["n_users_total"]
    assert body2["n_users_eligible"] <= body["n_users_eligible"]
    assert len(body2["top_users"]) == body2["n_users_eligible"]

    # Per-bucket invariants: n_high_risk is bounded by n_doses and is
    # consistent with pct_high_risk (no floating-point drift beyond 1 dose).
    for bucket in (
        body["by_dose_class"]
        + body["by_time_bucket"]
        + body["top_users"]
    ):
        n = bucket["n_doses"]
        nh = bucket["n_high_risk"]
        assert 0 <= nh <= n
        assert abs(nh - round(n * bucket["pct_high_risk"])) <= 1


def test_cohort_risk_n_users_with_high_risk(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    client = TestClient(create_app())

    r = client.post(
        "/v1/cohort/risk",
        params={"top_users": 100},
        json={"synthetic": {"n_users": 40, "n_days": 7, "seed": 1}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    body = r.json()

    # n_users_with_high_risk is the distinct patient count for the
    # outreach queue: bounded by total users, and bounded above by the
    # raw high-risk dose count (cannot have more affected patients than
    # high-risk doses).
    n_hr_users = body["n_users_with_high_risk"]
    assert 0 <= n_hr_users <= body["n_users_total"]
    assert n_hr_users <= body["by_tier"]["high"]

    # And it matches the count of top_users rows with n_high_risk >= 1
    # (top_users covers every eligible user when the page size is large
    # enough, and min_doses defaults to 1).
    users_with_hr_in_top = sum(
        1 for u in body["top_users"] if u["n_high_risk"] >= 1
    )
    assert users_with_hr_in_top == n_hr_users

    # n_users_with_medium_risk is the disjoint patient-level second-tier
    # queue: medium-tier patients with no high-tier doses. Bounded by total
    # users, disjoint from the high-risk patient queue (so the two sum
    # without double-counting), and matches the count of top_users rows
    # whose max-risk dose lands in the medium band (n_high_risk == 0 and
    # n_medium_risk >= 1).
    n_med_users = body["n_users_with_medium_risk"]
    assert 0 <= n_med_users <= body["n_users_total"]
    assert n_med_users + n_hr_users <= body["n_users_total"]
    users_med_only_in_top = sum(
        1
        for u in body["top_users"]
        if u["n_high_risk"] == 0 and u["n_medium_risk"] >= 1
    )
    assert users_med_only_in_top == n_med_users


def test_cohort_risk_buckets_include_n_medium_risk(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    client = TestClient(create_app())

    r = client.post(
        "/v1/cohort/risk",
        params={"top_users": 100},
        json={"synthetic": {"n_users": 40, "n_days": 7, "seed": 1}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    body = r.json()

    # by_tier.medium (overall) must equal the sum of n_medium_risk across
    # the per-class breakdown and the per-bucket breakdown (every dose
    # lands in exactly one class and exactly one bucket).
    overall_medium = body["by_tier"]["medium"]
    assert sum(b["n_medium_risk"] for b in body["by_dose_class"]) == overall_medium
    assert sum(b["n_medium_risk"] for b in body["by_time_bucket"]) == overall_medium

    # Per-bucket invariants: n_medium_risk is bounded by n_doses,
    # disjoint from n_high_risk (combined cannot exceed total), and
    # consistent with pct_medium_risk (no float drift beyond 1 dose).
    for bucket in (
        body["by_dose_class"]
        + body["by_time_bucket"]
        + body["top_users"]
    ):
        n = bucket["n_doses"]
        nm = bucket["n_medium_risk"]
        nh = bucket["n_high_risk"]
        assert 0 <= nm <= n
        assert nm + nh <= n
        assert abs(nm - round(n * bucket["pct_medium_risk"])) <= 1


def test_cohort_risk_top_users_sort_by_n_high_risk(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    client = TestClient(create_app())

    r = client.post(
        "/v1/cohort/risk",
        params={"top_users": 50, "sort_by": "n_high_risk"},
        json={"synthetic": {"n_users": 40, "n_days": 7, "seed": 5}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    top = body["top_users"]
    assert top, "expected at least one eligible user"

    # n_high_risk descends; ties break on mean_miss_probability descending
    # so the leaderboard is stable for staffing planners.
    for a, b in zip(top, top[1:]):
        assert (a["n_high_risk"], a["mean_miss_probability"]) >= (
            b["n_high_risk"],
            b["mean_miss_probability"],
        )


def test_cohort_risk_rejects_unknown_sort_by(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    client = TestClient(create_app())

    r = client.post(
        "/v1/cohort/risk",
        params={"sort_by": "nonsense"},
        json={"synthetic": {"n_users": 10, "n_days": 5, "seed": 2}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 422
