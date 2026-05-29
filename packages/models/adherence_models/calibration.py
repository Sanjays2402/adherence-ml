"""Probability calibration helpers (Platt + isotonic)."""
from __future__ import annotations

from typing import Literal

import numpy as np
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression


def calibrate_probabilities(
    probs: np.ndarray,
    labels: np.ndarray,
    method: Literal["platt", "isotonic"] = "isotonic",
) -> tuple[np.ndarray, object]:
    probs = np.clip(np.asarray(probs, dtype=float), 1e-6, 1 - 1e-6)
    labels = np.asarray(labels, dtype=int)
    if method == "platt":
        lr = LogisticRegression(C=1e6, solver="lbfgs")
        lr.fit(probs.reshape(-1, 1), labels)
        return lr.predict_proba(probs.reshape(-1, 1))[:, 1], lr
    iso = IsotonicRegression(out_of_bounds="clip")
    iso.fit(probs, labels)
    return iso.transform(probs), iso
