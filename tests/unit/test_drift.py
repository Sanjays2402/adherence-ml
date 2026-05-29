"""Drift detector tests."""
import numpy as np
import pandas as pd

from adherence_features.drift import detect_drift, psi
from adherence_features.engineering import FEATURE_COLUMNS


def test_psi_zero_for_identical():
    rng = np.random.default_rng(0)
    x = rng.normal(0, 1, 2000)
    assert psi(x, x) < 1e-6


def test_psi_high_for_shifted():
    rng = np.random.default_rng(0)
    a = rng.normal(0, 1, 2000)
    b = rng.normal(2.5, 1, 2000)
    assert psi(a, b) > 0.5


def test_detect_drift_reports_breaches():
    rng = np.random.default_rng(1)
    ref = pd.DataFrame({f: rng.normal(0, 1, 1000) for f in FEATURE_COLUMNS})
    live = ref.copy()
    live["recent_miss_rate_7d"] = rng.normal(3, 1, 1000)
    rep = detect_drift(ref, live, FEATURE_COLUMNS, threshold=0.2)
    assert "recent_miss_rate_7d" in rep.breaches
