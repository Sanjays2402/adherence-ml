"""/v1/audit: query the prediction audit log.

Admins can list recent audit rows (filtered by user, route, ok, model) and
get aggregated stats (calls, p50/p95 latency, mean miss prob, error rate)
over a time window. Useful for spotting model regressions in production
without rebuilding from MLflow.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, select

from adherence_api.deps import require_admin
from adherence_common.db import PredictionAudit, init_db, session

router = APIRouter(prefix="/v1/audit", tags=["audit"])


class AuditRow(BaseModel):
    id: int
    request_id: str
    route: str
    user_id: str
    caller: str
    caller_role: str
    model_name: str
    model_version: str
    n_doses: int
    mean_miss_prob: float | None
    max_miss_prob: float | None
    high_risk_count: int
    latency_ms: float | None
    ok: bool
    error: str | None
    created_at: datetime


class AuditListResponse(BaseModel):
    n: int
    items: list[AuditRow]


class AuditStatsResponse(BaseModel):
    window_hours: int
    n_calls: int
    n_errors: int
    error_rate: float
    p50_latency_ms: float | None
    p95_latency_ms: float | None
    mean_miss_prob: float | None
    high_risk_calls: int
    by_model: dict[str, int]
    by_route: dict[str, int]


def _row_to_model(r: PredictionAudit) -> AuditRow:
    return AuditRow(
        id=r.id, request_id=r.request_id, route=r.route, user_id=r.user_id,
        caller=r.caller, caller_role=r.caller_role,
        model_name=r.model_name, model_version=r.model_version,
        n_doses=r.n_doses, mean_miss_prob=r.mean_miss_prob,
        max_miss_prob=r.max_miss_prob, high_risk_count=r.high_risk_count,
        latency_ms=r.latency_ms, ok=bool(r.ok), error=r.error,
        created_at=r.created_at,
    )


@router.get("/list", response_model=AuditListResponse)
def list_audit(
    limit: int = Query(100, ge=1, le=1000),
    user_id: str | None = None,
    route: str | None = None,
    model_name: str | None = None,
    only_errors: bool = False,
    _a=Depends(require_admin),
) -> AuditListResponse:
    init_db()
    with session() as s:
        q = select(PredictionAudit).order_by(PredictionAudit.id.desc()).limit(limit)
        if user_id:
            q = q.where(PredictionAudit.user_id == user_id)
        if route:
            q = q.where(PredictionAudit.route == route)
        if model_name:
            q = q.where(PredictionAudit.model_name == model_name)
        if only_errors:
            q = q.where(PredictionAudit.ok == 0)
        rows = list(s.scalars(q))
    return AuditListResponse(n=len(rows), items=[_row_to_model(r) for r in rows])


def _percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round((pct / 100.0) * (len(s) - 1)))))
    return s[k]


@router.get("/stats", response_model=AuditStatsResponse)
def stats(
    window_hours: int = Query(24, ge=1, le=24 * 30),
    _a=Depends(require_admin),
) -> AuditStatsResponse:
    init_db()
    cutoff = datetime.utcnow() - timedelta(hours=window_hours)
    with session() as s:
        rows: list[PredictionAudit] = list(
            s.scalars(
                select(PredictionAudit).where(PredictionAudit.created_at >= cutoff)
            )
        )
        # aggregate group counts in Python (portable across sqlite/postgres)
        by_model: dict[str, int] = {}
        by_route: dict[str, int] = {}
        latencies: list[float] = []
        miss_probs: list[float] = []
        n_errors = 0
        high_risk_calls = 0
        for r in rows:
            by_model[r.model_name] = by_model.get(r.model_name, 0) + 1
            by_route[r.route] = by_route.get(r.route, 0) + 1
            if r.latency_ms is not None:
                latencies.append(r.latency_ms)
            if r.mean_miss_prob is not None:
                miss_probs.append(r.mean_miss_prob)
            if not r.ok:
                n_errors += 1
            if r.high_risk_count > 0:
                high_risk_calls += 1
        # touch func/select to keep imports meaningful for future sql-side rollups
        _ = func.count
    n = len(rows)
    return AuditStatsResponse(
        window_hours=window_hours,
        n_calls=n,
        n_errors=n_errors,
        error_rate=(n_errors / n) if n else 0.0,
        p50_latency_ms=_percentile(latencies, 50),
        p95_latency_ms=_percentile(latencies, 95),
        mean_miss_prob=(sum(miss_probs) / len(miss_probs)) if miss_probs else None,
        high_risk_calls=high_risk_calls,
        by_model=by_model,
        by_route=by_route,
    )
