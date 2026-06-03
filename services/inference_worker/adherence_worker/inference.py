"""Synchronous inference + reason-code wiring."""
from __future__ import annotations

from datetime import datetime, timezone
from functools import lru_cache
from typing import Any, Iterable

import numpy as np
import pandas as pd

from adherence_common.constants import DEFAULT_RISK_THRESHOLDS
from adherence_common.risk_policy import resolve as resolve_thresholds
from adherence_common.logging import get_logger
from adherence_explain.shap_wrapper import ShapExplainer, reason_codes_for_row
from adherence_features.engineering import featurize_schedule
from adherence_models.registry import ModelRegistry

log = get_logger(__name__)


@lru_cache(maxsize=8)
def load_model(name: str = "default", version: str | None = None):
    reg = ModelRegistry()
    art, model = reg.load(name, version=version)
    explainer = ShapExplainer.from_ensemble(model)
    return art, model, explainer


def _risk_tier(p: float) -> str:
    if p >= DEFAULT_RISK_THRESHOLDS["high"]:
        return "high"
    if p >= DEFAULT_RISK_THRESHOLDS["medium"]:
        return "medium"
    return "low"


def predict_doses(
    user_id: str,
    schedule: Iterable[dict[str, Any]],
    history: pd.DataFrame | None = None,
    model_name: str = "default",
    top_k: int = 3,
) -> dict[str, Any]:
    art, model, explainer = load_model(model_name)
    sched = list(schedule)
    if not sched:
        return {"user_id": user_id, "model_version": art.version, "predictions": []}

    hist = history if history is not None else pd.DataFrame(columns=[
        "user_id", "dose_id", "scheduled_at", "taken_at", "status",
        "dose_class", "dose_strength_mg",
    ])
    feats = featurize_schedule(user_id, hist, sched)
    proba = model.predict_proba(feats[model.feature_columns])
    shap_vals = explainer.shap_values(feats)

    out = []
    for i, s in enumerate(sched):
        row = feats.iloc[i]
        reasons = reason_codes_for_row(row, shap_vals[i], model.feature_columns, top_k=top_k)
        p = float(proba[i])
        thr = resolve_thresholds(user_id, s.get("dose_class"))
        out.append({
            "dose_id": s["dose_id"],
            "scheduled_at": s["scheduled_at"],
            "dose_class": s.get("dose_class"),
            "miss_probability": p,
            "risk_tier": thr.tier(p),
            "reasons": reasons,
        })
    return {"user_id": user_id, "model_version": art.version, "predictions": out}
