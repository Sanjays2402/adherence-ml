"""Per-API-key usage history endpoints.

Read-only by design: usage rows are written by the auth dependency on every
successful key resolution. Admins (and machine principals with the
``api_key:read`` scope) can inspect a key's last N days of traffic for
chargeback, capacity planning, or abuse review.

Every read is audit-logged with the requesting principal, the key under
inspection, and the requested window so a compliance reviewer can later
prove who looked at whose traffic.
"""
from __future__ import annotations

from datetime import date
from typing import Annotated

from adherence_common import api_keys as ak
from adherence_common import api_key_usage as aku
from adherence_common.admin_audit import record_admin_action
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import require_admin


router = APIRouter(prefix="/v1/admin/api-keys", tags=["admin"])


class UsagePoint(BaseModel):
    day: date
    count: int


class UsageOut(BaseModel):
    name: str
    window_days: int
    total: int
    peak_day: date | None
    peak_count: int
    points: list[UsagePoint]


class UsageRowOut(BaseModel):
    name: str
    role: str
    tenant_id: str
    total: int
    peak_count: int
    revoked: bool


class UsageListOut(BaseModel):
    window_days: int
    rows: list[UsageRowOut]


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _validate_days(days: int) -> int:
    if days < 1 or days > 90:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="days must be between 1 and 90",
        )
    return days


@router.get("/{name}/usage", response_model=UsageOut)
def get_key_usage(
    name: str,
    request: Request,
    days: Annotated[int, Query(ge=1, le=90)] = 30,
    p=Depends(require_admin),
) -> UsageOut:
    """Return daily request counts for a single key over the window.

    The window is zero-filled so the chart on the admin UI does not need
    to bridge gaps client-side. A 404 is returned when no key with that
    name has ever existed, so operators can distinguish "never created"
    from "created but never used".
    """
    days = _validate_days(days)
    # Confirm the key exists. We deliberately keep listing usage allowed
    # for revoked keys so auditors can still inspect historical traffic.
    keys = {k.name: k for k in ak.list_keys()}
    if name not in keys:
        record_admin_action(
            action="api_key.usage.read",
            principal=p,
            target=name,
            details={"days": days},
            ok=False,
            error="not found",
            request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="unknown api key")
    summary = aku.get_usage(name, days=days)
    record_admin_action(
        action="api_key.usage.read",
        principal=p,
        target=name,
        details={"days": days, "total": summary.total},
        request_id=_rid(request),
    )
    return UsageOut(
        name=summary.name,
        window_days=summary.window_days,
        total=summary.total,
        peak_day=summary.peak_day,
        peak_count=summary.peak_count,
        points=[UsagePoint(day=p.day, count=p.count) for p in summary.points],
    )


@router.get("/usage", response_model=UsageListOut)
def list_key_usage(
    request: Request,
    days: Annotated[int, Query(ge=1, le=90)] = 30,
    p=Depends(require_admin),
) -> UsageListOut:
    """Roll-up of every key's traffic over the window.

    Intended for the admin overview table: one row per key with total
    calls and peak day count, so an operator can spot the noisy keys
    without paging through history.
    """
    days = _validate_days(days)
    keys = ak.list_keys()
    summaries = aku.get_usage_bulk((k.name for k in keys), days=days)
    rows: list[UsageRowOut] = []
    for k in keys:
        s = summaries[k.name]
        rows.append(
            UsageRowOut(
                name=k.name,
                role=k.role,
                tenant_id=k.tenant_id or "default",
                total=s.total,
                peak_count=s.peak_count,
                revoked=k.revoked_at is not None,
            )
        )
    # Highest-traffic keys first; ties broken by name for stable output.
    rows.sort(key=lambda r: (-r.total, r.name))
    record_admin_action(
        action="api_key.usage.list",
        principal=p,
        target="*",
        details={"days": days, "key_count": len(rows)},
        request_id=_rid(request),
    )
    return UsageListOut(window_days=days, rows=rows)


class PurgeIn(BaseModel):
    before: date = Field(
        ...,
        description=(
            "Delete usage rows strictly older than this UTC date. "
            "Use this for retention policy enforcement; does not affect "
            "the credential itself."
        ),
    )


class PurgeOut(BaseModel):
    deleted: int
    before: date


@router.post("/usage/purge", response_model=PurgeOut)
def purge_usage(
    body: PurgeIn,
    request: Request,
    dry_run: bool = Query(
        False,
        description="Preview the row count without deleting.",
    ),
    p=Depends(require_admin),
) -> PurgeOut:
    """Drop usage history strictly older than the cutoff date."""
    if dry_run:
        # Lightweight count via the summary API would require listing all
        # keys; fall back to a single SELECT on the underlying table.
        from sqlalchemy import select, func
        from adherence_common.db import init_db, session
        init_db()
        with session() as s:
            n = s.execute(
                select(func.count()).select_from(aku.APIKeyUsageDaily).where(
                    aku.APIKeyUsageDaily.day < body.before,
                )
            ).scalar_one()
        record_admin_action(
            action="api_key.usage.purge",
            principal=p,
            target="*",
            details={"before": body.before.isoformat(), "dry_run": True, "would_delete": int(n)},
            request_id=_rid(request),
        )
        return PurgeOut(deleted=int(n), before=body.before)
    deleted = aku.purge_before(body.before)
    record_admin_action(
        action="api_key.usage.purge",
        principal=p,
        target="*",
        details={"before": body.before.isoformat(), "deleted": deleted},
        request_id=_rid(request),
    )
    return PurgeOut(deleted=deleted, before=body.before)
