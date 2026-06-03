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

import csv
import io
import random
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import StreamingResponse
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
    include_predictions: bool = Field(
        False,
        description=(
            "If true, the response includes a `predictions` list with one row per "
            "scored dose (dose_id, scheduled_at, miss_probability, risk_tier, "
            "dose_class) sorted by scheduled_at then dose_id, so outreach UIs can "
            "render the full per-dose nudge queue without a follow-up /predict round "
            "trip. Off by default to keep the default payload small."
        ),
    )
    predictions_min_risk_tier: Literal["low", "medium", "high"] | None = Field(
        None,
        description=(
            "Only honored when include_predictions=true. If set to 'medium' or 'high', "
            "the returned `predictions` list is filtered to doses at or above that risk "
            "tier, so an outreach UI can fetch just the nudge queue ('high' = nurse-call "
            "queue, 'medium' = text/nudge queue and above) without iterating low-tier rows "
            "client-side and without inflating the payload with doses the UI will not "
            "render. 'low' or null returns all scored doses (current behavior). The roll-up "
            "aggregates (total_expected_misses, by_day, worst_day, next_dose, etc) are "
            "always computed against the full horizon and are unaffected by this filter."
        ),
    )
    predictions_limit: int | None = Field(
        None,
        ge=1,
        le=1000,
        description=(
            "Only honored when include_predictions=true. If set, the returned "
            "`predictions` list is capped at the top N highest-miss_probability doses "
            "(ties broken by earliest scheduled_at, then dose_id) so an outreach UI can "
            "fetch a fixed-size nudge queue ('top 20 doses to call about today') without "
            "paging the full horizon or sorting client-side. Applied after "
            "predictions_min_risk_tier. When set, the predictions list is sorted by "
            "miss_probability desc instead of the default scheduled_at asc, since the "
            "point of capping is to surface peak severity. `predictions_truncated` in the "
            "response is true iff the cap dropped any rows. Null returns all scored doses "
            "sorted by scheduled_at then dose_id (current behavior). Roll-up aggregates "
            "(total_expected_misses, by_day, worst_day, next_dose, etc) are always "
            "computed against the full horizon and are unaffected by this cap."
        ),
    )


class DosePrediction(BaseModel):
    dose_id: str
    scheduled_at: datetime
    miss_probability: float
    risk_tier: str | None
    dose_class: str | None


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
    total_low_risk_count: int  # count of horizon doses whose risk_tier == 'low' (n_doses_scored - total_high_risk_count - total_medium_risk_count) so outreach planners can render a 'low / medium / high' breakdown ('12 low, 5 medium, 3 high of 20 doses') inline without iterating predictions client-side and without assuming risk_tier is one of three values, 0 only when no doses were scored or every scored dose is medium-or-above, symmetric with total_high_risk_count and total_medium_risk_count
    n_high_risk_days: int  # count of by_day rows whose high_risk_count > 0 so outreach planners can render '3 of the next 7 days have at least one high-risk dose' inline without iterating by_day client-side, 0 only when no horizon day contains a high-risk dose, symmetric with total_high_risk_count (which counts doses, not days)
    n_medium_risk_days: int  # count of by_day rows whose medium_risk_count > 0 so outreach planners can render '5 of the next 7 days have at least one medium-risk dose' inline without iterating by_day client-side, 0 only when no horizon day contains a medium-risk dose, symmetric with n_high_risk_days and total_medium_risk_count
    n_low_risk_days: int  # count of by_day rows whose n_doses > high_risk_count + medium_risk_count (i.e. at least one low-risk dose lives on that day) so outreach planners can render '6 of the next 7 days have only low-risk doses' or size the 'no nudge needed' lane inline without iterating by_day client-side, 0 only when every horizon day's doses are all medium-or-above (or no doses were scored), symmetric with n_high_risk_days and n_medium_risk_days
    worst_day: str | None  # date (YYYY-MM-DD) with the highest expected_misses, ties broken by earliest date; null only if no doses were scored
    worst_day_expected_misses: float  # expected_misses on `worst_day` so the outreach planner can render 'check in Thursday, ~3.2 projected misses' without iterating by_day client-side
    worst_day_n_doses: int  # n_doses on `worst_day` so the outreach planner can render '5 doses on Thursday' (the denominator the projected miss count is drawn from) without iterating by_day client-side, 0 only if no doses were scored
    worst_day_projected_adherence_rate: float  # projected_adherence_rate on `worst_day` so the outreach planner can render '~3.2 projected misses out of 5 doses (64% adherence) on Thursday' inline without iterating by_day client-side, 0.0 only if no doses were scored
    worst_day_high_risk_count: int  # high_risk_count on `worst_day` so the outreach planner can size the nurse-call queue for the peak day ('Thursday: 3 high-risk doses to call about') without iterating by_day client-side, 0 only if no doses were scored
    worst_day_medium_risk_count: int  # medium_risk_count on `worst_day` so the outreach planner can size the second-tier text/nudge queue for the peak day without iterating by_day client-side, 0 only if no doses were scored
    worst_day_days_out: int  # zero-based day offset from the forecast start (starting_at.date()) to `worst_day` so the outreach planner can render 'peak miss day is in 2 days' inline without parsing worst_day vs starting_at client-side and absorbing timezone/DST off-by-ones; 0 means same day as starting_at, -1 only when worst_day is null (no doses scored), symmetric with first_high_risk_day_days_out
    first_high_risk_day: str | None  # earliest date (YYYY-MM-DD) in the horizon whose high_risk_count > 0 so the outreach planner can render 'first high-risk dose is Tuesday, call before then' and schedule the nurse outreach against the upstream calendar day without iterating by_day client-side; null when no horizon day contains a high-risk dose
    first_high_risk_day_high_risk_count: int  # high_risk_count on `first_high_risk_day` so the outreach planner can render 'Tuesday: 3 high-risk doses to call about (first such day)' inline, 0 only if first_high_risk_day is null
    first_high_risk_day_medium_risk_count: int  # medium_risk_count on `first_high_risk_day` so the outreach planner can size the second-tier text/nudge queue for the first escalation day inline ('Tuesday: 3 high-risk plus 2 medium-risk doses') without iterating by_day client-side, 0 only if first_high_risk_day is null, symmetric with worst_day_medium_risk_count
    first_high_risk_day_n_doses: int  # n_doses on `first_high_risk_day` so the outreach planner can render 'Tuesday: 3 of 5 doses are high risk' (the denominator the high_risk_count is drawn from) without iterating by_day client-side, 0 only if first_high_risk_day is null, symmetric with worst_day_n_doses
    first_high_risk_day_projected_adherence_rate: float  # projected_adherence_rate on `first_high_risk_day` so the outreach planner can render '~2.4 projected misses out of 5 doses (52% adherence) on Tuesday, first high-risk day' inline without iterating by_day client-side, 0.0 only if first_high_risk_day is null, symmetric with worst_day_projected_adherence_rate
    first_high_risk_day_expected_misses: float  # expected_misses on `first_high_risk_day` so the outreach planner can render 'first high-risk dose Tuesday, ~2.4 projected misses' inline without iterating by_day client-side to find the first high-risk row, 0.0 only if first_high_risk_day is null, symmetric with worst_day_expected_misses
    first_high_risk_day_days_out: int  # zero-based day offset from the forecast start (starting_at.date()) to `first_high_risk_day` so the outreach planner can render 'first high-risk dose is in 2 days' inline without parsing first_high_risk_day vs starting_at client-side and absorbing timezone/DST off-by-ones; 0 means same day as starting_at, -1 only when first_high_risk_day is null
    next_dose_id: str | None  # dose_id of the earliest upcoming dose in the horizon (earliest scheduled_at, ties broken by dose_id) so outreach UIs can render 'next dose: 21:00 today, high risk (87% miss)' and link the per-dose nudge action without iterating the full by_day/predictions list client-side; null only when no doses were scored
    next_dose_scheduled_at: datetime | None  # scheduled_at of `next_dose_id` (UTC, ISO-8601) so outreach UIs can render the wall-clock time without re-resolving from by_day; null when next_dose_id is null
    next_dose_miss_probability: float  # miss_probability of `next_dose_id` so outreach UIs can render '87% miss' for the next upcoming dose without iterating predictions client-side; 0.0 only when next_dose_id is null
    next_dose_risk_tier: str | None  # risk_tier (low|medium|high) of `next_dose_id` so outreach UIs can color the next-dose badge without iterating predictions client-side; null when next_dose_id is null
    next_dose_dose_class: str | None  # dose_class of `next_dose_id` so outreach UIs can render 'next dose: 21:00, psych 5mg, high risk' inline without iterating predictions client-side to look up the upcoming dose's class; null when next_dose_id is null, symmetric with first_high_risk_dose_dose_class and peak_risk_dose_dose_class
    next_dose_days_out: int  # zero-based day offset from the forecast start (starting_at.date()) to `next_dose_scheduled_at.date()` so outreach UIs can render 'next dose in 0 days' / 'next dose tomorrow' inline without parsing next_dose_scheduled_at vs starting_at client-side and absorbing timezone/DST off-by-ones; 0 means same calendar day as starting_at, -1 only when next_dose_id is null (no doses scored), symmetric with worst_day_days_out and first_high_risk_day_days_out
    first_high_risk_dose_id: str | None  # dose_id of the earliest scheduled dose in the horizon whose risk_tier == 'high' (ties broken by dose_id) so outreach UIs can render 'first high-risk dose: 21:00 Tuesday, psych 5mg (87% miss) - nudge now' and link the per-dose nudge action without iterating predictions client-side to find the first high-tier row; null when no horizon dose is high risk, dose-level analogue of first_high_risk_day and symmetric with next_dose_id
    first_high_risk_dose_scheduled_at: datetime | None  # scheduled_at of `first_high_risk_dose_id` (UTC, ISO-8601) so outreach UIs can render the wall-clock time without re-resolving from predictions; null when first_high_risk_dose_id is null, symmetric with next_dose_scheduled_at
    first_high_risk_dose_miss_probability: float  # miss_probability of `first_high_risk_dose_id` so outreach UIs can render '87% miss' for the first upcoming high-risk dose without iterating predictions client-side; 0.0 only when first_high_risk_dose_id is null, symmetric with next_dose_miss_probability
    first_high_risk_dose_dose_class: str | None  # dose_class of `first_high_risk_dose_id` so outreach UIs can render 'psych dose at 21:00 Tuesday' inline; null when first_high_risk_dose_id is null
    first_high_risk_dose_days_out: int  # zero-based day offset from the forecast start (starting_at.date()) to `first_high_risk_dose_scheduled_at.date()` so outreach UIs can render 'first high-risk dose in 2 days, nudge before then' inline without parsing first_high_risk_dose_scheduled_at vs starting_at client-side and absorbing timezone/DST off-by-ones; 0 means same calendar day as starting_at, -1 only when first_high_risk_dose_id is null (no horizon dose is high risk), symmetric with next_dose_days_out and first_high_risk_day_days_out
    peak_risk_dose_id: str | None  # dose_id of the single highest-miss_probability dose in the horizon (ties broken by earliest scheduled_at, then by dose_id) so outreach UIs can render 'the one dose to absolutely nudge: 21:00 Tuesday psych 5mg (94% miss)' without iterating predictions client-side to find the peak; null only when no doses were scored, dose-level analogue of worst_day (which points at peak miss volume per day) and symmetric with first_high_risk_dose_id (which is the earliest high-tier dose, not the peak)
    peak_risk_dose_scheduled_at: datetime | None  # scheduled_at of `peak_risk_dose_id` (UTC, ISO-8601) so outreach UIs can render the wall-clock time of the peak-severity dose inline; null when peak_risk_dose_id is null, symmetric with next_dose_scheduled_at and first_high_risk_dose_scheduled_at
    peak_risk_dose_miss_probability: float  # miss_probability of `peak_risk_dose_id` so outreach UIs can render '94% miss' for the peak-severity dose without iterating predictions client-side; 0.0 only when peak_risk_dose_id is null, symmetric with next_dose_miss_probability and first_high_risk_dose_miss_probability
    peak_risk_dose_risk_tier: str | None  # risk_tier (low|medium|high) of `peak_risk_dose_id` so outreach UIs can color the peak-dose badge without iterating predictions client-side; null when peak_risk_dose_id is null, symmetric with next_dose_risk_tier
    peak_risk_dose_dose_class: str | None  # dose_class of `peak_risk_dose_id` so outreach UIs can render 'psych dose at 21:00 Tuesday' inline; null when peak_risk_dose_id is null, symmetric with first_high_risk_dose_dose_class
    peak_risk_dose_days_out: int  # zero-based day offset from the forecast start (starting_at.date()) to `peak_risk_dose_scheduled_at.date()` so outreach UIs can render 'peak-risk dose in 2 days, nudge before then' inline without parsing peak_risk_dose_scheduled_at vs starting_at client-side and absorbing timezone/DST off-by-ones; 0 means same calendar day as starting_at, -1 only when peak_risk_dose_id is null, symmetric with next_dose_days_out and first_high_risk_dose_days_out
    by_day: list[DailyForecast]
    predictions: list[DosePrediction] | None = None  # per-dose predictions, populated only when the request sets include_predictions=true; sorted by scheduled_at then dose_id by default, or by miss_probability desc (ties: earliest scheduled_at, then dose_id) when predictions_limit is set
    predictions_truncated: bool = False  # true iff predictions_limit was set and at least one dose was dropped from the returned list (after any predictions_min_risk_tier filter), so outreach UIs know to surface 'showing top N of M' without recomputing the eligible count client-side; always false when predictions is null or predictions_limit is null
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
            # Skip dose times that already passed at the moment the forecast
            # was requested. Otherwise a call at noon would include this
            # morning's 08:00 dose in the projection and pollute day-zero
            # adherence with an event the user can no longer act on.
            if sched_dt < start:
                continue
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
    next_dose_id: str | None = None
    next_dose_scheduled_at: datetime | None = None
    next_dose_miss_probability = 0.0
    next_dose_risk_tier: str | None = None
    next_dose_dose_class: str | None = None
    first_high_risk_dose_id: str | None = None
    first_high_risk_dose_scheduled_at: datetime | None = None
    first_high_risk_dose_miss_probability = 0.0
    first_high_risk_dose_dose_class: str | None = None
    peak_risk_dose_id: str | None = None
    peak_risk_dose_scheduled_at: datetime | None = None
    peak_risk_dose_miss_probability = 0.0
    peak_risk_dose_risk_tier: str | None = None
    peak_risk_dose_dose_class: str | None = None
    for p in preds:
        sched_at = p["scheduled_at"]
        if isinstance(sched_at, str):
            sched_at = datetime.fromisoformat(sched_at.replace("Z", "+00:00"))
        if sched_at.tzinfo is None:
            sched_at = sched_at.replace(tzinfo=timezone.utc)
        date_str = sched_at.date().isoformat()
        by_day[date_str].append(p)
        all_probs.append(float(p["miss_probability"]))
        # Earliest upcoming dose, ties broken by dose_id for determinism.
        pid = str(p.get("dose_id", ""))
        if next_dose_scheduled_at is None or sched_at < next_dose_scheduled_at or (
            sched_at == next_dose_scheduled_at and pid < (next_dose_id or "")
        ):
            next_dose_scheduled_at = sched_at
            next_dose_id = pid
            next_dose_miss_probability = float(p["miss_probability"])
            next_dose_risk_tier = p.get("risk_tier")
            next_dose_dose_class = p.get("dose_class")
        # Earliest high-risk dose in the horizon, ties broken by dose_id.
        # Dose-level analogue of first_high_risk_day so outreach UIs can
        # link the per-dose nudge action without iterating predictions.
        if p.get("risk_tier") == "high" and (
            first_high_risk_dose_scheduled_at is None
            or sched_at < first_high_risk_dose_scheduled_at
            or (
                sched_at == first_high_risk_dose_scheduled_at
                and pid < (first_high_risk_dose_id or "")
            )
        ):
            first_high_risk_dose_scheduled_at = sched_at
            first_high_risk_dose_id = pid
            first_high_risk_dose_miss_probability = float(p["miss_probability"])
            first_high_risk_dose_dose_class = p.get("dose_class")
        # Peak-severity dose: single highest miss_probability across the
        # horizon. Ties broken by earliest scheduled_at, then by dose_id, so
        # the pointer is deterministic across runs. Dose-level analogue of
        # worst_day (peak miss volume per day).
        miss_p = float(p["miss_probability"])
        if (
            peak_risk_dose_id is None
            or miss_p > peak_risk_dose_miss_probability
            or (
                miss_p == peak_risk_dose_miss_probability
                and sched_at < (peak_risk_dose_scheduled_at or sched_at)
            )
            or (
                miss_p == peak_risk_dose_miss_probability
                and sched_at == peak_risk_dose_scheduled_at
                and pid < (peak_risk_dose_id or "")
            )
        ):
            peak_risk_dose_id = pid
            peak_risk_dose_scheduled_at = sched_at
            peak_risk_dose_miss_probability = miss_p
            peak_risk_dose_risk_tier = p.get("risk_tier")
            peak_risk_dose_dose_class = p.get("dose_class")

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
    worst_day_days_out = -1
    first_high_risk_day: str | None = None
    first_high_risk_day_high_risk_count = 0
    first_high_risk_day_medium_risk_count = 0
    first_high_risk_day_n_doses = 0
    first_high_risk_day_projected_adherence_rate = 0.0
    first_high_risk_day_expected_misses = 0.0
    first_high_risk_day_days_out = -1
    n_high_risk_days = 0
    n_medium_risk_days = 0
    n_low_risk_days = 0
    start_date = start.date()
    for d in daily:
        if d.high_risk_count > 0:
            n_high_risk_days += 1
        if d.medium_risk_count > 0:
            n_medium_risk_days += 1
        if d.n_doses - d.high_risk_count - d.medium_risk_count > 0:
            n_low_risk_days += 1
        if worst_day is None or d.expected_misses > worst_day_expected_misses:
            worst_day = d.date
            worst_day_expected_misses = d.expected_misses
            worst_day_n_doses = d.n_doses
            worst_day_projected_adherence_rate = d.projected_adherence_rate
            worst_day_high_risk_count = d.high_risk_count
            worst_day_medium_risk_count = d.medium_risk_count
            worst_day_days_out = (
                datetime.fromisoformat(d.date).date() - start_date
            ).days
        if first_high_risk_day is None and d.high_risk_count > 0:
            first_high_risk_day = d.date
            first_high_risk_day_high_risk_count = d.high_risk_count
            first_high_risk_day_medium_risk_count = d.medium_risk_count
            first_high_risk_day_n_doses = d.n_doses
            first_high_risk_day_projected_adherence_rate = d.projected_adherence_rate
            first_high_risk_day_expected_misses = d.expected_misses
            first_high_risk_day_days_out = (
                datetime.fromisoformat(d.date).date() - start_date
            ).days

    # Build the per-dose predictions list (only when the caller asked for it).
    # Steps: filter by predictions_min_risk_tier, then either sort by
    # (scheduled_at, dose_id) asc (default) or by miss_probability desc with
    # (scheduled_at, dose_id) tiebreakers when predictions_limit is set, then
    # cap at predictions_limit. predictions_truncated tells the UI whether the
    # cap dropped any rows so it can render 'showing top N of M'.
    predictions_out: list[DosePrediction] | None = None
    predictions_truncated = False
    if req.include_predictions:
        def _filter_ok(row: dict[str, Any]) -> bool:
            tier = row.get("risk_tier")
            mrt = req.predictions_min_risk_tier
            if mrt is None or mrt == "low":
                return True
            if mrt == "medium":
                return tier in ("medium", "high")
            return tier == "high"

        filtered: list[DosePrediction] = []
        for p in preds:
            if not _filter_ok(p):
                continue
            raw_sched = p["scheduled_at"]
            if isinstance(raw_sched, str):
                sched = datetime.fromisoformat(raw_sched.replace("Z", "+00:00"))
            elif raw_sched.tzinfo is None:
                sched = raw_sched.replace(tzinfo=timezone.utc)
            else:
                sched = raw_sched
            filtered.append(DosePrediction(
                dose_id=str(p.get("dose_id", "")),
                scheduled_at=sched,
                miss_probability=float(p["miss_probability"]),
                risk_tier=p.get("risk_tier"),
                dose_class=p.get("dose_class"),
            ))
        if req.predictions_limit is not None:
            filtered.sort(key=lambda d: (-d.miss_probability, d.scheduled_at, d.dose_id))
            if len(filtered) > req.predictions_limit:
                predictions_truncated = True
                filtered = filtered[: req.predictions_limit]
        else:
            filtered.sort(key=lambda d: (d.scheduled_at, d.dose_id))
        predictions_out = filtered

    next_dose_days_out = (
        (next_dose_scheduled_at.date() - start_date).days
        if next_dose_scheduled_at is not None
        else -1
    )
    first_high_risk_dose_days_out = (
        (first_high_risk_dose_scheduled_at.date() - start_date).days
        if first_high_risk_dose_scheduled_at is not None
        else -1
    )
    peak_risk_dose_days_out = (
        (peak_risk_dose_scheduled_at.date() - start_date).days
        if peak_risk_dose_scheduled_at is not None
        else -1
    )

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
        total_low_risk_count=max(0, len(preds) - total_high - total_medium),
        n_high_risk_days=n_high_risk_days,
        n_medium_risk_days=n_medium_risk_days,
        n_low_risk_days=n_low_risk_days,
        worst_day=worst_day,
        worst_day_expected_misses=worst_day_expected_misses,
        worst_day_n_doses=worst_day_n_doses,
        worst_day_projected_adherence_rate=worst_day_projected_adherence_rate,
        worst_day_high_risk_count=worst_day_high_risk_count,
        worst_day_medium_risk_count=worst_day_medium_risk_count,
        worst_day_days_out=worst_day_days_out,
        first_high_risk_day=first_high_risk_day,
        first_high_risk_day_high_risk_count=first_high_risk_day_high_risk_count,
        first_high_risk_day_medium_risk_count=first_high_risk_day_medium_risk_count,
        first_high_risk_day_n_doses=first_high_risk_day_n_doses,
        first_high_risk_day_projected_adherence_rate=first_high_risk_day_projected_adherence_rate,
        first_high_risk_day_expected_misses=first_high_risk_day_expected_misses,
        first_high_risk_day_days_out=first_high_risk_day_days_out,
        next_dose_id=next_dose_id,
        next_dose_scheduled_at=next_dose_scheduled_at,
        next_dose_miss_probability=next_dose_miss_probability,
        next_dose_risk_tier=next_dose_risk_tier,
        next_dose_dose_class=next_dose_dose_class,
        next_dose_days_out=next_dose_days_out,
        first_high_risk_dose_id=first_high_risk_dose_id,
        first_high_risk_dose_scheduled_at=first_high_risk_dose_scheduled_at,
        first_high_risk_dose_miss_probability=first_high_risk_dose_miss_probability,
        first_high_risk_dose_dose_class=first_high_risk_dose_dose_class,
        first_high_risk_dose_days_out=first_high_risk_dose_days_out,
        peak_risk_dose_id=peak_risk_dose_id,
        peak_risk_dose_scheduled_at=peak_risk_dose_scheduled_at,
        peak_risk_dose_miss_probability=peak_risk_dose_miss_probability,
        peak_risk_dose_risk_tier=peak_risk_dose_risk_tier,
        peak_risk_dose_dose_class=peak_risk_dose_dose_class,
        peak_risk_dose_days_out=peak_risk_dose_days_out,
        by_day=daily,
        predictions=predictions_out,
        predictions_truncated=predictions_truncated,
        schedule_source=source,
    )


@router.post("/user.csv")
def forecast_user_csv(
    req: ForecastRequest,
    response: Response,
    model_name: str = "default",
    _p=Depends(require_service),
) -> StreamingResponse:
    """Per-dose forecast as CSV for nurse call-list / nudge-queue export.

    Same request body as POST /v1/forecast/user. Returns one row per scored
    dose with the fields outreach UIs and care-manager spreadsheets actually
    need: dose_id, scheduled_at (ISO-8601 UTC), days_out (zero-based offset
    from starting_at), miss_probability (rounded to 4 dp), risk_tier,
    dose_class. Honors predictions_min_risk_tier (filter to nurse-call /
    text-nudge queues) and predictions_limit (cap at top-N by
    miss_probability desc, tie-broken by earliest scheduled_at then dose_id);
    when no limit is set rows are sorted by (scheduled_at, dose_id) so the
    file reads as a chronological call list. include_predictions on the
    request body is ignored (CSV is always the per-dose list).
    """
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
    mrt = req.predictions_min_risk_tier

    def _filter_ok(row: dict[str, Any]) -> bool:
        tier = row.get("risk_tier")
        if mrt is None or mrt == "low":
            return True
        if mrt == "medium":
            return tier in ("medium", "high")
        return tier == "high"

    start_date = start.date()
    rows: list[tuple[str, datetime, int, float, str, str]] = []
    for p in preds:
        if not _filter_ok(p):
            continue
        raw_sched = p["scheduled_at"]
        if isinstance(raw_sched, str):
            sched = datetime.fromisoformat(raw_sched.replace("Z", "+00:00"))
        elif raw_sched.tzinfo is None:
            sched = raw_sched.replace(tzinfo=timezone.utc)
        else:
            sched = raw_sched
        miss_p = float(p["miss_probability"])
        rows.append((
            str(p.get("dose_id", "")),
            sched,
            (sched.date() - start_date).days,
            miss_p,
            str(p.get("risk_tier") or ""),
            str(p.get("dose_class") or ""),
        ))

    truncated = False
    if req.predictions_limit is not None:
        rows.sort(key=lambda r: (-r[3], r[1], r[0]))
        if len(rows) > req.predictions_limit:
            truncated = True
            rows = rows[: req.predictions_limit]
    else:
        rows.sort(key=lambda r: (r[1], r[0]))

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([
        "dose_id",
        "scheduled_at",
        "days_out",
        "miss_probability",
        "risk_tier",
        "dose_class",
    ])
    for dose_id, sched, days_out, miss_p, tier, dose_class in rows:
        w.writerow([
            dose_id,
            sched.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            days_out,
            f"{miss_p:.4f}",
            tier,
            dose_class,
        ])
    body = buf.getvalue()

    filename = (
        f"forecast_{req.user_id}_{start.strftime('%Y%m%dT%H%M%SZ')}"
        f"_h{req.horizon_days}.csv"
    )
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "X-Row-Count": str(len(rows)),
        "X-Schedule-Source": source,
        "X-Predictions-Truncated": "true" if truncated else "false",
        "X-Model-Name": model_name,
        "X-Model-Version": str(res.get("model_version", "")),
    }
    return StreamingResponse(
        iter([body]),
        media_type="text/csv",
        headers=headers,
    )
