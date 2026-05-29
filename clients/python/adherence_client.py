"""Minimal Python client (sync, stdlib + httpx) for adherence-ml.

Mirrors the TypeScript client in ../typescript/adherence-client.ts so that
Med-Tracker server-side jobs (Python) and the Med-Tracker web app
(TypeScript) talk to the same surface.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

import httpx


@dataclass
class AdherenceClient:
    base_url: str
    api_key: str | None = None
    bearer_token: str | None = None
    timeout_s: float = 5.0

    def _headers(self) -> dict[str, str]:
        h = {"content-type": "application/json"}
        if self.api_key:
            h["x-api-key"] = self.api_key
        if self.bearer_token:
            h["authorization"] = f"Bearer {self.bearer_token}"
        return h

    def _req(self, method: str, path: str, **kw: Any) -> Any:
        url = self.base_url.rstrip("/") + path
        with httpx.Client(timeout=self.timeout_s, headers=self._headers()) as c:
            r = c.request(method, url, **kw)
            r.raise_for_status()
            return r.json()

    def health(self) -> dict[str, Any]:
        return self._req("GET", "/healthz")

    def predict(
        self,
        user_id: str,
        schedule: Iterable[dict[str, Any]],
        history: Iterable[dict[str, Any]] | None = None,
        model_name: str = "default",
        top_k_reasons: int = 3,
    ) -> dict[str, Any]:
        body = {
            "user_id": user_id,
            "schedule": list(schedule),
            "history": list(history) if history is not None else None,
            "top_k_reasons": top_k_reasons,
        }
        return self._req(
            "POST", f"/v1/predict?model_name={model_name}", json=body
        )

    def predict_batch(
        self,
        items: Iterable[dict[str, Any]],
        model_name: str = "default",
    ) -> dict[str, Any]:
        return self._req(
            "POST",
            f"/v1/predict/batch?model_name={model_name}",
            json={"items": list(items)},
        )

    def cohort_risk(
        self,
        events: Iterable[dict[str, Any]] | None = None,
        synthetic: dict[str, Any] | None = None,
        model_name: str = "default",
        top_users: int = 10,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if events is not None:
            body["events"] = list(events)
        if synthetic is not None:
            body["synthetic"] = synthetic
        return self._req(
            "POST",
            f"/v1/cohort/risk?model_name={model_name}&top_users={top_users}",
            json=body,
        )

    def explain_global(self, model_name: str = "default") -> dict[str, Any]:
        return self._req("GET", f"/v1/explain/global?model_name={model_name}")
