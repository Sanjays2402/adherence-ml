"""/predict endpoints (sync inference)."""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import current_principal, require_service
from adherence_common.audit import record as audit_record
from adherence_common.errors import ModelNotFoundError
from adherence_common.prom import PREDICTIONS, SHADOW_DIVERGENCE
from adherence_common.schemas import PredictRequest, PredictResponse
from adherence_worker.inference import predict_doses

router = APIRouter(prefix="/v1", tags=["predict"])


def _max_divergence(a: list[dict], b: list[dict]) -> float | None:
    """Max |p_a - p_b| across matching dose_ids. None if no overlap."""
    by_id_b = {x.get("dose_id"): float(x.get("miss_probability", 0.0)) for x in b}
    diffs = [
        abs(float(x.get("miss_probability", 0.0)) - by_id_b[x.get("dose_id")])
        for x in a if x.get("dose_id") in by_id_b
    ]
    return max(diffs) if diffs else None


def _caller_id(request: Request, principal: dict[str, str]) -> str:
    api_key = request.headers.get("x-api-key")
    if api_key:
        import hashlib
        return "k:" + hashlib.sha256(api_key.encode()).hexdigest()[:16]
    if principal.get("sub"):
        return "j:" + str(principal["sub"])[:30]
    return "i:" + (request.client.host if request.client else "unknown")


@router.post("/predict", response_model=PredictResponse)
def predict(
    req: PredictRequest,
    request: Request,
    model_name: str = Query("default"),
    shadow: str | None = Query(
        None,
        description=(
            "Optional challenger model name. When set, the request is also "
            "scored with this model; the response still comes from `model_name`, "
            "but per-dose divergence (|p_primary - p_shadow|) is written to the "
            "audit log for safe rollout evaluation."
        ),
    ),
    p=Depends(require_service),
) -> PredictResponse:
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
            req.user_id,
            sched,
            history,
            model_name=model_name,
            top_k=req.top_k_reasons,
        )
        shadow_version: str | None = None
        shadow_div: float | None = None
        if shadow and shadow != model_name:
            try:
                shadow_res = predict_doses(
                    req.user_id, sched, history,
                    model_name=shadow, top_k=0,
                )
                shadow_version = str(shadow_res.get("model_version", ""))
                shadow_div = _max_divergence(
                    res.get("predictions", []),
                    shadow_res.get("predictions", []),
                )
            except Exception as exc:  # shadow must never break the primary path
                shadow_version = f"error:{type(exc).__name__}"
                shadow_div = None
        dt = (time.perf_counter() - t0) * 1000.0
        for pred in res.get("predictions", []):
            PREDICTIONS.inc(model=model_name,
                            tier=str(pred.get("risk_tier", "unknown")))
        if shadow and shadow != model_name and shadow_div is not None:
            SHADOW_DIVERGENCE.observe(shadow_div, shadow_model=shadow)
        audit_record(
            request_id=rid, route="/v1/predict", user_id=req.user_id,
            caller=caller, caller_role=p.get("role", "service"),
            model_name=model_name, model_version=str(res.get("model_version", "")),
            shadow_model_name=shadow if shadow and shadow != model_name else None,
            shadow_model_version=shadow_version,
            shadow_max_divergence=shadow_div,
            n_doses=len(res.get("predictions", [])),
            latency_ms=dt, ok=True, predictions=res.get("predictions", []),
        )
        return PredictResponse(**res)
    except ModelNotFoundError as exc:
        dt = (time.perf_counter() - t0) * 1000.0
        audit_record(
            request_id=rid, route="/v1/predict", user_id=req.user_id,
            caller=caller, caller_role=p.get("role", "service"),
            model_name=model_name, model_version="",
            n_doses=len(req.schedule), latency_ms=dt, ok=False, error=str(exc),
        )
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
    request: Request,
    model_name: str = Query("default"),
    p=Depends(require_service),
) -> BatchPredictResponse:
    """Score upcoming doses for many users in one call.

    Designed for Med-Tracker's nightly cron: send {items: [PredictRequest, ...]}
    and get back per-user predictions + reason codes. Errors are isolated to
    the offending user (the batch keeps going).
    """
    import pandas as pd

    rid = getattr(request.state, "request_id", "")
    caller = _caller_id(request, p)
    role = p.get("role", "service")

    try:
        from adherence_worker.inference import load_model
        art, _model, _explainer = load_model(model_name)
    except ModelNotFoundError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))

    results: list[BatchPredictItem] = []
    n_ok = 0
    for item in req.items:
        t0 = time.perf_counter()
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
            audit_record(
                request_id=rid, route="/v1/predict/batch", user_id=item.user_id,
                caller=caller, caller_role=role,
                model_name=model_name, model_version=str(res.get("model_version", "")),
                n_doses=len(res.get("predictions", [])),
                latency_ms=(time.perf_counter() - t0) * 1000.0,
                ok=True, predictions=res.get("predictions", []),
            )
        except Exception as exc:
            results.append(
                BatchPredictItem(user_id=item.user_id, ok=False, error=str(exc))
            )
            audit_record(
                request_id=rid, route="/v1/predict/batch", user_id=item.user_id,
                caller=caller, caller_role=role,
                model_name=model_name, model_version=str(art.version),
                n_doses=len(item.schedule),
                latency_ms=(time.perf_counter() - t0) * 1000.0,
                ok=False, error=str(exc),
            )

    return BatchPredictResponse(
        model_version=art.version,
        n_users=len(req.items),
        n_ok=n_ok,
        n_failed=len(req.items) - n_ok,
        results=results,
    )
