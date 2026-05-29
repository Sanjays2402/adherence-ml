"""Matplotlib plots used by API endpoints and reports."""
from __future__ import annotations

import io
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from adherence_eval.metrics import reliability_curve  # noqa: E402


def save_reliability_plot(y_true, y_prob, path: str | Path | None = None) -> bytes:
    rc = reliability_curve(y_true, y_prob)
    fig, ax = plt.subplots(figsize=(5, 5), dpi=110)
    ax.plot([0, 1], [0, 1], "--", color="#888", linewidth=1)
    ax.plot(rc["confidence"], rc["accuracy"], "o-", color="#3b82f6")
    ax.set_xlabel("predicted probability")
    ax.set_ylabel("empirical frequency")
    ax.set_title("Reliability curve")
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.grid(alpha=0.2)
    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png")
    plt.close(fig)
    data = buf.getvalue()
    if path:
        Path(path).write_bytes(data)
    return data


def save_feature_importance_plot(
    feature_columns: list[str],
    importances: np.ndarray,
    path: str | Path | None = None,
    top_k: int = 15,
) -> bytes:
    order = np.argsort(importances)[::-1][:top_k]
    feats = [feature_columns[i] for i in order]
    vals = [float(importances[i]) for i in order]
    fig, ax = plt.subplots(figsize=(6, 5), dpi=110)
    ax.barh(range(len(feats))[::-1], vals[::-1], color="#10b981")
    ax.set_yticks(range(len(feats))[::-1])
    ax.set_yticklabels(feats[::-1], fontsize=9)
    ax.set_xlabel("gain importance")
    ax.set_title(f"Top {len(feats)} features")
    ax.grid(axis="x", alpha=0.2)
    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png")
    plt.close(fig)
    data = buf.getvalue()
    if path:
        Path(path).write_bytes(data)
    return data
