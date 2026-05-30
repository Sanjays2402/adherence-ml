"""End-to-end training pipeline: data -> features -> ensemble -> MLflow + registry."""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

import mlflow
import pandas as pd

from adherence_common.logging import get_logger
from adherence_common.settings import get_settings
from adherence_data import SyntheticConfig, generate_events
from adherence_data.loaders import load_events_csv, load_events_parquet
from adherence_eval.crossval import time_series_split, backtest
from adherence_eval.metrics import all_metrics
from adherence_features.engineering import FEATURE_COLUMNS, build_training_frame
from adherence_models.ensemble import TrainParams, train_ensemble
from adherence_models.registry import ModelRegistry

log = get_logger(__name__)


def _calibration_reference(y, p, n_bins: int = 10) -> str:
    """Return reliability bins encoded as a compact JSON string.

    Schema: ``{"n_bins": int, "bins": [{"p_lo", "p_hi", "n",
    "mean_pred", "miss_rate"}, ...]}``. Stored as a string so it round-
    trips cleanly through the registry index even when consumers expect
    ``dict[str, float]`` shaped metrics.
    """
    import json

    y_list = [int(v) for v in y]
    p_list = [float(v) for v in p]
    total = len(p_list)
    bins = []
    for b in range(n_bins):
        lo = b / n_bins
        hi = (b + 1) / n_bins
        idx = [i for i, pi in enumerate(p_list)
               if (pi >= lo and pi < hi) or (b == n_bins - 1 and pi == 1.0)]
        if not idx:
            bins.append({"p_lo": lo, "p_hi": hi, "n": 0,
                         "mean_pred": 0.0, "miss_rate": 0.0})
            continue
        mp = sum(p_list[i] for i in idx) / len(idx)
        mr = sum(y_list[i] for i in idx) / len(idx)
        bins.append({"p_lo": lo, "p_hi": hi, "n": len(idx),
                     "mean_pred": mp, "miss_rate": mr})
    return json.dumps({"n_bins": n_bins, "total": total, "bins": bins})


def _load_events(
    synthetic: bool,
    events_path: str | None,
    users: int,
    days: int,
    seed: int,
) -> pd.DataFrame:
    if events_path:
        p = Path(events_path)
        if p.suffix == ".csv":
            return load_events_csv(p)
        return load_events_parquet(p)
    if not synthetic:
        raise ValueError("either set synthetic=True or pass events_path")
    cfg = SyntheticConfig(n_users=users, n_days=days, seed=seed)
    return generate_events(cfg)


def _split_by_time(features: pd.DataFrame, valid_frac: float = 0.2) -> tuple[pd.DataFrame, pd.DataFrame]:
    df = features.sort_values("scheduled_at").reset_index(drop=True)
    cut = int(len(df) * (1 - valid_frac))
    return df.iloc[:cut], df.iloc[cut:]


def run_training(
    synthetic: bool = True,
    events_path: str | None = None,
    users: int = 5000,
    days: int = 60,
    seed: int = 42,
    register_as: str = "default",
    use_mlflow: bool = True,
    cv_splits: int = 3,
) -> dict[str, Any]:
    s = get_settings()
    if use_mlflow:
        mlflow.set_tracking_uri(s.mlflow_tracking_uri)
        mlflow.set_experiment("adherence-ml")

    t0 = time.time()
    log.info("loading events", synthetic=synthetic, users=users, days=days)
    events = _load_events(synthetic, events_path, users, days, seed)
    log.info("featurizing", n_events=len(events))
    feats = build_training_frame(events)
    feats = feats.dropna(subset=["label"]).reset_index(drop=True)

    train_df, valid_df = _split_by_time(feats, valid_frac=0.2)
    log.info("training ensemble", n_train=len(train_df), n_valid=len(valid_df))

    ctx = mlflow.start_run(run_name=f"train_{register_as}") if use_mlflow else None
    try:
        params = TrainParams()
        model, base_metrics = train_ensemble(train_df, valid_df, params=params, version=register_as)
        valid_proba = model.predict_proba(valid_df[model.feature_columns])
        eval_metrics = all_metrics(valid_df["label"].to_numpy(), valid_proba)

        # Lightweight time-series CV summary for stability
        cv_aucs = []
        if cv_splits > 1:
            for k, (tr, va) in enumerate(time_series_split(feats, n_splits=cv_splits)):
                if len(tr) < 1000 or len(va) < 200:
                    continue
                m, _ = train_ensemble(tr, va, params=params, version=f"{register_as}-cv{k}")
                p = m.predict_proba(va[m.feature_columns])
                cv_aucs.append(float(__import__("sklearn").metrics.roc_auc_score(va["label"], p)))
        if cv_aucs:
            eval_metrics["auc_cv_mean"] = float(sum(cv_aucs) / len(cv_aucs))
            eval_metrics["auc_cv_folds"] = float(len(cv_aucs))

        metrics = {**base_metrics, **eval_metrics, "train_seconds": float(time.time() - t0)}

        # Persist a reliability curve as the calibration reference so the
        # /v1/metrics/calibration-drift endpoint can detect post-deploy
        # drift bin-by-bin. We keep it small (10 bins, scalars only) so
        # it fits comfortably in the registry index JSON.
        try:
            cal_ref = _calibration_reference(
                valid_df["label"].to_numpy(), valid_proba, n_bins=10
            )
            metrics["calibration_bins_json"] = cal_ref
        except Exception as exc:  # pragma: no cover
            log.warning("calibration reference failed", error=str(exc))

        reg = ModelRegistry()
        art = reg.save(register_as, model, metrics=metrics, notes="trainer.pipeline")

        if use_mlflow:
            mlflow.log_params({
                "n_train": len(train_df),
                "n_valid": len(valid_df),
                "n_features": len(FEATURE_COLUMNS),
                "register_as": register_as,
                "users": users,
                "days": days,
                "synthetic": synthetic,
            })
            for k, v in metrics.items():
                try:
                    mlflow.log_metric(k, float(v))
                except Exception:
                    pass
            mlflow.log_artifact(art.path)

        # Persist to db (best effort)
        try:
            from adherence_common.db import TrainingRun, init_db, session
            init_db()
            with session() as s2:
                row = TrainingRun(
                    run_id=art.version,
                    model_version=art.version,
                    auc=metrics.get("auc"),
                    pr_auc=metrics.get("pr_auc"),
                    brier=metrics.get("brier"),
                    ece=metrics.get("ece"),
                    n_rows=int(len(feats)),
                    metadata_json={"register_as": register_as, "synthetic": synthetic},
                )
                s2.add(row)
                s2.commit()
        except Exception as exc:
            log.warning("db persist failed", error=str(exc))

        return {
            "run_id": art.version,
            "model_version": art.version,
            "model_name": register_as,
            "metrics": metrics,
            "artifact_path": art.path,
        }
    finally:
        if ctx is not None:
            mlflow.end_run()


def run_backtest(
    synthetic: bool = True,
    events_path: str | None = None,
    users: int = 2000,
    days: int = 45,
    seed: int = 42,
    test_days: int = 7,
) -> dict[str, Any]:
    events = _load_events(synthetic, events_path, users, days, seed)
    feats = build_training_frame(events).dropna(subset=["label"])
    def _train(tr, va):
        m, _ = train_ensemble(tr, va, params=TrainParams())
        return m, {}
    return backtest(feats, _train, test_days=test_days)
