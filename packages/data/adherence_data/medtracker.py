"""HTTP client for the Med-Tracker companion service.

Optional: only used if MEDTRACKER_BASE_URL is set. Tolerant to network failures.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

import httpx
import pandas as pd
from tenacity import retry, stop_after_attempt, wait_exponential

from adherence_common.logging import get_logger

log = get_logger(__name__)


class MedTrackerClient:
    def __init__(self, base_url: str | None, api_key: str | None = None, timeout: float = 10.0):
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    @property
    def enabled(self) -> bool:
        return bool(self.base_url)

    def _headers(self) -> dict[str, str]:
        h = {"accept": "application/json", "user-agent": "adherence-ml/0.1"}
        if self.api_key:
            h["x-api-key"] = self.api_key
        return h

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=0.5, max=5))
    def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        if not self.enabled:
            raise RuntimeError("MedTracker client not configured")
        with httpx.Client(timeout=self.timeout) as cli:
            r = cli.get(self.base_url + path, headers=self._headers(), params=params)
            r.raise_for_status()
            return r.json()

    def fetch_user_events(
        self, user_id: str, since: datetime | None = None
    ) -> pd.DataFrame:
        params: dict[str, Any] = {"user_id": user_id}
        if since:
            params["since"] = since.isoformat()
        data = self._get("/v1/events", params=params)
        items = data.get("items", []) if isinstance(data, dict) else data
        if not items:
            return pd.DataFrame(columns=[
                "user_id", "dose_id", "scheduled_at", "taken_at",
                "status", "dose_class", "dose_strength_mg",
            ])
        df = pd.DataFrame(items)
        for c in ("scheduled_at", "taken_at"):
            if c in df.columns:
                df[c] = pd.to_datetime(df[c], utc=True, errors="coerce")
        return df

    def fetch_user_schedule(self, user_id: str) -> list[dict[str, Any]]:
        data = self._get(f"/v1/users/{user_id}/schedule")
        if isinstance(data, dict):
            return list(data.get("schedule", []))
        return list(data)

    def post_predictions(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.enabled:
            return {"posted": False, "reason": "not configured"}
        with httpx.Client(timeout=self.timeout) as cli:
            r = cli.post(
                self.base_url + "/v1/predictions",
                headers=self._headers(),
                json=payload,
            )
            r.raise_for_status()
            return r.json()
