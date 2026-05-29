"""Population Stability Index (PSI) based drift detection."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


def psi(expected: np.ndarray, actual: np.ndarray, buckets: int = 10) -> float:
    """Population Stability Index between two numeric arrays."""
    expected = np.asarray(expected, dtype=float)
    actual = np.asarray(actual, dtype=float)
    expected = expected[~np.isnan(expected)]
    actual = actual[~np.isnan(actual)]
    if expected.size == 0 or actual.size == 0:
        return 0.0
    qs = np.linspace(0, 1, buckets + 1)
    edges = np.unique(np.quantile(expected, qs))
    if edges.size < 3:
        # fallback to equal-width
        edges = np.linspace(min(expected.min(), actual.min()), max(expected.max(), actual.max()), buckets + 1)
        edges = np.unique(edges)
    if edges.size < 3:
        return 0.0
    e_counts, _ = np.histogram(expected, bins=edges)
    a_counts, _ = np.histogram(actual, bins=edges)
    e = (e_counts + 1e-6) / (e_counts.sum() + 1e-6 * len(e_counts))
    a = (a_counts + 1e-6) / (a_counts.sum() + 1e-6 * len(a_counts))
    return float(np.sum((a - e) * np.log(a / e)))


@dataclass
class DriftReport:
    overall_psi: float
    per_feature: dict[str, float]
    breaches: list[str]
    threshold: float


def detect_drift(
    reference: pd.DataFrame,
    live: pd.DataFrame,
    features: list[str],
    threshold: float = 0.2,
) -> DriftReport:
    per: dict[str, float] = {}
    for f in features:
        if f not in reference.columns or f not in live.columns:
            continue
        per[f] = psi(reference[f].to_numpy(), live[f].to_numpy())
    breaches = [k for k, v in per.items() if v > threshold]
    overall = float(np.mean(list(per.values()))) if per else 0.0
    return DriftReport(overall_psi=overall, per_feature=per, breaches=breaches, threshold=threshold)
