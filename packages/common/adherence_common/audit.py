"""Prediction audit recorder.

Best-effort persistence of one PredictionAudit row per /v1/predict call (or
per item in a batch). Failures here must never bubble out to the API; we
log and move on so observability never blocks a clinical-ish request path.
"""
from __future__ import annotations

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
    tenant_id: str = "default",
    predictions: list[dict[str, Any]] | None = None,
    shadow_model_name: str | None = None,
    shadow_model_version: str | None = None,
    shadow_max_divergence: float | None = None,
    error: str | None = None,
    extra: dict[str, Any] | None = None,
    schedule_meta: dict[str, dict[str, Any]] | None = None,
) -> None:
    _ensure_table()
    stats = summarize(predictions or [])
    sm = schedule_meta or {}
    # Slim per-dose snapshot for online metrics (join against dose_outcomes).
    slim_preds = []
    for p in (predictions or []):
        did = p.get("dose_id")
        if did is None:
            continue
        meta = sm.get(did, {})
        entry = {
            "dose_id": did,
            "miss_probability": float(p.get("miss_probability", 0.0)),
            "risk_tier": p.get("risk_tier"),
        }
        if meta.get("dose_class"):
            entry["dose_class"] = str(meta["dose_class"])
        if meta.get("scheduled_at"):
            entry["scheduled_at"] = str(meta["scheduled_at"])
        slim_preds.append(entry)
    response_summary = {
        "tiers": _tier_counts(predictions or []),
        "predictions": slim_preds,
        **(extra or {}),
    }
    row = PredictionAudit(
        request_id=request_id[:32],
        route=route[:64],
        user_id=user_id[:64],
        tenant_id=(tenant_id or "default")[:64],
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
    try:
        # Two-phase write: flush to assign an autoincrement ``id``, then chain
        # this row to the previous head and recompute its own ``row_hash``.
        # Done inside one transaction so a failure mid-way rolls everything
        # back, leaving the chain consistent.
        from adherence_common.audit_chain import (
            assign_chain,
            latest_chain_hash_in_session,
        )
        with session() as s:
            s.add(row)
            s.flush()
            try:
                prev = latest_chain_hash_in_session(s, exclude_id=row.id)
                assign_chain(row, prev)
            except Exception as exc:  # never fail the audit write on chain issues
                log.warning("audit_chain_failed", error=str(exc), request_id=request_id)
            s.commit()
            return
    except (SQLAlchemyError, Exception):
        pass
    log.warning("audit_write_failed", request_id=request_id, route=route)


def _tier_counts(predictions: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"low": 0, "medium": 0, "high": 0}
    for p in predictions:
        t = p.get("risk_tier")
        if t in counts:
            counts[t] += 1
    return counts
