"""/v1/admin/changes: per-tenant change management register.

Every enterprise procurement review and every SOC 2 / ISO 27001
audit expects a register of production change requests with
authorisation, rollback plan, and a post implementation review.
Without that evidence the buyer's security team cannot sign.

* ``GET    /v1/admin/changes`` lists changes (active by default).
* ``POST   /v1/admin/changes`` files a new change request.
* ``GET    /v1/admin/changes/{id}`` returns one change.
* ``PUT    /v1/admin/changes/{id}`` updates a non-terminal change.
* ``POST   /v1/admin/changes/{id}/transition`` moves the change
  through the workflow (approve, start, complete, roll back, cancel).
* ``POST   /v1/admin/changes/{id}/archive`` archives a change
  without destroying the record.
* ``GET    /v1/admin/changes/export.csv`` returns the register as a
  CSV download for procurement and audit packs.

Reads require ``viewer`` and above. Mutations require ``admin`` and
an active MFA challenge, mirroring DPIA, RoPA, BCDR, pentests,
incidents, and retention policy. Every mutation writes an admin
audit row. All queries are strictly tenant-scoped.
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
from adherence_common import change_management as cm_mod
from adherence_common.csv_safe import safe_row
from adherence_common.admin_audit import record_admin_action
from adherence_common.logging import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/v1/admin/changes", tags=["changes"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ChangeOut(BaseModel):
    id: int
    tenant_id: str
    reference: Optional[str] = None
    title: str
    change_type: str
    risk_class: str
    affected_service: str
    rollback_plan: str
    notes: Optional[str] = None
    review_summary: Optional[str] = None
    requester_email: str
    approver_email: Optional[str] = None
    status: str
    planned_start_at: Optional[str] = None
    planned_end_at: Optional[str] = None
    actual_start_at: Optional[str] = None
    actual_end_at: Optional[str] = None
    approved_at: Optional[str] = None
    approved_by: Optional[str] = None
    is_terminal: bool
    is_overdue: bool
    requires_approver: bool
    has_review: bool
    version: int
    created_by: str
    created_at: str
    updated_by: Optional[str] = None
    updated_at: Optional[str] = None
    archived_by: Optional[str] = None
    archived_at: Optional[str] = None
    active: bool


class ChangeListOut(BaseModel):
    tenant_id: str
    active_count: int
    archived_count: int
    open_count: int
    overdue_count: int
    highest_open_risk: str
    entries: list[ChangeOut]


class CreateChangeIn(BaseModel):
    title: str = Field(
        ...,
        min_length=cm_mod.MIN_TITLE_LEN,
        max_length=cm_mod.MAX_TITLE_LEN,
    )
    change_type: str = Field(
        ...,
        description=(
            "Change type. One of: " + ", ".join(cm_mod.CHANGE_TYPES)
        ),
    )
    risk_class: str = Field(
        ...,
        description=(
            "Risk class. One of: " + ", ".join(cm_mod.RISK_CLASSES)
        ),
    )
    affected_service: str = Field(
        ..., min_length=2, max_length=cm_mod.MAX_SERVICE_LEN
    )
    rollback_plan: str = Field(
        ..., min_length=4, max_length=cm_mod.MAX_ROLLBACK_LEN
    )
    requester_email: str = Field(..., max_length=cm_mod.MAX_EMAIL_LEN)
    approver_email: Optional[str] = Field(
        None,
        max_length=cm_mod.MAX_EMAIL_LEN,
        description=(
            "Required and must differ from requester_email for high or "
            "critical risk and for emergency changes."
        ),
    )
    notes: Optional[str] = Field(None, max_length=cm_mod.MAX_NOTES_LEN)
    reference: Optional[str] = Field(None, max_length=cm_mod.MAX_REF_LEN)
    planned_start_at: Optional[datetime] = None
    planned_end_at: Optional[datetime] = None


class UpdateChangeIn(BaseModel):
    title: Optional[str] = Field(
        None,
        min_length=cm_mod.MIN_TITLE_LEN,
        max_length=cm_mod.MAX_TITLE_LEN,
    )
    change_type: Optional[str] = None
    risk_class: Optional[str] = None
    affected_service: Optional[str] = Field(
        None, min_length=2, max_length=cm_mod.MAX_SERVICE_LEN
    )
    rollback_plan: Optional[str] = Field(
        None, min_length=4, max_length=cm_mod.MAX_ROLLBACK_LEN
    )
    approver_email: Optional[str] = Field(
        None, max_length=cm_mod.MAX_EMAIL_LEN
    )
    notes: Optional[str] = Field(None, max_length=cm_mod.MAX_NOTES_LEN)
    planned_start_at: Optional[datetime] = None
    planned_end_at: Optional[datetime] = None


class TransitionIn(BaseModel):
    target_status: str = Field(
        ...,
        description=(
            "Target status. One of: approved, in_progress, completed, "
            "rolled_back, cancelled."
        ),
    )
    actor_email: str = Field(..., max_length=cm_mod.MAX_EMAIL_LEN)
    review_summary: Optional[str] = Field(
        None,
        max_length=cm_mod.MAX_REVIEW_LEN,
        description=(
            "Required when transitioning to completed or rolled_back."
        ),
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _strip_tz(d: Optional[datetime]) -> Optional[datetime]:
    if d is None:
        return None
    return d.replace(tzinfo=None) if d.tzinfo is not None else d


def _to_out(v: cm_mod.ChangeView) -> ChangeOut:
    return ChangeOut(**v.__dict__)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=ChangeListOut)
def list_changes(
    include_archived: bool = Query(False),
    status_filter: Optional[str] = Query(None, alias="status"),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> ChangeListOut:
    entries = cm_mod.list_changes(
        tenant_id=tenant,
        include_archived=include_archived,
        status=status_filter,
        limit=limit,
        offset=offset,
    )
    active = sum(1 for e in entries if e.active)
    archived = sum(1 for e in entries if not e.active)
    return ChangeListOut(
        tenant_id=tenant,
        active_count=active,
        archived_count=archived,
        open_count=cm_mod.open_count(tenant),
        overdue_count=cm_mod.overdue_count(tenant),
        highest_open_risk=cm_mod.highest_open_risk(tenant),
        entries=[_to_out(e) for e in entries],
    )


@router.get("/export.csv")
def export_changes_csv(
    include_archived: bool = Query(False),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
):
    """Stream the register as CSV for procurement and audit packs."""
    entries = cm_mod.list_changes(
        tenant_id=tenant,
        include_archived=include_archived,
        limit=500,
        offset=0,
    )
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "id",
            "reference",
            "title",
            "change_type",
            "risk_class",
            "affected_service",
            "status",
            "requester_email",
            "approver_email",
            "approved_by",
            "approved_at",
            "planned_start_at",
            "planned_end_at",
            "actual_start_at",
            "actual_end_at",
            "is_overdue",
            "rollback_plan",
            "review_summary",
            "notes",
            "version",
            "created_by",
            "created_at",
            "updated_by",
            "updated_at",
            "archived_by",
            "archived_at",
        ]
    )
    for e in entries:
        w.writerow(safe_row(
            [
                e.id,
                e.reference or "",
                e.title,
                e.change_type,
                e.risk_class,
                e.affected_service,
                e.status,
                e.requester_email,
                e.approver_email or "",
                e.approved_by or "",
                e.approved_at or "",
                e.planned_start_at or "",
                e.planned_end_at or "",
                e.actual_start_at or "",
                e.actual_end_at or "",
                "yes" if e.is_overdue else "no",
                e.rollback_plan,
                e.review_summary or "",
                e.notes or "",
                e.version,
                e.created_by,
                e.created_at,
                e.updated_by or "",
                e.updated_at or "",
                e.archived_by or "",
                e.archived_at or "",
            ]
        ))
    data = buf.getvalue()
    fname = f"changes-{tenant}.csv"
    return StreamingResponse(
        iter([data]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/{change_id}", response_model=ChangeOut)
def get_one(
    change_id: int,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> ChangeOut:
    v = cm_mod.get_change(tenant_id=tenant, change_id=change_id)
    if v is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    return _to_out(v)


@router.post("", response_model=ChangeOut, status_code=201)
def create(
    body: CreateChangeIn,
    request: Request,
    dry_run: bool = Query(False, description="Preview without persisting."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.changes.create",
            principal=p,
            target=tenant,
            details={
                "title": body.title,
                "change_type": body.change_type,
                "risk_class": body.risk_class,
                "affected_service": body.affected_service,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="create_change_request",
            tenant_id=tenant,
            title=body.title,
            change_type=body.change_type,
            risk_class=body.risk_class,
        )
    try:
        view = cm_mod.create_change(
            tenant_id=tenant,
            title=body.title,
            change_type=body.change_type,
            risk_class=body.risk_class,
            affected_service=body.affected_service,
            rollback_plan=body.rollback_plan,
            requester_email=body.requester_email,
            created_by=caller,
            approver_email=body.approver_email,
            notes=body.notes,
            reference=body.reference,
            planned_start_at=_strip_tz(body.planned_start_at),
            planned_end_at=_strip_tz(body.planned_end_at),
        )
    except cm_mod.ChangeError as exc:
        record_admin_action(
            action="workspace.changes.create",
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
        action="workspace.changes.create",
        principal=p,
        target=tenant,
        details={
            "id": view.id,
            "title": view.title,
            "change_type": view.change_type,
            "risk_class": view.risk_class,
            "affected_service": view.affected_service,
            "requester_email": view.requester_email,
            "approver_email": view.approver_email,
        },
        request_id=_rid(request),
    )
    log.info(
        "change_request_created",
        tenant=tenant,
        change_id=view.id,
        risk_class=view.risk_class,
        caller=caller,
    )
    return _to_out(view)


@router.put("/{change_id}", response_model=ChangeOut)
def update(
    change_id: int,
    body: UpdateChangeIn,
    request: Request,
    dry_run: bool = Query(False, description="Preview without persisting."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = cm_mod.get_change(tenant_id=tenant, change_id=change_id)
    if existing is None or not existing.active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    if dry_run:
        record_admin_action(
            action="workspace.changes.update",
            principal=p,
            target=str(change_id),
            details={
                "dry_run": True,
                "fields": [k for k, v in body.dict().items() if v is not None],
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="update_change_request",
            tenant_id=tenant,
            change_id=change_id,
        )
    try:
        view = cm_mod.update_change(
            tenant_id=tenant,
            change_id=change_id,
            updated_by=caller,
            title=body.title,
            change_type=body.change_type,
            risk_class=body.risk_class,
            affected_service=body.affected_service,
            rollback_plan=body.rollback_plan,
            approver_email=body.approver_email,
            notes=body.notes,
            planned_start_at=_strip_tz(body.planned_start_at),
            planned_end_at=_strip_tz(body.planned_end_at),
        )
    except cm_mod.ChangeError as exc:
        record_admin_action(
            action="workspace.changes.update",
            principal=p,
            target=str(change_id),
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
        action="workspace.changes.update",
        principal=p,
        target=str(change_id),
        details={
            "version": view.version,
            "risk_class": view.risk_class,
            "change_type": view.change_type,
        },
        request_id=_rid(request),
    )
    return _to_out(view)


@router.post("/{change_id}/transition", response_model=ChangeOut)
def transition(
    change_id: int,
    body: TransitionIn,
    request: Request,
    dry_run: bool = Query(False, description="Preview without recording."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = cm_mod.get_change(tenant_id=tenant, change_id=change_id)
    if existing is None or not existing.active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    if dry_run:
        record_admin_action(
            action="workspace.changes.transition",
            principal=p,
            target=str(change_id),
            details={
                "dry_run": True,
                "target_status": body.target_status,
                "actor_email": body.actor_email,
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="transition_change_request",
            tenant_id=tenant,
            change_id=change_id,
            target_status=body.target_status,
        )
    try:
        view = cm_mod.transition_change(
            tenant_id=tenant,
            change_id=change_id,
            target_status=body.target_status,
            actor_email=body.actor_email,
            actor=caller,
            review_summary=body.review_summary,
        )
    except cm_mod.ChangeError as exc:
        record_admin_action(
            action="workspace.changes.transition",
            principal=p,
            target=str(change_id),
            details={
                "target_status": body.target_status,
                "actor_email": body.actor_email,
            },
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
        action="workspace.changes.transition",
        principal=p,
        target=str(change_id),
        details={
            "target_status": body.target_status,
            "actor_email": body.actor_email,
            "version": view.version,
            "status": view.status,
        },
        request_id=_rid(request),
    )
    log.info(
        "change_request_transition",
        tenant=tenant,
        change_id=change_id,
        target_status=body.target_status,
        caller=caller,
    )
    return _to_out(view)


@router.post("/{change_id}/archive", response_model=ChangeOut)
def archive(
    change_id: int,
    request: Request,
    dry_run: bool = Query(False, description="Preview without archiving."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = cm_mod.get_change(tenant_id=tenant, change_id=change_id)
    if existing is None:
        record_admin_action(
            action="workspace.changes.archive",
            principal=p,
            target=str(change_id),
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
            action="workspace.changes.archive",
            principal=p,
            target=str(change_id),
            details={"dry_run": dry_run},
            ok=False,
            error="already archived",
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="change already archived",
        )
    if dry_run:
        record_admin_action(
            action="workspace.changes.archive",
            principal=p,
            target=str(change_id),
            details={"dry_run": True},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="archive_change_request",
            tenant_id=tenant,
            change_id=change_id,
        )
    view = cm_mod.archive_change(
        tenant_id=tenant, change_id=change_id, archived_by=caller
    )
    if view is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="change not found or already archived",
        )
    record_admin_action(
        action="workspace.changes.archive",
        principal=p,
        target=str(change_id),
        request_id=_rid(request),
    )
    log.info(
        "change_request_archived",
        tenant=tenant,
        change_id=change_id,
        caller=caller,
    )
    return _to_out(view)
