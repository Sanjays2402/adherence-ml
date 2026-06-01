"""/v1/admin/maintenance: per-tenant scheduled maintenance window register.

Reads require ``viewer``. Mutations require ``admin`` and an active MFA
challenge. Every mutation writes an admin audit row. All queries are
strictly tenant-scoped.
"""
from __future__ import annotations

import csv
import io
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from adherence_api.deps import current_tenant, require_admin, require_viewer
from adherence_api.dry_run import dry_run_response
from adherence_api.routes.admin_mfa import require_admin_mfa
from adherence_common import maintenance as maint_mod
from adherence_common.admin_audit import record_admin_action
from adherence_common.logging import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/v1/admin/maintenance", tags=["maintenance"])
public_router = APIRouter(prefix="/v1/maintenance", tags=["maintenance"])


class WindowOut(BaseModel):
    id: int
    tenant_id: str
    title: str
    description: str
    category: str
    impact: str
    starts_at: str
    ends_at: str
    duration_seconds: int
    status: str
    version: int
    created_by: str
    created_at: str
    updated_by: Optional[str] = None
    updated_at: Optional[str] = None
    archived_by: Optional[str] = None
    archived_at: Optional[str] = None
    archive_reason: Optional[str] = None
    active: bool


class WindowListOut(BaseModel):
    tenant_id: str
    active_count: int
    archived_count: int
    in_flight_count: int
    upcoming_count: int
    entries: list[WindowOut]


class ActiveOut(BaseModel):
    tenant_id: str
    as_of: str
    in_flight: list[WindowOut]


class CreateWindowIn(BaseModel):
    title: str = Field(
        ...,
        min_length=maint_mod.MIN_TITLE_LEN,
        max_length=maint_mod.MAX_TITLE_LEN,
    )
    description: str = Field(
        ...,
        min_length=maint_mod.MIN_DESCRIPTION_LEN,
        max_length=maint_mod.MAX_DESCRIPTION_LEN,
    )
    category: str
    impact: str
    starts_at: str
    ends_at: str


class UpdateWindowIn(BaseModel):
    title: Optional[str] = Field(
        None, min_length=maint_mod.MIN_TITLE_LEN, max_length=maint_mod.MAX_TITLE_LEN
    )
    description: Optional[str] = Field(
        None,
        min_length=maint_mod.MIN_DESCRIPTION_LEN,
        max_length=maint_mod.MAX_DESCRIPTION_LEN,
    )
    category: Optional[str] = None
    impact: Optional[str] = None
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None


class ArchiveWindowIn(BaseModel):
    reason: Optional[str] = Field(None, max_length=256)


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _to_out(v: maint_mod.MaintenanceView) -> WindowOut:
    return WindowOut(**v.__dict__)


@router.get("", response_model=WindowListOut)
def list_maintenance(
    include_archived: bool = Query(False),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> WindowListOut:
    entries = maint_mod.list_windows(
        tenant_id=tenant,
        include_archived=include_archived,
        limit=limit,
        offset=offset,
    )
    active = sum(1 for e in entries if e.active)
    archived = sum(1 for e in entries if not e.active)
    in_flight = sum(1 for e in entries if e.status == "active")
    upcoming = sum(1 for e in entries if e.status == "scheduled")
    return WindowListOut(
        tenant_id=tenant,
        active_count=active,
        archived_count=archived,
        in_flight_count=in_flight,
        upcoming_count=upcoming,
        entries=[_to_out(e) for e in entries],
    )


@router.get("/export.csv")
def export_maintenance_csv(
    include_archived: bool = Query(False),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
):
    entries = maint_mod.list_windows(
        tenant_id=tenant, include_archived=include_archived, limit=500, offset=0
    )
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([
        "id", "title", "description", "category", "impact",
        "starts_at", "ends_at", "duration_seconds", "status", "version",
        "created_by", "created_at", "updated_by", "updated_at",
        "archived_by", "archived_at", "archive_reason",
    ])
    for e in entries:
        w.writerow([
            e.id, e.title, e.description, e.category, e.impact,
            e.starts_at, e.ends_at, e.duration_seconds, e.status, e.version,
            e.created_by, e.created_at, e.updated_by or "", e.updated_at or "",
            e.archived_by or "", e.archived_at or "", e.archive_reason or "",
        ])
    data = buf.getvalue()
    fname = f"maintenance-{tenant}.csv"
    return StreamingResponse(
        iter([data]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/{window_id}", response_model=WindowOut)
def get_one(
    window_id: int,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> WindowOut:
    v = maint_mod.get_window(tenant_id=tenant, window_id=window_id)
    if v is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    return _to_out(v)


@router.post("", response_model=WindowOut, status_code=201)
def create(
    body: CreateWindowIn,
    request: Request,
    dry_run: bool = Query(False),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.maintenance.create",
            principal=p,
            target=tenant,
            details={
                "title": body.title,
                "category": body.category,
                "impact": body.impact,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="schedule_maintenance_window",
            tenant_id=tenant,
            title=body.title,
            starts_at=body.starts_at,
            ends_at=body.ends_at,
        )
    try:
        view = maint_mod.create_window(
            tenant_id=tenant,
            title=body.title,
            description=body.description,
            category=body.category,
            impact=body.impact,
            starts_at=body.starts_at,
            ends_at=body.ends_at,
            created_by=caller,
        )
    except maint_mod.MaintenanceError as exc:
        record_admin_action(
            action="workspace.maintenance.create",
            principal=p,
            target=tenant,
            details={"title": body.title},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.maintenance.create",
        principal=p,
        target=tenant,
        details={
            "id": view.id,
            "title": view.title,
            "category": view.category,
            "impact": view.impact,
            "starts_at": view.starts_at,
            "ends_at": view.ends_at,
        },
        request_id=_rid(request),
    )
    log.info(
        "maintenance_window_created",
        tenant=tenant, window_id=view.id, caller=caller,
    )
    return _to_out(view)


@router.put("/{window_id}", response_model=WindowOut)
def update(
    window_id: int,
    body: UpdateWindowIn,
    request: Request,
    dry_run: bool = Query(False),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = maint_mod.get_window(tenant_id=tenant, window_id=window_id)
    if existing is None or not existing.active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    if dry_run:
        record_admin_action(
            action="workspace.maintenance.update",
            principal=p,
            target=str(window_id),
            details={
                "dry_run": True,
                "fields": [k for k, v in body.dict().items() if v is not None],
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="update_maintenance_window",
            tenant_id=tenant,
            window_id=window_id,
        )
    try:
        view = maint_mod.update_window(
            tenant_id=tenant,
            window_id=window_id,
            updated_by=caller,
            title=body.title,
            description=body.description,
            category=body.category,
            impact=body.impact,
            starts_at=body.starts_at,
            ends_at=body.ends_at,
        )
    except maint_mod.MaintenanceError as exc:
        record_admin_action(
            action="workspace.maintenance.update",
            principal=p,
            target=str(window_id),
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    if view is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    record_admin_action(
        action="workspace.maintenance.update",
        principal=p,
        target=str(window_id),
        details={
            "version": view.version,
            "starts_at": view.starts_at,
            "ends_at": view.ends_at,
            "impact": view.impact,
        },
        request_id=_rid(request),
    )
    return _to_out(view)


@router.post("/{window_id}/archive", response_model=WindowOut)
def archive(
    window_id: int,
    request: Request,
    body: ArchiveWindowIn | None = None,
    dry_run: bool = Query(False),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    reason = body.reason if body is not None else None
    existing = maint_mod.get_window(tenant_id=tenant, window_id=window_id)
    if existing is None:
        record_admin_action(
            action="workspace.maintenance.archive",
            principal=p,
            target=str(window_id),
            details={"dry_run": dry_run},
            ok=False,
            error="not found",
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    if not existing.active:
        record_admin_action(
            action="workspace.maintenance.archive",
            principal=p,
            target=str(window_id),
            details={"dry_run": dry_run},
            ok=False,
            error="already cancelled",
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="window already cancelled",
        )
    if dry_run:
        record_admin_action(
            action="workspace.maintenance.archive",
            principal=p,
            target=str(window_id),
            details={"dry_run": True, "reason": reason},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="cancel_maintenance_window",
            tenant_id=tenant,
            window_id=window_id,
        )
    try:
        view = maint_mod.archive_window(
            tenant_id=tenant,
            window_id=window_id,
            archived_by=caller,
            reason=reason,
        )
    except maint_mod.MaintenanceError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    if view is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="window not found or already cancelled",
        )
    record_admin_action(
        action="workspace.maintenance.archive",
        principal=p,
        target=str(window_id),
        details={"reason": reason},
        request_id=_rid(request),
    )
    log.info(
        "maintenance_window_cancelled",
        tenant=tenant, window_id=window_id, caller=caller,
    )
    return _to_out(view)


@public_router.get("/active", response_model=ActiveOut)
def active(
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> ActiveOut:
    """Return the windows currently in flight for the caller's tenant."""
    now = datetime.utcnow().replace(microsecond=0)
    in_flight = maint_mod.active_windows(tenant, at=now)
    return ActiveOut(
        tenant_id=tenant,
        as_of=now.isoformat() + "Z",
        in_flight=[_to_out(v) for v in in_flight],
    )
