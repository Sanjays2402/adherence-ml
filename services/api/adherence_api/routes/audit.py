"""/v1/audit: query the prediction audit log.

Admins can list recent audit rows (filtered by user, route, ok, model) and
get aggregated stats (calls, p50/p95 latency, mean miss prob, error rate)
over a time window. Useful for spotting model regressions in production
without rebuilding from MLflow.
"""
from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timedelta
from typing import Any

from adherence_common.audit_chain import verify_chain
from adherence_common.db import PredictionAudit, init_db, session
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func, select

from adherence_api.deps import require_admin, require_tenant_access

router = APIRouter(prefix="/v1/audit", tags=["audit"])


class AuditRow(BaseModel):
    id: int
    request_id: str
    route: str
    tenant_id: str
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


class ShadowStatsRow(BaseModel):
    shadow_model_name: str
    n_calls: int
    mean_divergence: float
    max_divergence: float
    p95_divergence: float
    n_large_divergence: int  # |delta| > 0.10


class ShadowStatsResponse(BaseModel):
    window_hours: int
    n_with_shadow: int
    rows: list[ShadowStatsRow]


@router.get("/shadow", response_model=ShadowStatsResponse)
def shadow_stats(
    request: Request,
    window_hours: int = Query(24, ge=1, le=24 * 30),
    large_threshold: float = Query(0.10, ge=0.0, le=1.0),
    tenant: str | None = Query(
        None,
        description="Tenant filter. Defaults to caller tenant; admin may pass '*'.",
    ),
    p=Depends(require_admin),
) -> ShadowStatsResponse:
    """Aggregate shadow-vs-primary divergence per challenger model.

    Used to decide when a challenger model is safe to promote: low
    mean+p95 divergence and small `n_large_divergence` means the
    challenger tracks the primary closely on live traffic.

    Scoped to the caller's tenant by default. Pass ``tenant=*`` as admin
    to roll up across every tenant for fleet-wide model rollout review.
    """
    init_db()
    target = tenant or str(p.get("tenant") or "default")
    require_tenant_access(target, p, request)
    cutoff = datetime.utcnow() - timedelta(hours=window_hours)
    with session() as s:
        q = select(PredictionAudit).where(
            PredictionAudit.created_at >= cutoff,
            PredictionAudit.shadow_model_name.is_not(None),
        )
        if target != "*":
            q = q.where(PredictionAudit.tenant_id == target)
        rows: list[PredictionAudit] = list(s.scalars(q))
    by_shadow: dict[str, list[float]] = {}
    for r in rows:
        if r.shadow_max_divergence is None:
            continue
        by_shadow.setdefault(r.shadow_model_name, []).append(float(r.shadow_max_divergence))
    out: list[ShadowStatsRow] = []
    for name, vals in by_shadow.items():
        out.append(ShadowStatsRow(
            shadow_model_name=name,
            n_calls=len(vals),
            mean_divergence=sum(vals) / len(vals),
            max_divergence=max(vals),
            p95_divergence=_percentile(vals, 95) or 0.0,
            n_large_divergence=sum(1 for v in vals if v > large_threshold),
        ))
    out.sort(key=lambda r: r.n_calls, reverse=True)
    return ShadowStatsResponse(
        window_hours=window_hours,
        n_with_shadow=len(rows),
        rows=out,
    )


def _row_to_model(r: PredictionAudit) -> AuditRow:
    return AuditRow(
        id=r.id, request_id=r.request_id, route=r.route,
        tenant_id=(r.tenant_id or "default"),
        user_id=r.user_id,
        caller=r.caller, caller_role=r.caller_role,
        model_name=r.model_name, model_version=r.model_version,
        n_doses=r.n_doses, mean_miss_prob=r.mean_miss_prob,
        max_miss_prob=r.max_miss_prob, high_risk_count=r.high_risk_count,
        latency_ms=r.latency_ms, ok=bool(r.ok), error=r.error,
        created_at=r.created_at,
    )


@router.get("/list", response_model=AuditListResponse)
def list_audit(
    request: Request,
    limit: int = Query(100, ge=1, le=1000),
    user_id: str | None = None,
    route: str | None = None,
    model_name: str | None = None,
    only_errors: bool = False,
    tenant: str | None = Query(
        None,
        description=(
            "Restrict results to this tenant id. Defaults to the caller's tenant."
            " Admins may pass ``*`` to read across every tenant for compliance."
        ),
    ),
    p=Depends(require_admin),
) -> AuditListResponse:
    init_db()
    target = tenant or str(p.get("tenant") or "default")
    require_tenant_access(target, p, request)
    with session() as s:
        q = select(PredictionAudit).order_by(PredictionAudit.id.desc()).limit(limit)
        if target != "*":
            q = q.where(PredictionAudit.tenant_id == target)
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


class ChainBreakRow(BaseModel):
    row_id: int
    reason: str
    expected: str | None
    actual: str | None


class AuditVerifyResponse(BaseModel):
    n_rows: int
    n_hashed: int
    ok: bool
    head_hash: str | None
    breaks: list[ChainBreakRow]


@router.get("/verify", response_model=AuditVerifyResponse)
def verify(
    request: Request,
    limit: int | None = Query(None, ge=1, le=1_000_000),
    tenant: str | None = Query(
        None,
        description=(
            "Tenant filter. Defaults to caller tenant; admin may pass '*' to"
            " walk the full chain. Non-admin callers only see breaks for"
            " rows in their own tenant."
        ),
    ),
    p=Depends(require_admin),
) -> AuditVerifyResponse:
    """Verify the tamper-evident hash chain over the prediction audit log.

    The chain walk is always global because ``prev_hash`` links span
    tenants. Per-tenant callers only see breaks (and counts) restricted to
    their own tenant so one tenant can't enumerate another tenant's audit
    activity through this endpoint. Admins may pass ``tenant=*`` to get
    the unfiltered system view.
    """
    init_db()
    target = tenant or str(p.get("tenant") or "default")
    require_tenant_access(target, p, request)
    res = verify_chain(limit=limit)
    if target == "*":
        breaks = res.breaks
        n_rows = res.n_rows
        n_hashed = res.n_hashed
        head_hash = res.head_hash
    else:
        break_ids = {b.row_id for b in res.breaks}
        with session() as s:
            tenant_rows = list(
                s.scalars(
                    select(PredictionAudit).where(
                        PredictionAudit.tenant_id == target
                    )
                )
            )
        tenant_ids = {r.id for r in tenant_rows}
        breaks = [b for b in res.breaks if b.row_id in tenant_ids]
        n_rows = len(tenant_rows)
        n_hashed = sum(1 for r in tenant_rows if r.row_hash is not None)
        head_hash = None
        if tenant_rows:
            head = max(tenant_rows, key=lambda r: r.id)
            head_hash = head.row_hash
    return AuditVerifyResponse(
        n_rows=n_rows,
        n_hashed=n_hashed,
        ok=(len(breaks) == 0),
        head_hash=head_hash,
        breaks=[
            ChainBreakRow(
                row_id=b.row_id, reason=b.reason,
                expected=b.expected, actual=b.actual,
            )
            for b in breaks
        ],
    )


def _percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round((pct / 100.0) * (len(s) - 1)))))
    return s[k]


@router.get("/stats", response_model=AuditStatsResponse)
def stats(
    request: Request,
    window_hours: int = Query(24, ge=1, le=24 * 30),
    tenant: str | None = Query(
        None,
        description="Tenant filter. Defaults to caller tenant; admin may pass '*'.",
    ),
    p=Depends(require_admin),
) -> AuditStatsResponse:
    init_db()
    target = tenant or str(p.get("tenant") or "default")
    require_tenant_access(target, p, request)
    cutoff = datetime.utcnow() - timedelta(hours=window_hours)
    with session() as s:
        q = select(PredictionAudit).where(PredictionAudit.created_at >= cutoff)
        if target != "*":
            q = q.where(PredictionAudit.tenant_id == target)
        rows: list[PredictionAudit] = list(s.scalars(q))
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


# CSV export -----------------------------------------------------------------

_CSV_COLUMNS = (
    "id", "created_at", "tenant_id", "request_id", "route", "user_id", "caller", "caller_role",
    "model_name", "model_version", "shadow_model_name", "shadow_model_version",
    "n_doses", "mean_miss_prob", "max_miss_prob", "high_risk_count",
    "shadow_max_divergence", "latency_ms", "ok", "error",
)


def _csv_escape(v: Any) -> str:
    if v is None:
        return ""
    s = str(v)
    if any(ch in s for ch in (",", '"', "\n", "\r")):
        return '"' + s.replace('"', '""') + '"'
    return s


def _stream_csv(rows: list[PredictionAudit]) -> Iterator[str]:
    yield ",".join(_CSV_COLUMNS) + "\n"
    for r in rows:
        vals = [
            r.id,
            r.created_at.isoformat() if r.created_at else "",
            (r.tenant_id or "default"),
            r.request_id, r.route, r.user_id, r.caller, r.caller_role,
            r.model_name, r.model_version,
            r.shadow_model_name or "", r.shadow_model_version or "",
            r.n_doses,
            "" if r.mean_miss_prob is None else f"{r.mean_miss_prob:.6f}",
            "" if r.max_miss_prob is None else f"{r.max_miss_prob:.6f}",
            r.high_risk_count,
            "" if r.shadow_max_divergence is None else f"{r.shadow_max_divergence:.6f}",
            "" if r.latency_ms is None else f"{r.latency_ms:.3f}",
            int(bool(r.ok)),
            r.error or "",
        ]
        yield ",".join(_csv_escape(v) for v in vals) + "\n"


@router.get("/export.csv")
def export_csv(
    request: Request,
    window_hours: int = Query(24, ge=1, le=24 * 90),
    user_id: str | None = None,
    route: str | None = None,
    model_name: str | None = None,
    only_errors: bool = False,
    limit: int = Query(50_000, ge=1, le=500_000),
    tenant: str | None = Query(
        None,
        description="Tenant filter. Defaults to caller tenant; admin may pass '*'.",
    ),
    p=Depends(require_admin),
) -> StreamingResponse:
    """Stream prediction-audit rows as CSV for compliance / offline analysis.

    Bounded by ``limit`` (default 50k) so a runaway export cannot exhaust
    server memory. Always ordered oldest -> newest so consumers can resume
    on ``id`` if needed.
    """
    init_db()
    cutoff = datetime.utcnow() - timedelta(hours=window_hours)
    target = tenant or str(p.get("tenant") or "default")
    require_tenant_access(target, p, request)
    with session() as s:
        q = (
            select(PredictionAudit)
            .where(PredictionAudit.created_at >= cutoff)
            .order_by(PredictionAudit.id.asc())
            .limit(limit)
        )
        if target != "*":
            q = q.where(PredictionAudit.tenant_id == target)
        if user_id:
            q = q.where(PredictionAudit.user_id == user_id)
        if route:
            q = q.where(PredictionAudit.route == route)
        if model_name:
            q = q.where(PredictionAudit.model_name == model_name)
        if only_errors:
            q = q.where(PredictionAudit.ok == 0)
        rows = list(s.scalars(q))
    filename = f"audit_{cutoff.strftime('%Y%m%dT%H%M%SZ')}.csv"
    return StreamingResponse(
        _stream_csv(rows),
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Row-Count": str(len(rows)),
        },
    )
