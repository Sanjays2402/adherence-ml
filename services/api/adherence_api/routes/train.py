"""/train endpoint (admin)."""
from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends

from adherence_api.deps import require_admin
from adherence_common.schemas import TrainRequest, TrainResponse
from adherence_trainer.pipeline import run_training

router = APIRouter(prefix="/v1", tags=["train"])


@router.post("/train", response_model=TrainResponse)
def train(req: TrainRequest, _p=Depends(require_admin)) -> TrainResponse:
    out = run_training(
        synthetic=req.synthetic,
        users=req.n_users,
        days=req.n_days,
        seed=req.seed,
        register_as=req.register_as,
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
    _p=Depends(require_admin),
) -> dict:
    bg.add_task(
        run_training,
        synthetic=req.synthetic,
        users=req.n_users,
        days=req.n_days,
        seed=req.seed,
        register_as=req.register_as,
    )
    return {"accepted": True, "register_as": req.register_as}
