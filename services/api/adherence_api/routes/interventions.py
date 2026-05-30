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

from adherence_api.deps import require_service
from adherence_api.routes.predict import _caller_id  # reuse identity helper
from adherence_common.audit import record as audit_record
from adherence_common.errors import ModelNotFoundError
from adherence_common.interventions import recommend, summary
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


class InterventionResponse(BaseModel):
    user_id: str
    model_version: str
    predictions: list[dict[str, Any]] = Field(default_factory=list)
    interventions: list[InterventionItem] = Field(default_factory=list)
    summary: dict[str, Any] = Field(default_factory=dict)


@router.post("/interventions", response_model=InterventionResponse)
def interventions_endpoint(
    req: PredictRequest,
    request: Request,
    model_name: str = Query("default"),
    max_actions: int = Query(5, ge=1, le=10),
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
    out_ivs = [InterventionItem(**iv.to_dict()) for iv in ivs]

    audit_record(
        request_id=rid, route="/v1/interventions", user_id=req.user_id,
        caller=caller, caller_role=p.get("role", "service"),
        model_name=model_name, model_version=str(res.get("model_version", "")),
        n_doses=len(preds), latency_ms=(time.perf_counter() - t0) * 1000.0,
        ok=True, predictions=preds,
        extra={"n_interventions": len(out_ivs)},
    )
    return InterventionResponse(
        user_id=req.user_id,
        model_version=str(res.get("model_version", "")),
        predictions=preds,
        interventions=out_ivs,
        summary=summary(ivs),
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
