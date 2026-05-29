"""/explain endpoints: global SHAP-based model explainability.

Per-dose reason codes are returned inline by /v1/predict. These endpoints
expose the *global* view of a model: gain-based feature importance from
each booster, and a SHAP summary (mean absolute SHAP value per feature)
computed on a fresh synthetic sample. Useful for model audits, clinical
dashboards, and answering "what does this model rely on?".
"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from adherence_api.deps import require_viewer
from adherence_common.errors import ModelNotFoundError
from adherence_common.logging import get_logger
from adherence_data import SyntheticConfig, generate_events
from adherence_explain.shap_wrapper import HUMAN_TEMPLATES, ShapExplainer
from adherence_features.engineering import build_training_frame
from adherence_models.registry import ModelRegistry

router = APIRouter(prefix="/v1/explain", tags=["explain"])
log = get_logger(__name__)


class FeatureImportance(BaseModel):
    feature: str
    human: str
    gain_xgb: float
    gain_lgb: float
    mean_abs_shap: float
    rank: int


class ExplainGlobalResponse(BaseModel):
    model_name: str
    model_version: str
    sample_size: int
    features: list[FeatureImportance]


def _gain_dict(booster, feature_columns: list[str]) -> dict[str, float]:
    """Extract per-feature gain, tolerant to xgb / lgb differences."""
    try:
        # XGBoost Booster
        score = booster.get_score(importance_type="gain")
        return {f: float(score.get(f, 0.0)) for f in feature_columns}
    except AttributeError:
        pass
    try:
        # LightGBM Booster
        names = list(booster.feature_name())
        gains = list(booster.feature_importance(importance_type="gain"))
        m = dict(zip(names, gains))
        return {f: float(m.get(f, 0.0)) for f in feature_columns}
    except Exception:  # pragma: no cover
        return {f: 0.0 for f in feature_columns}


@router.get("/global", response_model=ExplainGlobalResponse)
def explain_global(
    model_name: str = Query("default"),
    n_users: int = Query(400, ge=50, le=3000),
    n_days: int = Query(14, ge=3, le=60),
    seed: int = Query(7),
    _p=Depends(require_viewer),
) -> ExplainGlobalResponse:
    try:
        art, model = ModelRegistry().latest(model_name)
    except ModelNotFoundError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc))

    df = build_training_frame(
        generate_events(SyntheticConfig(n_users=n_users, n_days=n_days, seed=seed))
    )
    if df.empty:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "no rows in sample frame")
    X = df[model.feature_columns]

    explainer = ShapExplainer.from_ensemble(model)
    shap_vals = explainer.shap_values(X)
    mean_abs = np.mean(np.abs(shap_vals), axis=0).tolist()

    gx = _gain_dict(model.xgb_booster, model.feature_columns)
    gl = _gain_dict(model.lgb_booster, model.feature_columns)

    rows = []
    for i, f in enumerate(model.feature_columns):
        rows.append(
            FeatureImportance(
                feature=f,
                human=HUMAN_TEMPLATES.get(f, f.replace("_", " ")),
                gain_xgb=gx[f],
                gain_lgb=gl[f],
                mean_abs_shap=float(mean_abs[i]),
                rank=0,
            )
        )
    rows.sort(key=lambda r: r.mean_abs_shap, reverse=True)
    for r, item in enumerate(rows, start=1):
        item.rank = r

    return ExplainGlobalResponse(
        model_name=model_name,
        model_version=art.version,
        sample_size=int(len(df)),
        features=rows,
    )


class ExplainSampleRow(BaseModel):
    miss_probability: float
    feature_values: dict[str, float]
    shap_values: dict[str, float]


class ExplainSampleResponse(BaseModel):
    model_name: str
    model_version: str
    rows: list[ExplainSampleRow]


@router.get("/sample", response_model=ExplainSampleResponse)
def explain_sample(
    model_name: str = Query("default"),
    n: int = Query(5, ge=1, le=25),
    seed: int = Query(13),
    _p=Depends(require_viewer),
) -> ExplainSampleResponse:
    """Return raw SHAP values for a few synthetic doses (debugging / audit)."""
    try:
        art, model = ModelRegistry().latest(model_name)
    except ModelNotFoundError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc))

    df = build_training_frame(
        generate_events(SyntheticConfig(n_users=200, n_days=10, seed=seed))
    )
    if df.empty:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "no rows in sample frame")
    df = df.sample(n=min(n, len(df)), random_state=seed).reset_index(drop=True)
    X = df[model.feature_columns]
    proba = model.predict_proba(X)
    shap_vals = ShapExplainer.from_ensemble(model).shap_values(X)

    rows: list[ExplainSampleRow] = []
    for i in range(len(df)):
        fv = {f: float(X.iloc[i][f]) for f in model.feature_columns}
        sv = {f: float(shap_vals[i][j]) for j, f in enumerate(model.feature_columns)}
        rows.append(
            ExplainSampleRow(
                miss_probability=float(proba[i]),
                feature_values=fv,
                shap_values=sv,
            )
        )
    return ExplainSampleResponse(
        model_name=model_name, model_version=art.version, rows=rows
    )
