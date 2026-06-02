"""/cohort endpoints: population-level adherence risk aggregations.

Useful for clinical dashboards / population health teams who need to know
*who* is most at risk and *when*. Operates on a caller-supplied event
history (or a synthetic sample for demos).
"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from adherence_api.deps import require_service
from adherence_common.constants import DEFAULT_RISK_THRESHOLDS, DOSE_CLASSES, TIME_BUCKETS
from adherence_common.errors import ModelNotFoundError
from adherence_common.logging import get_logger
from adherence_data import SyntheticConfig, generate_events
from adherence_features.engineering import build_training_frame
from adherence_models.registry import ModelRegistry

router = APIRouter(prefix="/v1/cohort", tags=["cohort"])
log = get_logger(__name__)


class CohortBucket(BaseModel):
    key: str
    n_doses: int
    mean_miss_probability: float
    pct_high_risk: float
    pct_medium_risk: float


class ProbabilityStats(BaseModel):
    min: float
    max: float
    mean: float
    p50: float
    p95: float


class TierCounts(BaseModel):
    low: int
    medium: int
    high: int


class CohortRiskResponse(BaseModel):
    model_name: str
    model_version: str
    total_doses: int
    overall_mean_risk: float
    probability_stats: ProbabilityStats = Field(
        description=(
            "Dose-level miss_probability distribution across the full cohort "
            "(min/max/mean/p50/p95). Lets dashboards size risk bands and pick "
            "thresholds without pulling every row via /export."
        )
    )
    by_tier: TierCounts = Field(
        description=(
            "Dose counts per risk tier (low/medium/high) using DEFAULT_RISK_THRESHOLDS. "
            "Lets dashboards size outreach queues without paging the full cohort via /export."
        )
    )
    by_tier_dose_class: dict[str, TierCounts] = Field(
        default_factory=dict,
        description=(
            "Cross-tab of dose counts per (dose_class -> tier) using DEFAULT_RISK_THRESHOLDS. "
            "Mirrors the cohort_export count_only / NDJSON footer so dashboards can size "
            "severity mix per class (e.g. high-risk insulin doses) without paging /export."
        ),
    )
    by_tier_time_bucket: dict[str, TierCounts] = Field(
        default_factory=dict,
        description=(
            "Cross-tab of dose counts per (time_bucket -> tier) using DEFAULT_RISK_THRESHOLDS. "
            "Mirrors the cohort_export count_only / NDJSON footer so dashboards can size "
            "severity mix per bucket (e.g. high-risk evening doses) without paging /export."
        ),
    )
    by_dose_class: list[CohortBucket]
    by_time_bucket: list[CohortBucket]
    top_users: list[CohortBucket] = Field(
        description="Users sorted by mean miss probability (highest first)."
    )


def _bucket(df: pd.DataFrame, group_col: str, decode: dict[int, str] | None = None) -> list[CohortBucket]:
    out: list[CohortBucket] = []
    high = DEFAULT_RISK_THRESHOLDS["high"]
    med = DEFAULT_RISK_THRESHOLDS["medium"]
    for key, g in df.groupby(group_col):
        n = int(len(g))
        if n == 0:
            continue
        p = g["miss_probability"].to_numpy(dtype=float)
        label = decode[int(key)] if decode is not None else str(key)
        out.append(
            CohortBucket(
                key=label,
                n_doses=n,
                mean_miss_probability=float(np.mean(p)),
                pct_high_risk=float((p >= high).mean()),
                pct_medium_risk=float(((p >= med) & (p < high)).mean()),
            )
        )
    out.sort(key=lambda b: b.mean_miss_probability, reverse=True)
    return out


@router.post("/risk", response_model=CohortRiskResponse)
def cohort_risk(
    payload: dict[str, Any] = Body(default_factory=dict),
    model_name: str = Query("default"),
    top_users: int = Query(10, ge=1, le=100),
    min_doses: int = Query(
        1,
        ge=1,
        le=10_000,
        description=(
            "Minimum dose count required for a user to appear in top_users. "
            "Filters out low-volume users whose mean risk is statistically noisy "
            "(e.g. one missed dose at p=0.99 dominating the leaderboard)."
        ),
    ),
    _p=Depends(require_service),
) -> CohortRiskResponse:
    """Aggregate miss-risk over a cohort.

    payload may include:
      events: list of DoseEvent dicts (used as the cohort).
      synthetic: {"n_users": int, "n_days": int, "seed": int} to generate.
    If neither is provided, defaults to a small synthetic cohort.
    """
    try:
        art, model = ModelRegistry().latest(model_name)
    except ModelNotFoundError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc))

    events_payload = payload.get("events")
    if events_payload:
        events = pd.DataFrame(events_payload)
        events["scheduled_at"] = pd.to_datetime(events["scheduled_at"], utc=True, errors="coerce")
        if "taken_at" in events.columns:
            events["taken_at"] = pd.to_datetime(events["taken_at"], utc=True, errors="coerce")
    else:
        cfg = payload.get("synthetic", {}) or {}
        events = generate_events(
            SyntheticConfig(
                n_users=int(cfg.get("n_users", 300)),
                n_days=int(cfg.get("n_days", 14)),
                seed=int(cfg.get("seed", 11)),
            )
        )

    df = build_training_frame(events)
    if df.empty:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "no scoreable doses in cohort")

    X = df[model.feature_columns]
    df = df.copy()
    df["miss_probability"] = model.predict_proba(X)

    class_decode = {i: c for i, c in enumerate(DOSE_CLASSES)}
    bucket_decode = {i: b for i, b in enumerate(TIME_BUCKETS)}

    by_class = _bucket(df, "dose_class_idx", class_decode)
    by_time = _bucket(df, "time_bucket_idx", bucket_decode)

    # Per-user aggregation
    user_rows: list[CohortBucket] = []
    high = DEFAULT_RISK_THRESHOLDS["high"]
    med = DEFAULT_RISK_THRESHOLDS["medium"]
    for uid, g in df.groupby("user_id"):
        n = int(len(g))
        if n < min_doses:
            continue
        p = g["miss_probability"].to_numpy(dtype=float)
        user_rows.append(
            CohortBucket(
                key=str(uid),
                n_doses=n,
                mean_miss_probability=float(np.mean(p)),
                pct_high_risk=float((p >= high).mean()),
                pct_medium_risk=float(((p >= med) & (p < high)).mean()),
            )
        )
    user_rows.sort(key=lambda b: b.mean_miss_probability, reverse=True)

    probs = df["miss_probability"].to_numpy(dtype=float)
    stats = ProbabilityStats(
        min=float(np.min(probs)),
        max=float(np.max(probs)),
        mean=float(np.mean(probs)),
        p50=float(np.percentile(probs, 50)),
        p95=float(np.percentile(probs, 95)),
    )
    tier_counts = TierCounts(
        low=int((probs < med).sum()),
        medium=int(((probs >= med) & (probs < high)).sum()),
        high=int((probs >= high).sum()),
    )

    # Cross-tabs of tier per (dose_class) and per (time_bucket) mirror the
    # cohort_export count_only / NDJSON footer so dashboards can size severity
    # mix per (class, bucket) without a second pass via /export.
    def _tier_counts(group: pd.DataFrame) -> TierCounts:
        gp = group["miss_probability"].to_numpy(dtype=float)
        return TierCounts(
            low=int((gp < med).sum()),
            medium=int(((gp >= med) & (gp < high)).sum()),
            high=int((gp >= high).sum()),
        )

    by_tier_dose_class = {
        class_decode[int(k)]: _tier_counts(g)
        for k, g in df.groupby("dose_class_idx")
    }
    by_tier_dose_class = dict(sorted(by_tier_dose_class.items()))
    by_tier_time_bucket = {
        bucket_decode[int(k)]: _tier_counts(g)
        for k, g in df.groupby("time_bucket_idx")
    }
    by_tier_time_bucket = dict(sorted(by_tier_time_bucket.items()))

    return CohortRiskResponse(
        model_name=model_name,
        model_version=art.version,
        total_doses=int(len(df)),
        overall_mean_risk=float(df["miss_probability"].mean()),
        probability_stats=stats,
        by_tier=tier_counts,
        by_tier_dose_class=by_tier_dose_class,
        by_tier_time_bucket=by_tier_time_bucket,
        by_dose_class=by_class,
        by_time_bucket=by_time,
        top_users=user_rows[:top_users],
    )
