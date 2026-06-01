"""/train endpoint (admin)."""
from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, Request

from adherence_api.deps import require_admin
from adherence_common.admin_audit import record_admin_action
from adherence_common.schemas import TrainRequest, TrainResponse
from adherence_trainer.pipeline import run_training

router = APIRouter(prefix="/v1", tags=["train"])


def _rid(request: Request) -> str | None:
    return getattr(request.state, "request_id", None)


def _train_details(req: TrainRequest) -> dict:
    return {
        "synthetic": req.synthetic,
        "n_users": req.n_users,
        "n_days": req.n_days,
        "seed": req.seed,
        "register_as": req.register_as,
    }


@router.post("/train", response_model=TrainResponse)
def train(req: TrainRequest, request: Request, p=Depends(require_admin)) -> TrainResponse:
    try:
        out = run_training(
            synthetic=req.synthetic,
            users=req.n_users,
            days=req.n_days,
            seed=req.seed,
            register_as=req.register_as,
        )
    except Exception as exc:  # pragma: no cover - audit failure path
        record_admin_action(
            action="model.train",
            principal=p,
            target=req.register_as,
            details=_train_details(req),
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise
    record_admin_action(
        action="model.train",
        principal=p,
        target=out.get("model_version") or req.register_as,
        details={
            **_train_details(req),
            "run_id": out.get("run_id"),
            "model_version": out.get("model_version"),
        },
        request_id=_rid(request),
    )
    return TrainResponse(
        run_id=out["run_id"],
        model_version=out["model_version"],
        metrics={k: float(v) for k, v in out["metrics"].items() if isinstance(v, (int, float))},
    )


@router.post("/train/async")
def train_async(
    req: TrainRequest,
    bg: BackgroundTasks,
    request: Request,
    p=Depends(require_admin),
) -> dict:
    bg.add_task(
        run_training,
        synthetic=req.synthetic,
        users=req.n_users,
        days=req.n_days,
        seed=req.seed,
        register_as=req.register_as,
    )
    record_admin_action(
        action="model.train.async",
        principal=p,
        target=req.register_as,
        details=_train_details(req),
        request_id=_rid(request),
    )
    return {"accepted": True, "register_as": req.register_as}
