"""/v1/interventions: recommend actions given a PredictRequest.

Internally runs predict_doses then maps the result through the
intervention recommender. Returns predictions + ranked interventions so
clients don't need two round-trips.
"""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import require_admin, require_service
from adherence_api.routes.predict import _caller_id  # reuse identity helper
from adherence_common.audit import record as audit_record
from adherence_common import deliveries as deliveries_mod
from adherence_common import outbound as outbound_mod
from adherence_common.errors import ModelNotFoundError
from adherence_common.interventions import recommend, summary
from adherence_common import mutes as mutes_mod
from adherence_common import prom as prom_metrics
from adherence_common.quiet_hours import apply as apply_quiet_hours, from_row as qh_from_row
from adherence_common.schemas import PredictRequest, PredictResponse
from adherence_common.settings import get_settings
from adherence_worker.inference import predict_doses

router = APIRouter(prefix="/v1", tags=["interventions"])


class InterventionItem(BaseModel):
    action: str
    score: float
    target_dose_ids: list[str]
    reason: str
    channel: str
    lead_time_minutes: int
    deferred_until: str | None = None
    deferred_reason: str | None = None
    delivery_id: int | None = None
    suppressed: bool = False
    suppress_reason: str | None = None


class BudgetInfo(BaseModel):
    daily_limit: int
    used: int
    remaining: int
    exhausted: bool


class MuteInfo(BaseModel):
    active: bool
    muted_until: str | None = None
    reason: str | None = None


class InterventionResponse(BaseModel):
    user_id: str
    model_version: str
    predictions: list[dict[str, Any]] = Field(default_factory=list)
    interventions: list[InterventionItem] = Field(default_factory=list)
    summary: dict[str, Any] = Field(default_factory=dict)
    quiet_hours: dict[str, Any] = Field(default_factory=dict)
    budget: BudgetInfo | None = None
    mute: MuteInfo | None = None
    cooldown_suppressed: list[dict[str, Any]] = Field(default_factory=list)


@router.post("/interventions", response_model=InterventionResponse)
def interventions_endpoint(
    req: PredictRequest,
    request: Request,
    model_name: str = Query("default"),
    max_actions: int = Query(5, ge=1, le=10),
    respect_quiet_hours: bool = Query(
        True,
        description="If True and the user has a QuietHoursPolicy, suppress or defer interventions whose fire time falls inside the quiet window.",
    ),
    p=Depends(require_service),
) -> InterventionResponse:
    t0 = time.perf_counter()
    rid = getattr(request.state, "request_id", "")
    caller = _caller_id(request, p)
    try:
        import pandas as pd
        history = None
        if req.history:
            history = pd.DataFrame([h.model_dump() for h in req.history])
        sched = [s.model_dump() for s in req.schedule]
        res = predict_doses(
            req.user_id, sched, history,
            model_name=model_name, top_k=req.top_k_reasons,
        )
    except ModelNotFoundError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))

    preds = res.get("predictions", [])
    # enrich with dose_class from the request schedule for class-aware actions
    class_by_id = {s.dose_id: s.dose_class for s in req.schedule}
    enriched = [{**p, "dose_class": class_by_id.get(p.get("dose_id"), "other")} for p in preds]

    ivs = recommend(enriched, max_actions=max_actions)
    iv_dicts = [iv.to_dict() for iv in ivs]

    # User mute -- a TTL opt-out that suppresses *all* delivery without
    # affecting predictions. We still surface the would-be actions so the
    # caller can render "3 actions held while user is muted" UI.
    mute_state = mutes_mod.is_muted(req.user_id)
    mute_block: MuteInfo | None = None
    if mute_state is not None:
        mute_block = MuteInfo(
            active=True,
            muted_until=mute_state.muted_until.isoformat(),
            reason=mute_state.reason,
        )
        for iv in iv_dicts:
            iv["suppressed"] = True
            iv["suppress_reason"] = "user_muted"
            prom_metrics.INTERVENTIONS_MUTE_SUPPRESSED.inc(
                action=iv.get("action", ""),
            )
    qh_info: dict[str, Any] = {"applied": False}
    if respect_quiet_hours:
        from sqlalchemy import select
        from adherence_common.db import QuietHoursPolicy, init_db, session
        init_db()
        with session() as s:
            qh_row = s.execute(
                select(QuietHoursPolicy)
                .where(QuietHoursPolicy.user_id == req.user_id)
            ).scalar_one_or_none()
        if qh_row is not None:
            dose_times = {ss.dose_id: ss.scheduled_at.isoformat() for ss in req.schedule}
            iv_dicts, qh_info = apply_quiet_hours(
                iv_dicts, qh_from_row(qh_row), dose_times=dose_times,
            )
    # Cooldown + budget enforcement -----------------------------------------
    settings = get_settings()
    cooldown_min = settings.intervention_cooldown_minutes
    suppressed_until = deliveries_mod.recent_actions(req.user_id, cooldown_min)
    used_today = deliveries_mod.count_today(req.user_id)
    # Lookup per-user override of daily limit; missing => default.
    daily_limit = settings.notification_default_daily_limit
    try:
        from sqlalchemy import select as _sel
        from adherence_common.db import NotificationBudget, init_db as _init, session as _sess
        _init()
        with _sess() as s:
            nb = s.execute(
                _sel(NotificationBudget).where(NotificationBudget.user_id == req.user_id)
            ).scalar_one_or_none()
            if nb is not None:
                daily_limit = int(nb.daily_limit)
    except Exception:  # pragma: no cover
        pass

    cooldown_dropped: list[dict[str, Any]] = []
    remaining_budget = max(0, daily_limit - used_today)
    surviving: list[dict[str, Any]] = []
    for iv in iv_dicts:
        action = iv.get("action", "")
        # Already deferred (e.g. by quiet hours) still counts as surfaced; keep.
        until = suppressed_until.get(action)
        if until is not None and not iv.get("deferred_reason"):
            cooldown_dropped.append({
                "action": action,
                "target_dose_ids": iv.get("target_dose_ids", []),
                "suppress_until": until.isoformat(),
            })
            prom_metrics.INTERVENTIONS_COOLDOWN_SUPPRESSED.inc(action=action)
            continue
        surviving.append(iv)

    # Apply budget. Quiet-hours-deferred items still surface but consume no
    # budget (they'll fire later in the allowed window).
    budget_consuming = [iv for iv in surviving if not iv.get("deferred_reason")]
    over_budget = max(0, len(budget_consuming) - remaining_budget)
    if over_budget > 0:
        # Mark the lowest-score ones as budget-deferred (sort ascending).
        idxs = sorted(
            (i for i, iv in enumerate(surviving) if not iv.get("deferred_reason")),
            key=lambda i: surviving[i].get("score", 0.0),
        )
        for i in idxs[:over_budget]:
            surviving[i] = {
                **surviving[i],
                "deferred_until": None,
                "deferred_reason": "budget_exhausted",
                "suppressed": True,
                "suppress_reason": "budget_exhausted",
            }
            prom_metrics.INTERVENTIONS_BUDGET_SUPPRESSED.inc(
                action=surviving[i].get("action", ""),
            )

    # Persist deliveries for the non-suppressed (or only deferred) actions.
    to_persist = [
        iv for iv in surviving
        if not iv.get("suppressed")
    ]
    delivery_ids = deliveries_mod.record_many(
        request_id=rid, user_id=req.user_id, interventions=to_persist,
    )
    di = iter(delivery_ids)
    for iv in surviving:
        if iv.get("suppressed"):
            continue
        try:
            iv["delivery_id"] = next(di)
        except StopIteration:
            break

    for iv in surviving:
        prom_metrics.INTERVENTIONS_RECOMMENDED.inc(
            action=iv.get("action", ""), channel=iv.get("channel", ""),
        )

    iv_dicts = surviving
    out_ivs = [InterventionItem(**iv) for iv in iv_dicts]

    final_used = used_today + sum(
        1 for iv in iv_dicts
        if not iv.get("suppressed") and not iv.get("deferred_reason")
    )
    budget_block = BudgetInfo(
        daily_limit=daily_limit,
        used=final_used,
        remaining=max(0, daily_limit - final_used),
        exhausted=final_used >= daily_limit,
    )

    audit_record(
        request_id=rid, route="/v1/interventions", user_id=req.user_id,
        caller=caller, caller_role=p.get("role", "service"),
        model_name=model_name, model_version=str(res.get("model_version", "")),
        n_doses=len(preds), latency_ms=(time.perf_counter() - t0) * 1000.0,
        ok=True, predictions=preds,
        extra={"n_interventions": len(out_ivs), "quiet_hours": qh_info},
    )
    # Fan out high-risk actions to outbound webhook subscribers (best-effort).
    high_actions = [
        iv for iv in iv_dicts
        if not iv.get("suppressed") and not iv.get("deferred_reason")
        and float(iv.get("score", 0.0)) >= 0.75
    ]
    if high_actions:
        try:
            outbound_mod.dispatch(
                "intervention.high_risk",
                {
                    "user_id": req.user_id,
                    "request_id": rid,
                    "model_version": str(res.get("model_version", "")),
                    "actions": high_actions,
                },
            )
        except Exception:  # pragma: no cover - never block request path
            pass

    return InterventionResponse(
        user_id=req.user_id,
        model_version=str(res.get("model_version", "")),
        predictions=preds,
        interventions=out_ivs,
        summary=summary(ivs),
        quiet_hours=qh_info,
        budget=budget_block,
        mute=mute_block,
        cooldown_suppressed=cooldown_dropped,
    )


# Stateless variant for clients that already have predictions and just want
# the recommendation layer (e.g. replay/backfill, A/B comparison).
class PredictionsIn(BaseModel):
    user_id: str
    model_version: str | None = None
    predictions: list[dict[str, Any]]


@router.post("/interventions/from-predictions", response_model=InterventionResponse)
def from_predictions(
    body: PredictionsIn,
    request: Request,
    max_actions: int = Query(5, ge=1, le=10),
    p=Depends(require_service),
) -> InterventionResponse:
    ivs = recommend(body.predictions, max_actions=max_actions)
    return InterventionResponse(
        user_id=body.user_id,
        model_version=body.model_version or "",
        predictions=body.predictions,
        interventions=[InterventionItem(**iv.to_dict()) for iv in ivs],
        summary=summary(ivs),
    )


# Quiet-hours admin endpoints --------------------------------------------

class QuietHoursIn(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=64)
    tz: str = Field("UTC", max_length=64)
    start_hour: int = Field(..., ge=0, le=23)
    end_hour: int = Field(..., ge=0, le=23)
    allowed_channels: list[str] = Field(default_factory=list,
        description="Channels permitted during the quiet window (e.g. ['email']).")


class QuietHoursOut(BaseModel):
    id: int
    user_id: str
    tz: str
    start_hour: int
    end_hour: int
    allowed_channels: list[str]
    updated_at: str


@router.put("/policies/quiet-hours", response_model=QuietHoursOut, tags=["policies"])
def quiet_hours_upsert(body: QuietHoursIn, p=Depends(require_admin)):
    if body.start_hour == body.end_hour:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail="start_hour must differ from end_hour")
    from datetime import datetime
    from sqlalchemy import select
    from adherence_common.db import QuietHoursPolicy, init_db, session
    init_db()
    csv = ",".join(sorted({c.strip().lower() for c in body.allowed_channels if c.strip()}))
    with session() as s:
        row = s.execute(select(QuietHoursPolicy).where(QuietHoursPolicy.user_id == body.user_id)).scalar_one_or_none()
        if row is None:
            row = QuietHoursPolicy(
                user_id=body.user_id, tz=body.tz,
                start_hour=body.start_hour, end_hour=body.end_hour,
                allowed_channels_csv=csv, updated_at=datetime.utcnow(),
            )
            s.add(row)
        else:
            row.tz = body.tz
            row.start_hour = body.start_hour
            row.end_hour = body.end_hour
            row.allowed_channels_csv = csv
            row.updated_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return QuietHoursOut(
            id=row.id, user_id=row.user_id, tz=row.tz,
            start_hour=row.start_hour, end_hour=row.end_hour,
            allowed_channels=[c for c in (row.allowed_channels_csv or "").split(",") if c],
            updated_at=row.updated_at.isoformat(),
        )


@router.get("/policies/quiet-hours/{user_id}", response_model=QuietHoursOut, tags=["policies"])
def quiet_hours_get(user_id: str, p=Depends(require_admin)):
    from sqlalchemy import select
    from adherence_common.db import QuietHoursPolicy, init_db, session
    init_db()
    with session() as s:
        row = s.execute(select(QuietHoursPolicy).where(QuietHoursPolicy.user_id == user_id)).scalar_one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no policy for user")
    return QuietHoursOut(
        id=row.id, user_id=row.user_id, tz=row.tz,
        start_hour=row.start_hour, end_hour=row.end_hour,
        allowed_channels=[c for c in (row.allowed_channels_csv or "").split(",") if c],
        updated_at=row.updated_at.isoformat(),
    )


@router.delete("/policies/quiet-hours/{user_id}", tags=["policies"])
def quiet_hours_delete(user_id: str, p=Depends(require_admin)):
    from sqlalchemy import delete as _del
    from adherence_common.db import QuietHoursPolicy, init_db, session
    init_db()
    with session() as s:
        res = s.execute(_del(QuietHoursPolicy).where(QuietHoursPolicy.user_id == user_id))
        s.commit()
    if res.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no policy for user")
    return {"deleted": True, "user_id": user_id}


# Ack endpoints --------------------------------------------------------------

class AckIn(BaseModel):
    state: str = Field(..., description="One of: sent, snoozed, dismissed, acted")
    note: str | None = Field(None, max_length=512)
    snooze_minutes: int | None = Field(None, ge=1, le=24 * 60)


class AckOut(BaseModel):
    id: int
    state: str
    action: str
    user_id: str
    snooze_until: str | None
    acked_by: str | None
    updated_at: str


@router.post("/interventions/{delivery_id}/ack", response_model=AckOut)
def ack_delivery(
    delivery_id: int,
    body: AckIn,
    request: Request,
    p=Depends(require_service),
) -> AckOut:
    if body.state not in {"sent", "snoozed", "dismissed", "acted"}:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="state must be one of: sent, snoozed, dismissed, acted",
        )
    caller = _caller_id(request, p)
    try:
        row = deliveries_mod.ack(
            delivery_id,
            body.state,
            acked_by=caller,
            note=body.note,
            snooze_minutes=body.snooze_minutes,
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc))
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="delivery not found")
    prom_metrics.INTERVENTIONS_ACKED.inc(action=row.action, state=row.state)
    return AckOut(
        id=row.id,
        state=row.state,
        action=row.action,
        user_id=row.user_id,
        snooze_until=row.snooze_until.isoformat() if row.snooze_until else None,
        acked_by=row.acked_by,
        updated_at=row.updated_at.isoformat(),
    )


class DeliveryOut(BaseModel):
    id: int
    request_id: str
    user_id: str
    action: str
    channel: str
    score: float
    target_dose_ids: list[str]
    reason: str | None
    state: str
    snooze_until: str | None
    acked_by: str | None
    created_at: str
    updated_at: str


@router.get("/interventions/deliveries/{user_id}", response_model=list[DeliveryOut])
def list_deliveries(
    user_id: str,
    limit: int = Query(50, ge=1, le=500),
    state: str | None = Query(None),
    p=Depends(require_admin),
) -> list[DeliveryOut]:
    from sqlalchemy import select
    from adherence_common.db import InterventionDelivery, init_db, session
    init_db()
    with session() as s:
        q = (
            select(InterventionDelivery)
            .where(InterventionDelivery.user_id == user_id)
            .order_by(InterventionDelivery.id.desc())
            .limit(limit)
        )
        if state:
            q = q.where(InterventionDelivery.state == state)
        rows = list(s.scalars(q))
    return [
        DeliveryOut(
            id=r.id, request_id=r.request_id, user_id=r.user_id,
            action=r.action, channel=r.channel, score=r.score,
            target_dose_ids=[t for t in (r.target_dose_ids_csv or "").split(",") if t],
            reason=r.reason, state=r.state,
            snooze_until=r.snooze_until.isoformat() if r.snooze_until else None,
            acked_by=r.acked_by,
            created_at=r.created_at.isoformat(),
            updated_at=r.updated_at.isoformat(),
        )
        for r in rows
    ]


# Notification budget admin --------------------------------------------------

class BudgetIn(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=64)
    daily_limit: int = Field(..., ge=0, le=200)
    note: str | None = Field(None, max_length=512)


class BudgetOut(BaseModel):
    user_id: str
    daily_limit: int
    note: str | None
    updated_by: str | None
    updated_at: str


@router.put("/policies/notification-budget", response_model=BudgetOut, tags=["policies"])
def budget_upsert(body: BudgetIn, request: Request, p=Depends(require_admin)) -> BudgetOut:
    from datetime import datetime
    from sqlalchemy import select
    from adherence_common.db import NotificationBudget, init_db, session
    init_db()
    caller = _caller_id(request, p)
    with session() as s:
        row = s.execute(
            select(NotificationBudget).where(NotificationBudget.user_id == body.user_id)
        ).scalar_one_or_none()
        if row is None:
            row = NotificationBudget(
                user_id=body.user_id, daily_limit=body.daily_limit,
                note=body.note, updated_by=caller, updated_at=datetime.utcnow(),
            )
            s.add(row)
        else:
            row.daily_limit = body.daily_limit
            row.note = body.note
            row.updated_by = caller
            row.updated_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
    return BudgetOut(
        user_id=row.user_id, daily_limit=row.daily_limit, note=row.note,
        updated_by=row.updated_by,
        updated_at=row.updated_at.isoformat(),
    )


@router.get("/policies/notification-budget/{user_id}", response_model=BudgetOut, tags=["policies"])
def budget_get(user_id: str, p=Depends(require_admin)) -> BudgetOut:
    from sqlalchemy import select
    from adherence_common.db import NotificationBudget, init_db, session
    init_db()
    with session() as s:
        row = s.execute(
            select(NotificationBudget).where(NotificationBudget.user_id == user_id)
        ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no budget for user")
    return BudgetOut(
        user_id=row.user_id, daily_limit=row.daily_limit, note=row.note,
        updated_by=row.updated_by,
        updated_at=row.updated_at.isoformat(),
    )


@router.delete("/policies/notification-budget/{user_id}", tags=["policies"])
def budget_delete(user_id: str, p=Depends(require_admin)):
    from sqlalchemy import delete as _del
    from adherence_common.db import NotificationBudget, init_db, session
    init_db()
    with session() as s:
        res = s.execute(_del(NotificationBudget).where(NotificationBudget.user_id == user_id))
        s.commit()
    if res.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no budget for user")
    return {"deleted": True, "user_id": user_id}


# Operational endpoints ------------------------------------------------------

class DeliveryStatsOut(BaseModel):
    window_hours: int
    total: int
    by_state: dict[str, int]
    by_action: dict[str, int]
    unique_users: int


@router.get("/interventions/stats", response_model=DeliveryStatsOut, tags=["interventions"])
def deliveries_stats(
    window_hours: int = Query(24, ge=1, le=24 * 30),
    p=Depends(require_admin),
) -> DeliveryStatsOut:
    return DeliveryStatsOut(**deliveries_mod.stats(window_hours))


class ExpireOut(BaseModel):
    max_age_minutes: int
    expired: int


@router.post("/interventions/expire", response_model=ExpireOut, tags=["interventions"])
def deliveries_expire(
    max_age_minutes: int | None = Query(
        None,
        ge=1, le=7 * 24 * 60,
        description="Override the configured max age (default: ADHERENCE_INTERVENTION_MAX_AGE_MINUTES).",
    ),
    p=Depends(require_admin),
) -> ExpireOut:
    age = max_age_minutes or get_settings().intervention_max_age_minutes
    n = deliveries_mod.expire_stale(age)
    return ExpireOut(max_age_minutes=age, expired=n)
