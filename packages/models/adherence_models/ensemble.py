"""XGBoost + LightGBM ensemble trainer with calibration."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import lightgbm as lgb
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import roc_auc_score

from adherence_features.engineering import FEATURE_COLUMNS

# Lightweight wrapper used by sklearn CalibratedClassifierCV
class _BinaryWrapper:
    """A minimal sklearn-compatible estimator wrapping a fit-once booster."""
    classes_ = np.array([0, 1])

    def __init__(self, predict_proba_fn):
        self._pp = predict_proba_fn

    def fit(self, X, y):
        return self

    def predict_proba(self, X):
        p = self._pp(X)
        return np.column_stack([1 - p, p])

    def predict(self, X):
        return (self._pp(X) >= 0.5).astype(int)


@dataclass
class TrainParams:
    xgb_params: dict[str, Any] = field(default_factory=lambda: {
        "objective": "binary:logistic",
        "eval_metric": "auc",
        "max_depth": 6,
        "learning_rate": 0.08,
        "subsample": 0.85,
        "colsample_bytree": 0.85,
        "min_child_weight": 8,
        "reg_lambda": 1.5,
        "tree_method": "hist",
        "verbosity": 0,
    })
    lgb_params: dict[str, Any] = field(default_factory=lambda: {
        "objective": "binary",
        "metric": "auc",
        "num_leaves": 63,
        "learning_rate": 0.05,
        "feature_fraction": 0.85,
        "bagging_fraction": 0.85,
        "bagging_freq": 4,
        "min_data_in_leaf": 60,
        "verbose": -1,
    })
    xgb_rounds: int = 400
    lgb_rounds: int = 500
    early_stopping_rounds: int = 30
    weight_xgb: float = 0.5
    weight_lgb: float = 0.5
    calibration: str = "isotonic"  # or "sigmoid"


@dataclass
class EnsembleModel:
    xgb_booster: xgb.Booster
    lgb_booster: lgb.Booster
    feature_columns: list[str]
    weight_xgb: float
    weight_lgb: float
    calibrator: CalibratedClassifierCV | None = None
    train_feature_stats: dict[str, dict[str, float]] = field(default_factory=dict)
    version: str = "dev"

    def _raw(self, X: pd.DataFrame) -> np.ndarray:
        Xv = X[self.feature_columns].to_numpy(dtype=float)
        p_x = self.xgb_booster.predict(xgb.DMatrix(Xv))
        p_l = self.lgb_booster.predict(Xv)
        return self.weight_xgb * p_x + self.weight_lgb * p_l

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        p = self._raw(X)
        if self.calibrator is not None:
            p = self.calibrator.predict_proba(p.reshape(-1, 1))[:, 1]
        return p

    def predict(self, X: pd.DataFrame, threshold: float = 0.5) -> np.ndarray:
        return (self.predict_proba(X) >= threshold).astype(int)


def _feature_stats(df: pd.DataFrame, cols: list[str]) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    for c in cols:
        s = df[c].astype(float)
        out[c] = {
            "mean": float(s.mean()),
            "std": float(s.std() or 1.0),
            "p05": float(s.quantile(0.05)),
            "p50": float(s.quantile(0.5)),
            "p95": float(s.quantile(0.95)),
        }
    return out


def train_ensemble(
    train_df: pd.DataFrame,
    valid_df: pd.DataFrame,
    params: TrainParams | None = None,
    version: str = "dev",
) -> tuple[EnsembleModel, dict[str, float]]:
    params = params or TrainParams()
    feats = [c for c in FEATURE_COLUMNS if c in train_df.columns]

    X_tr = train_df[feats].to_numpy(dtype=float)
    y_tr = train_df["label"].to_numpy(dtype=int)
    X_va = valid_df[feats].to_numpy(dtype=float)
    y_va = valid_df["label"].to_numpy(dtype=int)

    # XGBoost
    dtr = xgb.DMatrix(X_tr, label=y_tr)
    dva = xgb.DMatrix(X_va, label=y_va)
    xgb_booster = xgb.train(
        params.xgb_params,
        dtr,
        num_boost_round=params.xgb_rounds,
        evals=[(dva, "valid")],
        early_stopping_rounds=params.early_stopping_rounds,
        verbose_eval=False,
    )

    # LightGBM
    dtr_l = lgb.Dataset(X_tr, label=y_tr)
    dva_l = lgb.Dataset(X_va, label=y_va, reference=dtr_l)
    lgb_booster = lgb.train(
        params.lgb_params,
        dtr_l,
        num_boost_round=params.lgb_rounds,
        valid_sets=[dva_l],
        callbacks=[lgb.early_stopping(params.early_stopping_rounds), lgb.log_evaluation(0)],
    )

    # Ensemble raw on valid
    p_x = xgb_booster.predict(dva)
    p_l = lgb_booster.predict(X_va)
    raw_valid = params.weight_xgb * p_x + params.weight_lgb * p_l
    raw_auc = float(roc_auc_score(y_va, raw_valid))

    # Calibrate via sklearn CalibratedClassifierCV (cv="prefit" needs a fitted estimator)
    calibrator: CalibratedClassifierCV | None = None
    try:
        wrapper = _BinaryWrapper(lambda Xq: (params.weight_xgb * xgb_booster.predict(xgb.DMatrix(Xq)) + params.weight_lgb * lgb_booster.predict(Xq)))
        # Calibrate on the validation set using its own split
        from sklearn.model_selection import train_test_split
        Xc_tr, Xc_va, yc_tr, yc_va = train_test_split(
            X_va, y_va, test_size=0.5, random_state=0, stratify=y_va
        )
        wrapper.fit(Xc_tr, yc_tr)
        calibrator = CalibratedClassifierCV(wrapper, method=params.calibration, cv="prefit")
        calibrator.fit(Xc_va, yc_va)
    except Exception:
        calibrator = None

    model = EnsembleModel(
        xgb_booster=xgb_booster,
        lgb_booster=lgb_booster,
        feature_columns=feats,
        weight_xgb=params.weight_xgb,
        weight_lgb=params.weight_lgb,
        calibrator=calibrator,
        train_feature_stats=_feature_stats(train_df, feats),
        version=version,
    )

    # Final AUC reported uses ensemble + calibrator if present
    final_p = model.predict_proba(valid_df[feats])
    metrics = {
        "auc_raw": raw_auc,
        "auc_calibrated": float(roc_auc_score(y_va, final_p)),
        "n_train": float(len(train_df)),
        "n_valid": float(len(valid_df)),
        "pos_rate_train": float(y_tr.mean()),
        "pos_rate_valid": float(y_va.mean()),
    }
    return model, metrics
