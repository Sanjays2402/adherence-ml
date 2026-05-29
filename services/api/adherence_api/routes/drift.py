"""/drift endpoints."""
from __future__ import annotations

from typing import Any

import httpx
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, status

from adherence_api.deps import require_service
from adherence_common.errors import ModelNotFoundError
from adherence_common.logging import get_logger
from adherence_common.settings import get_settings
from adherence_features.drift import detect_drift
from adherence_features.engineering import FEATURE_COLUMNS, build_training_frame
from adherence_models.registry import ModelRegistry

router = APIRouter(prefix="/v1/drift", tags=["drift"])
log = get_logger(__name__)


@router.post("/check")
def drift_check(payload: dict[str, Any], _p=Depends(require_service)) -> dict[str, Any]:
    """Compare live events against the training reference feature distribution.

    payload: {"model_name": "default", "events": [DoseEvent...]}
    """
    model_name = payload.get("model_name", "default")
    events = payload.get("events", [])
    if not events:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "no events provided")
    try:
        art, model = ModelRegistry().latest(model_name)
    except ModelNotFoundError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc))

    ref_stats = getattr(model, "train_feature_stats", {})
    if not ref_stats:
        raise HTTPException(status.HTTP_409_CONFLICT, "model has no reference stats")

    live_df = pd.DataFrame(events)
    for c in ("scheduled_at", "taken_at"):
        if c in live_df.columns:
            live_df[c] = pd.to_datetime(live_df[c], utc=True, errors="coerce")
    live_feats = build_training_frame(live_df)

    # Build a synthetic reference frame from stored stats (sample from each feature's quantiles).
    import numpy as np
    rng = np.random.default_rng(0)
    n_ref = max(2000, len(live_feats))
    ref_data: dict[str, Any] = {}
    for c, st in ref_stats.items():
        ref_data[c] = rng.normal(loc=st["mean"], scale=max(st["std"], 1e-3), size=n_ref)
    ref_df = pd.DataFrame(ref_data)

    settings = get_settings()
    report = detect_drift(ref_df, live_feats, FEATURE_COLUMNS, threshold=settings.drift_psi_threshold)

    out = {
        "model_version": art.version,
        "overall_psi": report.overall_psi,
        "threshold": report.threshold,
        "per_feature": report.per_feature,
        "breaches": report.breaches,
    }

    if report.breaches and settings.drift_webhook_url:
        try:
            with httpx.Client(timeout=3.0) as cli:
                cli.post(settings.drift_webhook_url, json={
                    "event": "drift.detected",
                    "model_name": model_name,
                    "model_version": art.version,
                    "breaches": report.breaches,
                    "per_feature": report.per_feature,
                })
            out["webhook"] = "sent"
        except Exception as exc:
            log.warning("drift webhook failed", error=str(exc))
            out["webhook"] = f"failed: {exc}"

    return out
