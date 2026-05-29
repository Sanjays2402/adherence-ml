"""Batch nightly job: score upcoming 24h doses for all known users."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pandas as pd

from adherence_common.db import PredictionRow, init_db, session
from adherence_common.logging import get_logger
from adherence_data.medtracker import MedTrackerClient
from adherence_common.settings import get_settings
from adherence_worker.inference import predict_doses

log = get_logger(__name__)


def nightly_predict_all(
    user_ids: list[str] | None = None,
    history_provider=None,
    schedule_provider=None,
    model_name: str = "default",
) -> dict[str, Any]:
    """Score next-24h doses for users and write to predictions table."""
    s = get_settings()
    init_db()
    n_users = 0
    n_rows = 0
    mt = MedTrackerClient(s.medtracker_base_url, s.medtracker_api_key)
    user_ids = user_ids or []

    for uid in user_ids:
        try:
            hist = history_provider(uid) if history_provider else (
                mt.fetch_user_events(uid) if mt.enabled else pd.DataFrame()
            )
            sched = schedule_provider(uid) if schedule_provider else (
                mt.fetch_user_schedule(uid) if mt.enabled else []
            )
            if not sched:
                continue
            res = predict_doses(uid, sched, hist, model_name=model_name)
            with session() as db:
                for p in res["predictions"]:
                    db.add(PredictionRow(
                        user_id=uid,
                        dose_id=p["dose_id"],
                        scheduled_at=pd.to_datetime(p["scheduled_at"], utc=True).to_pydatetime(),
                        miss_probability=float(p["miss_probability"]),
                        risk_tier=p["risk_tier"],
                        model_version=res["model_version"],
                        reasons=p["reasons"],
                    ))
                    n_rows += 1
                db.commit()
            n_users += 1
        except Exception as exc:
            log.warning("user predict failed", user_id=uid, error=str(exc))
    return {"users_scored": n_users, "predictions_written": n_rows, "model_name": model_name}
