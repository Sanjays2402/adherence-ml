"""Hypothesis property tests."""
from hypothesis import given, settings, strategies as st
import numpy as np

from adherence_eval.metrics import brier_score, expected_calibration_error
from adherence_features.drift import psi


@given(
    probs=st.lists(st.floats(min_value=0.0, max_value=1.0, allow_nan=False), min_size=10, max_size=200),
)
@settings(max_examples=40, deadline=None)
def test_brier_in_range(probs):
    p = np.array(probs)
    y = (p > 0.5).astype(int)
    b = brier_score(y, p)
    assert 0.0 <= b <= 1.0


@given(
    arr=st.lists(st.floats(min_value=-10.0, max_value=10.0, allow_nan=False), min_size=30, max_size=500),
)
@settings(max_examples=30, deadline=None)
def test_psi_self_is_low(arr):
    a = np.array(arr)
    assert psi(a, a) < 1e-3


@given(
    n=st.integers(min_value=50, max_value=300),
)
@settings(max_examples=20, deadline=None)
def test_ece_bounded(n):
    rng = np.random.default_rng(n)
    p = rng.uniform(0, 1, n)
    y = rng.integers(0, 2, n)
    e = expected_calibration_error(y, p, n_bins=8)
    assert 0.0 <= e <= 1.0
