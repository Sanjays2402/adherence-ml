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
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from adherence_api.deps import require_service
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
    high_risk_count: int


class ForecastResponse(BaseModel):
    user_id: str
    model_name: str
    model_version: str
    horizon_days: int
    n_doses_scored: int
    overall_projected_adherence_rate: float
    overall_adherence_ci_low: float
    overall_adherence_ci_high: float
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
    for date_str in sorted(by_day):
        rows = by_day[date_str]
        probs = [float(r["miss_probability"]) for r in rows]
        mean_miss = sum(probs) / len(probs)
        daily.append(DailyForecast(
            date=date_str,
            n_doses=len(rows),
            mean_miss_probability=mean_miss,
            projected_adherence_rate=1.0 - mean_miss,
            high_risk_count=sum(1 for r in rows if r.get("risk_tier") == "high"),
        ))

    overall_mean_miss = sum(all_probs) / len(all_probs) if all_probs else 0.0
    lo, hi = _bootstrap_ci(all_probs, iterations=req.bootstrap_iterations, seed=req.seed)

    return ForecastResponse(
        user_id=req.user_id,
        model_name=model_name,
        model_version=str(res.get("model_version", "")),
        horizon_days=req.horizon_days,
        n_doses_scored=len(preds),
        overall_projected_adherence_rate=1.0 - overall_mean_miss,
        overall_adherence_ci_low=lo,
        overall_adherence_ci_high=hi,
        by_day=daily,
        schedule_source=source,
    )
