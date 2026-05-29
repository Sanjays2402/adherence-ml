"""Classification + calibration metrics."""
from __future__ import annotations

import numpy as np
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score


def auc(y_true, y_prob) -> float:
    return float(roc_auc_score(y_true, y_prob))


def pr_auc(y_true, y_prob) -> float:
    return float(average_precision_score(y_true, y_prob))


def brier_score(y_true, y_prob) -> float:
    return float(brier_score_loss(y_true, y_prob))


def expected_calibration_error(y_true, y_prob, n_bins: int = 15) -> float:
    y_true = np.asarray(y_true, dtype=int)
    y_prob = np.asarray(y_prob, dtype=float)
    edges = np.linspace(0, 1, n_bins + 1)
    ece = 0.0
    for i in range(n_bins):
        lo, hi = edges[i], edges[i + 1]
        mask = (y_prob >= lo) & (y_prob < hi if i < n_bins - 1 else y_prob <= hi)
        if not np.any(mask):
            continue
        conf = float(y_prob[mask].mean())
        acc = float(y_true[mask].mean())
        ece += (mask.sum() / len(y_true)) * abs(conf - acc)
    return float(ece)


def reliability_curve(y_true, y_prob, n_bins: int = 15):
    y_true = np.asarray(y_true, dtype=int)
    y_prob = np.asarray(y_prob, dtype=float)
    edges = np.linspace(0, 1, n_bins + 1)
    centers, accs, confs, counts = [], [], [], []
    for i in range(n_bins):
        lo, hi = edges[i], edges[i + 1]
        mask = (y_prob >= lo) & (y_prob < hi if i < n_bins - 1 else y_prob <= hi)
        if not np.any(mask):
            continue
        centers.append((lo + hi) / 2.0)
        accs.append(float(y_true[mask].mean()))
        confs.append(float(y_prob[mask].mean()))
        counts.append(int(mask.sum()))
    return {"bin_center": centers, "accuracy": accs, "confidence": confs, "count": counts}


def all_metrics(y_true, y_prob) -> dict[str, float]:
    return {
        "auc": auc(y_true, y_prob),
        "pr_auc": pr_auc(y_true, y_prob),
        "brier": brier_score(y_true, y_prob),
        "ece": expected_calibration_error(y_true, y_prob),
    }
