"""SHAP wrapper around the ensemble + human-readable reason codes."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

try:
    import shap
except Exception:  # pragma: no cover
    shap = None  # type: ignore[assignment]


HUMAN_TEMPLATES = {
    "hour_sin": "time of day",
    "hour_cos": "time of day",
    "dow_sin": "day of week",
    "dow_cos": "day of week",
    "is_weekend": "weekend vs weekday",
    "time_bucket_idx": "part of day",
    "dose_class_idx": "medication class",
    "dose_strength_mg": "dose strength",
    "streak_taken": "recent on-time streak",
    "streak_missed": "recent missed streak",
    "recent_miss_rate_7d": "missed rate over last 7 days",
    "recent_miss_rate_24h": "missed rate in last 24 hours",
    "recent_late_rate_7d": "late rate over last 7 days",
    "doses_today_so_far": "doses already taken today",
    "doses_yesterday": "yesterday's dose load",
    "minutes_since_last_dose": "time since previous scheduled dose",
    "minutes_since_last_taken": "time since last dose actually taken",
    "sleep_window_proxy": "dose in likely sleep window",
    "n_classes_user": "number of medication classes",
    "user_n_doses_history": "history length",
}


@dataclass
class ShapExplainer:
    feature_columns: list[str]
    xgb_explainer: Any = None
    lgb_explainer: Any = None
    weight_xgb: float = 0.5
    weight_lgb: float = 0.5

    @classmethod
    def from_ensemble(cls, model) -> "ShapExplainer":
        if shap is None:
            return cls(feature_columns=model.feature_columns)
        return cls(
            feature_columns=model.feature_columns,
            xgb_explainer=shap.TreeExplainer(model.xgb_booster),
            lgb_explainer=shap.TreeExplainer(model.lgb_booster),
            weight_xgb=model.weight_xgb,
            weight_lgb=model.weight_lgb,
        )

    def shap_values(self, X: pd.DataFrame) -> np.ndarray:
        Xv = X[self.feature_columns].to_numpy(dtype=float)
        if shap is None or self.xgb_explainer is None:
            return np.zeros_like(Xv)
        sx = self.xgb_explainer.shap_values(Xv)
        sl = self.lgb_explainer.shap_values(Xv)
        # LGB binary may return list of two arrays
        if isinstance(sl, list):
            sl = sl[1]
        return self.weight_xgb * np.asarray(sx) + self.weight_lgb * np.asarray(sl)


def _humanize(feature: str, contribution: float, row: pd.Series) -> str:
    direction = "raises" if contribution > 0 else "lowers"
    label = HUMAN_TEMPLATES.get(feature, feature.replace("_", " "))
    detail = ""
    if feature == "recent_miss_rate_7d":
        detail = f" (you missed {row[feature]*100:.0f}% of doses this week)"
    elif feature == "is_weekend" and row[feature]:
        detail = " (it is the weekend)"
    elif feature == "sleep_window_proxy" and row[feature]:
        detail = " (this dose lands in your likely sleep window)"
    elif feature == "streak_missed" and row[feature] >= 2:
        detail = f" (you missed {int(row[feature])} doses in a row)"
    return f"{label} {direction} miss risk{detail}".strip()


def reason_codes_for_row(
    feature_row: pd.Series,
    shap_row: np.ndarray,
    feature_columns: list[str],
    top_k: int = 3,
) -> list[dict]:
    contribs = list(zip(feature_columns, shap_row.tolist()))
    contribs.sort(key=lambda kv: abs(kv[1]), reverse=True)
    out = []
    for feat, c in contribs[:top_k]:
        out.append(
            {
                "feature": feat,
                "contribution": float(c),
                "human": _humanize(feat, c, feature_row),
            }
        )
    return out
