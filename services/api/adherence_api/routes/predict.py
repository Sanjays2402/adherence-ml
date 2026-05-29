"""/predict endpoint (sync inference)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status

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
