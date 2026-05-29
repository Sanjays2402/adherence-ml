"""/plots endpoints (calibration + feature importance, returns PNG)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response

from adherence_api.deps import require_viewer
from adherence_common.errors import ModelNotFoundError
from adherence_data import SyntheticConfig, generate_events
from adherence_explain.plots import save_feature_importance_plot, save_reliability_plot
from adherence_features.engineering import build_training_frame
from adherence_models.registry import ModelRegistry

router = APIRouter(prefix="/v1/plots", tags=["plots"])


@router.get("/calibration.png")
def calibration_plot(
    model_name: str = Query("default"),
    n_users: int = Query(500, ge=50, le=5000),
    n_days: int = Query(14, ge=3, le=60),
    seed: int = Query(7),
    _p=Depends(require_viewer),
) -> Response:
    try:
        art, model = ModelRegistry().latest(model_name)
    except ModelNotFoundError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc))
    df = build_training_frame(generate_events(SyntheticConfig(n_users=n_users, n_days=n_days, seed=seed)))
    proba = model.predict_proba(df[model.feature_columns])
    png = save_reliability_plot(df["label"].to_numpy(), proba)
    return Response(content=png, media_type="image/png")


@router.get("/importance.png")
def importance_plot(model_name: str = Query("default"), _p=Depends(require_viewer)) -> Response:
    try:
        art, model = ModelRegistry().latest(model_name)
    except ModelNotFoundError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc))
    import numpy as np
    xgb_imp = model.xgb_booster.get_score(importance_type="gain")
    lgb_imp = dict(zip(model.feature_columns, model.lgb_booster.feature_importance(importance_type="gain")))
    importances = np.zeros(len(model.feature_columns), dtype=float)
    for i, f in enumerate(model.feature_columns):
        importances[i] = model.weight_xgb * float(xgb_imp.get(f, xgb_imp.get(f"f{i}", 0.0))) \
            + model.weight_lgb * float(lgb_imp.get(f, 0.0))
    png = save_feature_importance_plot(model.feature_columns, importances)
    return Response(content=png, media_type="image/png")
