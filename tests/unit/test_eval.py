"""Metrics + calibration tests."""
import numpy as np

from adherence_eval.metrics import all_metrics, expected_calibration_error
from adherence_models.calibration import calibrate_probabilities


def test_perfect_predictor_gets_auc_1():
    y = np.array([0, 0, 1, 1, 0, 1])
    p = np.array([0.1, 0.2, 0.9, 0.95, 0.05, 0.7])
    m = all_metrics(y, p)
    assert m["auc"] == 1.0
    assert m["brier"] < 0.05


def test_ece_is_zero_for_calibrated_predictions():
    rng = np.random.default_rng(0)
    p = rng.uniform(0, 1, size=4000)
    y = (rng.uniform(0, 1, size=p.size) < p).astype(int)
    ece = expected_calibration_error(y, p, n_bins=10)
    assert ece < 0.05


def test_isotonic_calibration_reduces_ece():
    rng = np.random.default_rng(1)
    p_true = rng.uniform(0, 1, size=2000)
    y = (rng.uniform(0, 1, size=p_true.size) < p_true).astype(int)
    p_distorted = np.clip(p_true ** 0.5, 1e-3, 1 - 1e-3)
    ece_before = expected_calibration_error(y, p_distorted)
    p_cal, _ = calibrate_probabilities(p_distorted, y, method="isotonic")
    ece_after = expected_calibration_error(y, p_cal)
    assert ece_after <= ece_before + 1e-9
