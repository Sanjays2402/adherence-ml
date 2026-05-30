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
from adherence_common.errors import ModelNotFoundError
from adherence_common.interventions import recommend, summary
from adherence_common.quiet_hours import apply as apply_quiet_hours, from_row as qh_from_row
from adherence_common.schemas import PredictRequest, PredictResponse
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


class InterventionResponse(BaseModel):
    user_id: str
    model_version: str
    predictions: list[dict[str, Any]] = Field(default_factory=list)
    interventions: list[InterventionItem] = Field(default_factory=list)
    summary: dict[str, Any] = Field(default_factory=dict)
    quiet_hours: dict[str, Any] = Field(default_factory=dict)


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
    out_ivs = [InterventionItem(**iv) for iv in iv_dicts]

    audit_record(
        request_id=rid, route="/v1/interventions", user_id=req.user_id,
        caller=caller, caller_role=p.get("role", "service"),
        model_name=model_name, model_version=str(res.get("model_version", "")),
        n_doses=len(preds), latency_ms=(time.perf_counter() - t0) * 1000.0,
        ok=True, predictions=preds,
        extra={"n_interventions": len(out_ivs), "quiet_hours": qh_info},
    )
    return InterventionResponse(
        user_id=req.user_id,
        model_version=str(res.get("model_version", "")),
        predictions=preds,
        interventions=out_ivs,
        summary=summary(ivs),
        quiet_hours=qh_info,
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
