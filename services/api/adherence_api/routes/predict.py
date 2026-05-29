"""/predict endpoints (sync inference)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from adherence_api.deps import require_service
from adherence_common.errors import ModelNotFoundError
from adherence_common.schemas import PredictRequest, PredictResponse
from adherence_worker.inference import predict_doses

router = APIRouter(prefix="/v1", tags=["predict"])


@router.post("/predict", response_model=PredictResponse)
def predict(
    req: PredictRequest,
    model_name: str = Query("default"),
    _p=Depends(require_service),
) -> PredictResponse:
    try:
        import pandas as pd
        history = None
        if req.history:
            history = pd.DataFrame([h.model_dump() for h in req.history])
        sched = [s.model_dump() for s in req.schedule]
        res = predict_doses(
            req.user_id,
            sched,
            history,
            model_name=model_name,
            top_k=req.top_k_reasons,
        )
        return PredictResponse(**res)
    except ModelNotFoundError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))


class BatchPredictRequest(BaseModel):
    items: list[PredictRequest] = Field(
        ..., min_length=1, max_length=2000,
        description="One PredictRequest per user. Capped at 2000 per call.",
    )


class BatchPredictItem(BaseModel):
    user_id: str
    ok: bool
    response: PredictResponse | None = None
    error: str | None = None


class BatchPredictResponse(BaseModel):
    model_version: str | None
    n_users: int
    n_ok: int
    n_failed: int
    results: list[BatchPredictItem]


@router.post("/predict/batch", response_model=BatchPredictResponse)
def predict_batch(
    req: BatchPredictRequest,
    model_name: str = Query("default"),
    _p=Depends(require_service),
) -> BatchPredictResponse:
    """Score upcoming doses for many users in one call.

    Designed for Med-Tracker's nightly cron: send {items: [PredictRequest, ...]}
    and get back per-user predictions + reason codes. Errors are isolated to
    the offending user (the batch keeps going).
    """
    import pandas as pd

    # Validate model up-front so we fail fast if the registry is empty.
    try:
        from adherence_worker.inference import load_model
        art, _model, _explainer = load_model(model_name)
    except ModelNotFoundError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))

    results: list[BatchPredictItem] = []
    n_ok = 0
    for item in req.items:
        try:
            history = None
            if item.history:
                history = pd.DataFrame([h.model_dump() for h in item.history])
            sched = [s.model_dump() for s in item.schedule]
            res = predict_doses(
                item.user_id, sched, history,
                model_name=model_name, top_k=item.top_k_reasons,
            )
            results.append(
                BatchPredictItem(
                    user_id=item.user_id, ok=True,
                    response=PredictResponse(**res),
                )
            )
            n_ok += 1
        except Exception as exc:  # isolate per-user failures
            results.append(
                BatchPredictItem(user_id=item.user_id, ok=False, error=str(exc))
            )

    return BatchPredictResponse(
        model_version=art.version,
        n_users=len(req.items),
        n_ok=n_ok,
        n_failed=len(req.items) - n_ok,
        results=results,
    )
