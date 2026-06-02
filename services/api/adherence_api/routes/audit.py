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
from fastapi import APIRouter, Depends, HTTPException, Query, Request
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
    # Keyset pagination cursor. Pass back as ``before_id`` on the next
    # /v1/audit/list call to fetch the next page (older rows). ``None``
    # when the current page is the last page.
    next_before_id: int | None = None


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


def _parse_iso_dt(name: str, raw: str | None) -> datetime | None:
    """Parse an ISO-8601 query param to a naive UTC datetime.

    Accepts ``2026-01-31``, ``2026-01-31T12:34:56``, or the same with a
    trailing ``Z`` / ``+00:00`` offset. Times with a non-UTC offset are
    normalized to UTC and then stripped of tzinfo so they can be compared
    against ``PredictionAudit.created_at`` (stored as naive UTC).
    """
    if raw is None or raw == "":
        return None
    s = raw.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError as e:
        raise HTTPException(
            status_code=400,
            detail=f"invalid {name}: expected ISO-8601 datetime, got {raw!r}",
        ) from e
    if dt.tzinfo is not None:
        # Normalize to UTC then drop tzinfo to match the naive UTC values
        # stored in PredictionAudit.created_at.
        offset = dt.utcoffset() or timedelta(0)
        dt = (dt - offset).replace(tzinfo=None)
    return dt


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
    before_id: int | None = Query(
        None,
        ge=1,
        description=(
            "Keyset cursor: only return rows with ``id < before_id``. Use the"
            " ``next_before_id`` value from a previous response to page"
            " backwards through history without missing or duplicating rows"
            " when new audit rows are written concurrently."
        ),
    ),
    user_id: str | None = None,
    route: str | None = None,
    model_name: str | None = None,
    request_id: str | None = Query(
        None,
        description=(
            "Exact match on the per-request id propagated via the"
            " ``x-request-id`` header. Lets on-call jump from a log line or"
            " customer ticket straight to the audit row for that call."
        ),
    ),
    only_errors: bool = False,
    since: str | None = Query(
        None,
        description=(
            "Inclusive lower bound on created_at, ISO-8601 (e.g."
            " 2026-01-01T00:00:00Z). When omitted, no lower bound is applied."
        ),
    ),
    until: str | None = Query(
        None,
        description="Exclusive upper bound on created_at, ISO-8601.",
    ),
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
    since_dt = _parse_iso_dt("since", since)
    until_dt = _parse_iso_dt("until", until)
    if since_dt and until_dt and until_dt <= since_dt:
        raise HTTPException(status_code=400, detail="until must be after since")
    with session() as s:
        q = select(PredictionAudit).order_by(PredictionAudit.id.desc()).limit(limit)
        if before_id is not None:
            q = q.where(PredictionAudit.id < before_id)
        if target != "*":
            q = q.where(PredictionAudit.tenant_id == target)
        if user_id:
            q = q.where(PredictionAudit.user_id == user_id)
        if route:
            q = q.where(PredictionAudit.route == route)
        if model_name:
            q = q.where(PredictionAudit.model_name == model_name)
        if request_id:
            q = q.where(PredictionAudit.request_id == request_id)
        if only_errors:
            q = q.where(PredictionAudit.ok == 0)
        if since_dt is not None:
            q = q.where(PredictionAudit.created_at >= since_dt)
        if until_dt is not None:
            q = q.where(PredictionAudit.created_at < until_dt)
        rows = list(s.scalars(q))
    # Only advertise a cursor when a full page came back; a short page means
    # we've reached the end of the filtered history.
    next_cursor: int | None = None
    if len(rows) == limit and rows:
        next_cursor = int(rows[-1].id)
    return AuditListResponse(
        n=len(rows),
        items=[_row_to_model(r) for r in rows],
        next_before_id=next_cursor,
    )


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
    # Neutralize spreadsheet formula injection (OWASP CSV Injection /
    # CWE-1236) before applying RFC 4180 quoting. A user-supplied note or
    # caller id starting with '=', '+', '-', '@', tab, or CR would
    # otherwise be evaluated as a formula when the auditor opens the
    # export in Excel / Google Sheets.
    from adherence_common.csv_safe import safe_cell

    s = safe_cell(v)
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
    request_id: str | None = Query(
        None,
        description=(
            "Exact match on the per-request id propagated via the"
            " ``x-request-id`` header. Useful for pulling a single-row CSV"
            " for an incident packet."
        ),
    ),
    only_errors: bool = False,
    since: str | None = Query(
        None,
        description=(
            "Inclusive lower bound on created_at, ISO-8601 (e.g."
            " 2026-01-01T00:00:00Z). When set, overrides window_hours so an"
            " auditor can pull an exact quarter or month."
        ),
    ),
    until: str | None = Query(
        None,
        description=(
            "Exclusive upper bound on created_at, ISO-8601. When omitted,"
            " rows up to the current time are included."
        ),
    ),
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

    Time window: by default the export covers the last ``window_hours`` hours.
    Passing ``since`` (and optionally ``until``) switches to an absolute
    range, which is what compliance reviewers typically want ("all rows in
    Q1 2026", "all rows for the November SOC 2 window"). ``since`` /
    ``until`` accept ISO-8601 with or without a ``Z`` suffix.
    """
    init_db()
    since_dt = _parse_iso_dt("since", since)
    until_dt = _parse_iso_dt("until", until)
    if since_dt and until_dt and until_dt <= since_dt:
        raise HTTPException(status_code=400, detail="until must be after since")
    if since_dt is not None:
        lower = since_dt
    else:
        lower = datetime.utcnow() - timedelta(hours=window_hours)
    target = tenant or str(p.get("tenant") or "default")
    require_tenant_access(target, p, request)
    with session() as s:
        q = (
            select(PredictionAudit)
            .where(PredictionAudit.created_at >= lower)
            .order_by(PredictionAudit.id.asc())
            .limit(limit)
        )
        if until_dt is not None:
            q = q.where(PredictionAudit.created_at < until_dt)
        if target != "*":
            q = q.where(PredictionAudit.tenant_id == target)
        if user_id:
            q = q.where(PredictionAudit.user_id == user_id)
        if route:
            q = q.where(PredictionAudit.route == route)
        if model_name:
            q = q.where(PredictionAudit.model_name == model_name)
        if request_id:
            q = q.where(PredictionAudit.request_id == request_id)
        if only_errors:
            q = q.where(PredictionAudit.ok == 0)
        rows = list(s.scalars(q))
    if since_dt is not None and until_dt is not None:
        filename = (
            f"audit_{since_dt.strftime('%Y%m%dT%H%M%SZ')}"
            f"_to_{until_dt.strftime('%Y%m%dT%H%M%SZ')}.csv"
        )
    elif since_dt is not None:
        filename = f"audit_{since_dt.strftime('%Y%m%dT%H%M%SZ')}_onwards.csv"
    else:
        filename = f"audit_{lower.strftime('%Y%m%dT%H%M%SZ')}.csv"
    return StreamingResponse(
        _stream_csv(rows),
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Row-Count": str(len(rows)),
        },
    )
