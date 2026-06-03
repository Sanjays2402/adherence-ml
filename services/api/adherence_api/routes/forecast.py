"""/v1/forecast/user: N-day projected adherence rate per user.

Given a user's recent dose history plus an upcoming schedule (or a
schedule auto-derived from the history's typical daily times), score
each upcoming dose and roll up daily projected adherence. Also reports
a bootstrap 90% confidence interval on the overall projected adherence
rate so callers can show uncertainty bands.

Adherence rate = 1 - mean(miss_probability) over scored doses for that
day (or the whole horizon).
"""
from __future__ import annotations

import random
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field

from adherence_api.deps import require_service
from adherence_api.quota_enforce import enforce_prediction_quota
from adherence_common.errors import ModelNotFoundError
from adherence_common.schemas import DoseEvent, ScheduledDose
from adherence_worker.inference import predict_doses

router = APIRouter(prefix="/v1/forecast", tags=["forecast"])


class ForecastRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str = Field(..., min_length=1, max_length=64)
    history: list[DoseEvent] = Field(
        default_factory=list,
        description="Past dose events. Required to derive a forecast schedule if none is supplied.",
    )
    schedule: list[ScheduledDose] | None = Field(
        None,
        description=(
            "Explicit forecast schedule. If omitted, the endpoint derives one "
            "from the typical scheduled hours observed in `history`."
        ),
    )
    horizon_days: int = Field(7, ge=1, le=30)
    starting_at: datetime | None = Field(
        None, description="UTC start of the forecast window (defaults to now)."
    )
    bootstrap_iterations: int = Field(200, ge=0, le=2000)
    seed: int = Field(11, ge=0)


class DailyForecast(BaseModel):
    date: str
    n_doses: int
    mean_miss_probability: float
    projected_adherence_rate: float
    expected_misses: float  # sum of miss_probability across the day's doses
    high_risk_count: int
    medium_risk_count: int


class ForecastResponse(BaseModel):
    user_id: str
    model_name: str
    model_version: str
    horizon_days: int
    n_doses_scored: int
    overall_projected_adherence_rate: float
    overall_adherence_ci_low: float
    overall_adherence_ci_high: float
    total_expected_misses: float  # sum of miss_probability across the full horizon
    total_high_risk_count: int
    total_medium_risk_count: int
    worst_day: str | None  # date (YYYY-MM-DD) with the highest expected_misses, ties broken by earliest date; null only if no doses were scored
    worst_day_expected_misses: float  # expected_misses on `worst_day` so the outreach planner can render 'check in Thursday, ~3.2 projected misses' without iterating by_day client-side
    worst_day_n_doses: int  # n_doses on `worst_day` so the outreach planner can render '5 doses on Thursday' (the denominator the projected miss count is drawn from) without iterating by_day client-side, 0 only if no doses were scored
    worst_day_projected_adherence_rate: float  # projected_adherence_rate on `worst_day` so the outreach planner can render '~3.2 projected misses out of 5 doses (64% adherence) on Thursday' inline without iterating by_day client-side, 0.0 only if no doses were scored
    worst_day_high_risk_count: int  # high_risk_count on `worst_day` so the outreach planner can size the nurse-call queue for the peak day ('Thursday: 3 high-risk doses to call about') without iterating by_day client-side, 0 only if no doses were scored
    worst_day_medium_risk_count: int  # medium_risk_count on `worst_day` so the outreach planner can size the second-tier text/nudge queue for the peak day without iterating by_day client-side, 0 only if no doses were scored
    by_day: list[DailyForecast]
    schedule_source: str  # "supplied" | "derived"


def _derive_schedule(
    history: list[DoseEvent],
    *,
    start: datetime,
    horizon_days: int,
) -> list[ScheduledDose]:
    """Build a forecast schedule by repeating the typical (hour, dose_class,
    strength) triples seen in the user's recent history across the horizon.

    Pulls the *unique* (hour, dose_class, strength) combinations from the
    most recent 14 days of history; if the user takes the same dose at
    08:00 cardio and 21:00 psych daily, the forecast schedule contains
    those two doses per day for ``horizon_days``.
    """
    if not history:
        return []
    cutoff = start - timedelta(days=14)
    recent = [h for h in history if h.scheduled_at >= cutoff]
    if not recent:
        recent = history[-30:]
    # Deduplicate by (hour, minute, dose_class, strength).
    seen: dict[tuple[int, int, str, float], None] = {}
    for h in recent:
        key = (
            h.scheduled_at.hour,
            h.scheduled_at.minute,
            h.dose_class,
            float(h.dose_strength_mg),
        )
        seen.setdefault(key, None)
    if not seen:
        return []
    out: list[ScheduledDose] = []
    start_date = start.date()
    for day_offset in range(horizon_days):
        date = start_date + timedelta(days=day_offset)
        for idx, (hour, minute, dose_class, strength) in enumerate(sorted(seen)):
            sched_dt = datetime(
                date.year, date.month, date.day, hour, minute,
                tzinfo=timezone.utc,
            )
            out.append(ScheduledDose(
                dose_id=f"fc-{day_offset:02d}-{idx:02d}",
                scheduled_at=sched_dt,
                dose_class=dose_class,
                dose_strength_mg=strength,
            ))
    return out


def _bootstrap_ci(
    probs: list[float], *, iterations: int, seed: int,
) -> tuple[float, float]:
    """Return (low, high) 90% bootstrap CI on mean adherence rate."""
    if not probs or iterations == 0:
        if not probs:
            return (0.0, 0.0)
        rate = 1.0 - sum(probs) / len(probs)
        return (rate, rate)
    rng = random.Random(seed)
    n = len(probs)
    samples: list[float] = []
    for _ in range(iterations):
        draws = [probs[rng.randrange(n)] for _ in range(n)]
        samples.append(1.0 - sum(draws) / n)
    samples.sort()
    lo = samples[int(0.05 * len(samples))]
    hi = samples[int(0.95 * len(samples)) - 1 if len(samples) > 1 else 0]
    return (lo, hi)


@router.post("/user", response_model=ForecastResponse)
def forecast_user(
    req: ForecastRequest,
    response: Response,
    model_name: str = "default",
    _p=Depends(require_service),
) -> ForecastResponse:
    start = req.starting_at or datetime.now(timezone.utc)
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)

    if req.schedule is not None:
        schedule = list(req.schedule)
        source = "supplied"
    else:
        schedule = _derive_schedule(req.history, start=start, horizon_days=req.horizon_days)
        source = "derived"

    if not schedule:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=(
                "no forecast schedule available; supply `schedule` explicitly "
                "or include enough `history` to derive typical dose times"
            ),
        )

    # Charge the workspace quota for every dose we are about to score.
    enforce_prediction_quota(
        _p.get("tenant", "default"), response, cost=max(1, len(schedule)),
    )

    history_df = None
    if req.history:
        history_df = pd.DataFrame([h.model_dump() for h in req.history])

    try:
        res = predict_doses(
            req.user_id,
            [s.model_dump() for s in schedule],
            history_df,
            model_name=model_name,
            top_k=0,
        )
    except ModelNotFoundError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc))

    preds = res.get("predictions", [])
    by_day: dict[str, list[dict[str, Any]]] = defaultdict(list)
    all_probs: list[float] = []
    for p in preds:
        sched_at = p["scheduled_at"]
        if isinstance(sched_at, str):
            sched_at = datetime.fromisoformat(sched_at.replace("Z", "+00:00"))
        date_str = sched_at.date().isoformat()
        by_day[date_str].append(p)
        all_probs.append(float(p["miss_probability"]))

    daily: list[DailyForecast] = []
    total_high = 0
    total_medium = 0
    for date_str in sorted(by_day):
        rows = by_day[date_str]
        probs = [float(r["miss_probability"]) for r in rows]
        mean_miss = sum(probs) / len(probs)
        day_high = sum(1 for r in rows if r.get("risk_tier") == "high")
        day_medium = sum(1 for r in rows if r.get("risk_tier") == "medium")
        total_high += day_high
        total_medium += day_medium
        daily.append(DailyForecast(
            date=date_str,
            n_doses=len(rows),
            mean_miss_probability=mean_miss,
            projected_adherence_rate=1.0 - mean_miss,
            expected_misses=sum(probs),
            high_risk_count=day_high,
            medium_risk_count=day_medium,
        ))

    overall_mean_miss = sum(all_probs) / len(all_probs) if all_probs else 0.0
    lo, hi = _bootstrap_ci(all_probs, iterations=req.bootstrap_iterations, seed=req.seed)

    # Peak-day pointer for outreach planners: which calendar day in the
    # horizon has the highest projected miss volume? Ties go to the earliest
    # date so the queue is deterministic across runs.
    worst_day: str | None = None
    worst_day_expected_misses = 0.0
    worst_day_n_doses = 0
    worst_day_projected_adherence_rate = 0.0
    worst_day_high_risk_count = 0
    worst_day_medium_risk_count = 0
    for d in daily:
        if worst_day is None or d.expected_misses > worst_day_expected_misses:
            worst_day = d.date
            worst_day_expected_misses = d.expected_misses
            worst_day_n_doses = d.n_doses
            worst_day_projected_adherence_rate = d.projected_adherence_rate
            worst_day_high_risk_count = d.high_risk_count
            worst_day_medium_risk_count = d.medium_risk_count

    return ForecastResponse(
        user_id=req.user_id,
        model_name=model_name,
        model_version=str(res.get("model_version", "")),
        horizon_days=req.horizon_days,
        n_doses_scored=len(preds),
        overall_projected_adherence_rate=1.0 - overall_mean_miss,
        overall_adherence_ci_low=lo,
        overall_adherence_ci_high=hi,
        total_expected_misses=sum(all_probs),
        total_high_risk_count=total_high,
        total_medium_risk_count=total_medium,
        worst_day=worst_day,
        worst_day_expected_misses=worst_day_expected_misses,
        worst_day_n_doses=worst_day_n_doses,
        worst_day_projected_adherence_rate=worst_day_projected_adherence_rate,
        worst_day_high_risk_count=worst_day_high_risk_count,
        worst_day_medium_risk_count=worst_day_medium_risk_count,
        by_day=daily,
        schedule_source=source,
    )
