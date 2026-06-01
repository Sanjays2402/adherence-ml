"""/predict endpoints (sync inference)."""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Header, Query, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from adherence_api.deps import current_principal, require_service
from adherence_api.quota_enforce import enforce_prediction_quota
from adherence_common.audit import record as audit_record
from adherence_common.admin_audit import record_admin_action
from adherence_common.errors import ModelNotFoundError
from adherence_common import model_approval as model_approval_mod
from adherence_common.idempotency import (
    IdempotencyConflict,
    hash_body,
    lookup as idem_lookup,
    store as idem_store,
)
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
    response: Response,
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
    idempotency_key: str | None = Header(
        None, alias="Idempotency-Key",
        description=(
            "Optional client-supplied key (max 128 chars). Replays within the"
            " TTL (default 24h) return the original cached response without"
            " re-running the model. Reusing a key with a different payload"
            " returns HTTP 409."
        ),
    ),
    p=Depends(require_service),
):
    t0 = time.perf_counter()
    rid = getattr(request.state, "request_id", "")
    caller = _caller_id(request, p)
    # Reserve one prediction against the workspace's monthly quota.
    # Raises 429 with Retry-After + X-RateLimit-* headers on overage.
    enforce_prediction_quota(p.get("tenant", "default"), response, cost=len(req.schedule) or 1)
    req_hash = hash_body({"req": req.model_dump(mode="json"),
                          "model_name": model_name, "shadow": shadow})
    if idempotency_key:
        if len(idempotency_key) > 128:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                detail="Idempotency-Key too long (max 128)")
        try:
            cached = idem_lookup(idempotency_key, caller=caller,
                                 route="/v1/predict", request_hash=req_hash)
        except IdempotencyConflict as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, detail=str(exc))
        if cached is not None:
            return JSONResponse(
                content=cached["response"],
                status_code=cached["status_code"],
                headers={"Idempotent-Replay": "true"},
            )
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
        # ---- model approval gate (per-workspace governance) ----
        # Run after the registry resolved the real version so we evaluate
        # what would actually score, not just the requested name.
        resolved_version = str(res.get("model_version", ""))
        decision = model_approval_mod.evaluate(
            p.get("tenant", "default"),
            model_name=model_name,
            model_version=resolved_version,
        )
        response.headers["X-Model-Approval"] = (
            "approved" if decision.approved else (
                "blocked" if not decision.allowed else "unapproved"
            )
        )
        response.headers["X-Model-Approval-Mode"] = decision.mode
        if not decision.allowed:
            dt = (time.perf_counter() - t0) * 1000.0
            audit_record(
                request_id=rid, route="/v1/predict", user_id=req.user_id,
                tenant_id=p.get("tenant", "default"),
                caller=caller, caller_role=p.get("role", "service"),
                model_name=model_name, model_version=resolved_version,
                n_doses=len(req.schedule), latency_ms=dt, ok=False,
                error=f"model_approval:{decision.reason}",
            )
            record_admin_action(
                action="workspace.model_approval.predict.blocked",
                principal=p,
                target=f"{model_name}@{resolved_version}",
                details={"route": "/v1/predict", "reason": decision.reason},
                request_id=rid,
                tenant_id=p.get("tenant", "default"),
                ok=False, error=decision.reason,
            )
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "error": "model_version_not_approved",
                    "model_name": model_name,
                    "model_version": resolved_version,
                    "mode": decision.mode,
                    "reason": decision.reason,
                },
                headers={
                    "X-Model-Approval": "blocked",
                    "X-Model-Approval-Mode": decision.mode,
                },
            )
        if decision.mode == "audit" and not decision.approved:
            record_admin_action(
                action="workspace.model_approval.predict.unapproved",
                principal=p,
                target=f"{model_name}@{resolved_version}",
                details={"route": "/v1/predict", "mode": decision.mode},
                request_id=rid,
                tenant_id=p.get("tenant", "default"),
            )
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
            tenant_id=p.get("tenant", "default"),
            caller=caller, caller_role=p.get("role", "service"),
            model_name=model_name, model_version=str(res.get("model_version", "")),
            shadow_model_name=shadow if shadow and shadow != model_name else None,
            shadow_model_version=shadow_version,
            shadow_max_divergence=shadow_div,
            n_doses=len(res.get("predictions", [])),
            latency_ms=dt, ok=True, predictions=res.get("predictions", []),
            schedule_meta={s.dose_id: {"dose_class": s.dose_class, "scheduled_at": s.scheduled_at.isoformat()} for s in req.schedule},
        )
        response_obj = PredictResponse(**res)
        if idempotency_key:
            idem_store(
                idempotency_key, caller=caller, route="/v1/predict",
                request_hash=req_hash, status_code=200,
                response=response_obj.model_dump(mode="json"),
                ttl_seconds=86400,
            )
        return response_obj
    except ModelNotFoundError as exc:
        dt = (time.perf_counter() - t0) * 1000.0
        audit_record(
            request_id=rid, route="/v1/predict", user_id=req.user_id,
            tenant_id=p.get("tenant", "default"),
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
    response: Response,
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
    # Charge the batch up front; cost is total scheduled doses (min 1).
    cost = sum(max(1, len(item.schedule)) for item in req.items)
    enforce_prediction_quota(p.get("tenant", "default"), response, cost=cost)

    try:
        from adherence_worker.inference import load_model
        art, _model, _explainer = load_model(model_name)
    except ModelNotFoundError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))

    # Per-workspace model approval gate. Resolved once per batch since
    # the registry hands us one artifact regardless of items.
    resolved_version = str(art.version)
    decision = model_approval_mod.evaluate(
        p.get("tenant", "default"),
        model_name=model_name,
        model_version=resolved_version,
    )
    response.headers["X-Model-Approval"] = (
        "approved" if decision.approved else (
            "blocked" if not decision.allowed else "unapproved"
        )
    )
    response.headers["X-Model-Approval-Mode"] = decision.mode
    if not decision.allowed:
        record_admin_action(
            action="workspace.model_approval.predict.blocked",
            principal=p,
            target=f"{model_name}@{resolved_version}",
            details={
                "route": "/v1/predict/batch",
                "reason": decision.reason,
                "n_items": len(req.items),
            },
            request_id=rid,
            tenant_id=p.get("tenant", "default"),
            ok=False, error=decision.reason,
        )
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "model_version_not_approved",
                "model_name": model_name,
                "model_version": resolved_version,
                "mode": decision.mode,
                "reason": decision.reason,
            },
            headers={
                "X-Model-Approval": "blocked",
                "X-Model-Approval-Mode": decision.mode,
            },
        )
    if decision.mode == "audit" and not decision.approved:
        record_admin_action(
            action="workspace.model_approval.predict.unapproved",
            principal=p,
            target=f"{model_name}@{resolved_version}",
            details={
                "route": "/v1/predict/batch",
                "mode": decision.mode,
                "n_items": len(req.items),
            },
            request_id=rid,
            tenant_id=p.get("tenant", "default"),
        )

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
                tenant_id=p.get("tenant", "default"),
                caller=caller, caller_role=role,
                model_name=model_name, model_version=str(res.get("model_version", "")),
                n_doses=len(res.get("predictions", [])),
                latency_ms=(time.perf_counter() - t0) * 1000.0,
                ok=True, predictions=res.get("predictions", []),
                schedule_meta={s.dose_id: {"dose_class": s.dose_class, "scheduled_at": s.scheduled_at.isoformat()} for s in item.schedule},
            )
        except Exception as exc:
            results.append(
                BatchPredictItem(user_id=item.user_id, ok=False, error=str(exc))
            )
            audit_record(
                request_id=rid, route="/v1/predict/batch", user_id=item.user_id,
                tenant_id=p.get("tenant", "default"),
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
