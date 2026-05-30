"""Prediction audit recorder.

Best-effort persistence of one PredictionAudit row per /v1/predict call (or
per item in a batch). Failures here must never bubble out to the API; we
log and move on so observability never blocks a clinical-ish request path.
"""
from __future__ import annotations

import contextlib
from datetime import datetime
from typing import Any

from sqlalchemy.exc import SQLAlchemyError

from adherence_common.db import PredictionAudit, init_db, session
from adherence_common.logging import get_logger

log = get_logger(__name__)

_INITIALIZED = False


def _ensure_table() -> None:
    global _INITIALIZED
    if _INITIALIZED:
        return
    try:
        init_db()
        _INITIALIZED = True
    except Exception as exc:  # pragma: no cover - depends on db backend
        log.warning("audit_init_failed", error=str(exc))


def summarize(predictions: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute compact stats over a list of dose predictions."""
    if not predictions:
        return {"mean": None, "max": None, "high": 0, "n": 0}
    probs = [float(p.get("miss_probability", 0.0)) for p in predictions]
    high = sum(1 for p in predictions if p.get("risk_tier") == "high")
    return {
        "mean": sum(probs) / len(probs),
        "max": max(probs),
        "high": high,
        "n": len(probs),
    }


def record(
    *,
    request_id: str,
    route: str,
    user_id: str,
    caller: str,
    caller_role: str,
    model_name: str,
    model_version: str,
    n_doses: int,
    latency_ms: float,
    ok: bool,
    predictions: list[dict[str, Any]] | None = None,
    shadow_model_name: str | None = None,
    shadow_model_version: str | None = None,
    shadow_max_divergence: float | None = None,
    error: str | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    _ensure_table()
    stats = summarize(predictions or [])
    response_summary = {
        "tiers": _tier_counts(predictions or []),
        **(extra or {}),
    }
    row = PredictionAudit(
        request_id=request_id[:32],
        route=route[:64],
        user_id=user_id[:64],
        caller=caller[:64],
        caller_role=caller_role[:16],
        model_name=model_name[:64],
        model_version=str(model_version)[:64],
        shadow_model_name=(shadow_model_name or None) and shadow_model_name[:64],
        shadow_model_version=(shadow_model_version or None) and str(shadow_model_version)[:64],
        n_doses=n_doses,
        mean_miss_prob=stats["mean"],
        max_miss_prob=stats["max"],
        high_risk_count=stats["high"],
        shadow_max_divergence=shadow_max_divergence,
        latency_ms=latency_ms,
        ok=1 if ok else 0,
        error=(error or None) and error[:4000],
        response_summary=response_summary,
        created_at=datetime.utcnow(),
    )
    with contextlib.suppress(SQLAlchemyError, Exception):
        with session() as s:
            s.add(row)
            s.commit()
            return
    log.warning("audit_write_failed", request_id=request_id, route=route)


def _tier_counts(predictions: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"low": 0, "medium": 0, "high": 0}
    for p in predictions:
        t = p.get("risk_tier")
        if t in counts:
            counts[t] += 1
    return counts
