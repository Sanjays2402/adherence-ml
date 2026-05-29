"""Time-series cross-validation and backtests."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterator

import numpy as np
import pandas as pd

from adherence_eval.metrics import all_metrics


def time_series_split(
    df: pd.DataFrame,
    n_splits: int = 5,
    time_col: str = "scheduled_at",
    min_train_frac: float = 0.3,
) -> Iterator[tuple[pd.DataFrame, pd.DataFrame]]:
    """Expanding-window time series splits."""
    df = df.sort_values(time_col).reset_index(drop=True)
    n = len(df)
    if n < n_splits + 1:
        yield df.iloc[: n // 2], df.iloc[n // 2 :]
        return
    start = int(n * min_train_frac)
    fold_sizes = (n - start) // n_splits
    for k in range(n_splits):
        train_end = start + k * fold_sizes
        valid_end = train_end + fold_sizes
        if valid_end > n:
            valid_end = n
        train = df.iloc[:train_end]
        valid = df.iloc[train_end:valid_end]
        if len(valid) == 0:
            continue
        yield train, valid


@dataclass
class CVResult:
    fold_metrics: list[dict[str, float]]
    mean_metrics: dict[str, float]


def run_cv(
    df: pd.DataFrame,
    train_fn: Callable[[pd.DataFrame, pd.DataFrame], tuple[object, dict[str, float]]],
    n_splits: int = 5,
) -> CVResult:
    folds: list[dict[str, float]] = []
    for tr, va in time_series_split(df, n_splits=n_splits):
        if len(tr) == 0 or len(va) == 0:
            continue
        model, _ = train_fn(tr, va)
        proba = model.predict_proba(va)
        m = all_metrics(va["label"].to_numpy(), proba)
        folds.append(m)
    if not folds:
        return CVResult(fold_metrics=[], mean_metrics={})
    keys = folds[0].keys()
    mean = {k: float(np.mean([f[k] for f in folds])) for k in keys}
    return CVResult(fold_metrics=folds, mean_metrics=mean)


def backtest(
    df: pd.DataFrame,
    train_fn: Callable,
    test_days: int = 7,
    time_col: str = "scheduled_at",
) -> dict[str, float]:
    df = df.sort_values(time_col).reset_index(drop=True)
    cutoff = df[time_col].max() - pd.Timedelta(days=test_days)
    tr = df[df[time_col] < cutoff]
    te = df[df[time_col] >= cutoff]
    if len(tr) == 0 or len(te) == 0:
        return {}
    model, _ = train_fn(tr, te)
    proba = model.predict_proba(te)
    out = all_metrics(te["label"].to_numpy(), proba)
    out["n_train"] = float(len(tr))
    out["n_test"] = float(len(te))
    return out
