"""/v1/admin/break-glass: review cross-tenant admin access events.

Every time an admin operates on a tenant other than their own (or the
fleet-wide ``*`` scope), the access is recorded in
:class:`adherence_common.break_glass.BreakGlassEvent`. This route lets
the impacted tenant's owners review those events so a SaaS vendor
cannot quietly read a customer's data without it showing up on a
dashboard the customer controls.
"""
from __future__ import annotations

from collections.abc import Iterator

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from adherence_api.deps import require_admin, require_tenant_access
from adherence_common.break_glass import (
    BreakGlassView,
    count_events,
    list_events,
)
from adherence_common.db import init_db


router = APIRouter(prefix="/v1/admin/break-glass", tags=["break-glass"])


class BreakGlassEventOut(BaseModel):
    id: int
    created_at: str
    caller: str
    caller_role: str
    source_tenant: str
    target_tenant: str
    route: str
    method: str
    justification: str
    client_ip: str | None
    request_id: str | None


class BreakGlassListResponse(BaseModel):
    n: int
    total: int
    events: list[BreakGlassEventOut]


def _to_out(v: BreakGlassView) -> BreakGlassEventOut:
    return BreakGlassEventOut(
        id=v.id,
        created_at=v.created_at.isoformat(),
        caller=v.caller,
        caller_role=v.caller_role,
        source_tenant=v.source_tenant,
        target_tenant=v.target_tenant,
        route=v.route,
        method=v.method,
        justification=v.justification,
        client_ip=v.client_ip,
        request_id=v.request_id,
    )


def _resolve_target(tenant: str | None, p: dict) -> str:
    return tenant or str(p.get("tenant") or "default")


@router.get("", response_model=BreakGlassListResponse)
def list_break_glass(
    request: Request,
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    tenant: str | None = Query(
        None,
        description=(
            "Tenant whose break-glass events to list. Defaults to caller "
            "tenant. Admin may pass '*' for fleet-wide; that itself is "
            "a break-glass action and is recorded."
        ),
    ),
    p=Depends(require_admin),
) -> BreakGlassListResponse:
    init_db()
    target = _resolve_target(tenant, p)
    require_tenant_access(target, p, request)
    filter_tenant = None if target == "*" else target
    rows = list_events(target_tenant=filter_tenant, limit=limit, offset=offset)
    total = count_events(target_tenant=filter_tenant)
    return BreakGlassListResponse(
        n=len(rows),
        total=total,
        events=[_to_out(r) for r in rows],
    )


class BreakGlassStatsRow(BaseModel):
    source_tenant: str
    caller_role: str
    n: int


class BreakGlassStatsResponse(BaseModel):
    target_tenant: str
    n_total: int
    by_source: list[BreakGlassStatsRow]


@router.get("/stats", response_model=BreakGlassStatsResponse)
def break_glass_stats(
    request: Request,
    tenant: str | None = Query(None),
    p=Depends(require_admin),
) -> BreakGlassStatsResponse:
    init_db()
    target = _resolve_target(tenant, p)
    require_tenant_access(target, p, request)
    filter_tenant = None if target == "*" else target
    rows = list_events(target_tenant=filter_tenant, limit=1000, offset=0)
    counts: dict[tuple[str, str], int] = {}
    for r in rows:
        key = (r.source_tenant, r.caller_role)
        counts[key] = counts.get(key, 0) + 1
    by_source = [
        BreakGlassStatsRow(source_tenant=src, caller_role=role, n=n)
        for (src, role), n in sorted(counts.items(), key=lambda kv: -kv[1])
    ]
    return BreakGlassStatsResponse(
        target_tenant=target,
        n_total=count_events(target_tenant=filter_tenant),
        by_source=by_source,
    )


def _csv_escape(v: object) -> str:
    s = "" if v is None else str(v)
    if any(c in s for c in (",", '"', "\n", "\r")):
        return '"' + s.replace('"', '""') + '"'
    return s


_CSV_HEADER = (
    "id,created_at,caller,caller_role,source_tenant,target_tenant,"
    "method,route,client_ip,request_id,justification\n"
)


def _stream_csv(rows: list[BreakGlassView]) -> Iterator[str]:
    yield _CSV_HEADER
    for r in rows:
        yield ",".join(
            _csv_escape(x)
            for x in (
                r.id,
                r.created_at.isoformat(),
                r.caller,
                r.caller_role,
                r.source_tenant,
                r.target_tenant,
                r.method,
                r.route,
                r.client_ip,
                r.request_id,
                r.justification,
            )
        ) + "\n"


@router.get("/export.csv")
def export_csv(
    request: Request,
    limit: int = Query(10_000, ge=1, le=100_000),
    tenant: str | None = Query(None),
    p=Depends(require_admin),
) -> StreamingResponse:
    init_db()
    target = _resolve_target(tenant, p)
    require_tenant_access(target, p, request)
    filter_tenant = None if target == "*" else target
    rows = list_events(target_tenant=filter_tenant, limit=limit, offset=0)
    fname = f"break-glass-{target.replace('*', 'all')}.csv"
    return StreamingResponse(
        _stream_csv(rows),
        media_type="text/csv; charset=utf-8",
        headers={"content-disposition": f'attachment; filename="{fname}"'},
    )
