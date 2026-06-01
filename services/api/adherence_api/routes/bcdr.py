"""/v1/admin/bcdr: per-tenant Business Continuity and Disaster Recovery declarations.

Every enterprise procurement review asks the vendor to declare, per
service tier, its Recovery Time Objective (RTO), Recovery Point
Objective (RPO), disaster recovery strategy, runbook reference, and
the date of the last successful DR test. Without that evidence in
writing, scoped to the workspace they are buying, the deal stalls in
security review.

* ``GET    /v1/admin/bcdr`` lists entries (active by default).
* ``POST   /v1/admin/bcdr`` creates a new declaration.
* ``GET    /v1/admin/bcdr/{id}`` returns one entry.
* ``PUT    /v1/admin/bcdr/{id}`` updates an entry and bumps version.
* ``POST   /v1/admin/bcdr/{id}/test`` records a DR test outcome.
* ``POST   /v1/admin/bcdr/{id}/archive`` archives an entry without
  destroying the historical record.
* ``GET    /v1/admin/bcdr/export.csv`` returns the register as a CSV
  download for procurement and audit packs.

Reads require ``viewer`` and above. Mutations require ``admin`` and
an active MFA challenge, mirroring DPIA, RoPA, legal hold, incidents,
and retention policy. Every mutation writes an admin audit row. All
queries are strictly tenant-scoped: there is no cross-tenant code
path on this router.
"""
from __future__ import annotations

import csv
import io
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from adherence_api.deps import current_tenant, require_admin, require_viewer
from adherence_api.dry_run import dry_run_response
from adherence_api.routes.admin_mfa import require_admin_mfa
from adherence_common import bcdr as bcdr_mod
from adherence_common.admin_audit import record_admin_action
from adherence_common.logging import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/v1/admin/bcdr", tags=["bcdr"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class BcdrOut(BaseModel):
    id: int
    tenant_id: str
    service_name: str
    tier: str
    rto_minutes: int
    rpo_minutes: int
    strategy: str
    runbook_url: Optional[str] = None
    notes: Optional[str] = None
    last_tested_at: Optional[str] = None
    last_outcome: str
    last_test_notes: Optional[str] = None
    test_cadence_days: int
    next_test_due_at: str
    test_overdue: bool
    version: int
    created_by: str
    created_at: str
    updated_by: Optional[str] = None
    updated_at: Optional[str] = None
    archived_by: Optional[str] = None
    archived_at: Optional[str] = None
    active: bool


class BcdrListOut(BaseModel):
    tenant_id: str
    active_count: int
    archived_count: int
    overdue_count: int
    entries: list[BcdrOut]


class CreateBcdrIn(BaseModel):
    service_name: str = Field(
        ...,
        min_length=bcdr_mod.MIN_NAME_LEN,
        max_length=bcdr_mod.MAX_NAME_LEN,
        description="Short name for the service or capability being declared.",
    )
    tier: str = Field(
        ...,
        description="Recovery tier. One of: " + ", ".join(bcdr_mod.TIERS),
    )
    rto_minutes: int = Field(
        ...,
        ge=0,
        le=bcdr_mod.MAX_RTO_MINUTES,
        description="Recovery Time Objective in minutes.",
    )
    rpo_minutes: int = Field(
        ...,
        ge=0,
        le=bcdr_mod.MAX_RPO_MINUTES,
        description="Recovery Point Objective in minutes.",
    )
    strategy: str = Field(
        ...,
        description="DR strategy. One of: " + ", ".join(bcdr_mod.STRATEGIES),
    )
    runbook_url: Optional[str] = Field(
        None,
        max_length=bcdr_mod.MAX_RUNBOOK_LEN,
        description="Link to the runbook. Must start with http:// or https://.",
    )
    notes: Optional[str] = Field(
        None,
        max_length=bcdr_mod.MAX_NOTES_LEN,
        description="Free-text declaration notes.",
    )
    test_cadence_days: Optional[int] = Field(
        None,
        ge=bcdr_mod.MIN_TEST_CADENCE_DAYS,
        le=bcdr_mod.MAX_TEST_CADENCE_DAYS,
        description=(
            "Days between scheduled DR tests. Defaults to "
            f"{bcdr_mod.DEFAULT_TEST_CADENCE_DAYS}."
        ),
    )


class UpdateBcdrIn(BaseModel):
    tier: Optional[str] = None
    rto_minutes: Optional[int] = Field(
        None, ge=0, le=bcdr_mod.MAX_RTO_MINUTES
    )
    rpo_minutes: Optional[int] = Field(
        None, ge=0, le=bcdr_mod.MAX_RPO_MINUTES
    )
    strategy: Optional[str] = None
    runbook_url: Optional[str] = Field(None, max_length=bcdr_mod.MAX_RUNBOOK_LEN)
    notes: Optional[str] = Field(None, max_length=bcdr_mod.MAX_NOTES_LEN)
    test_cadence_days: Optional[int] = Field(
        None,
        ge=bcdr_mod.MIN_TEST_CADENCE_DAYS,
        le=bcdr_mod.MAX_TEST_CADENCE_DAYS,
    )


class RecordTestIn(BaseModel):
    outcome: str = Field(
        ...,
        description="Test outcome. One of: " + ", ".join(bcdr_mod.OUTCOMES),
    )
    test_notes: Optional[str] = Field(
        None, max_length=bcdr_mod.MAX_NOTES_LEN
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _to_out(v: bcdr_mod.BcdrView) -> BcdrOut:
    return BcdrOut(**v.__dict__)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=BcdrListOut)
def list_bcdr(
    include_archived: bool = Query(False),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> BcdrListOut:
    entries = bcdr_mod.list_entries(
        tenant_id=tenant,
        include_archived=include_archived,
        limit=limit,
        offset=offset,
    )
    active = sum(1 for e in entries if e.active)
    archived = sum(1 for e in entries if not e.active)
    overdue = sum(1 for e in entries if e.active and e.test_overdue)
    return BcdrListOut(
        tenant_id=tenant,
        active_count=active,
        archived_count=archived,
        overdue_count=overdue,
        entries=[_to_out(e) for e in entries],
    )


@router.get("/export.csv")
def export_bcdr_csv(
    include_archived: bool = Query(False),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
):
    """Stream the register as CSV for procurement and audit packs."""
    entries = bcdr_mod.list_entries(
        tenant_id=tenant, include_archived=include_archived, limit=500, offset=0
    )
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "id",
            "service_name",
            "tier",
            "rto_minutes",
            "rpo_minutes",
            "strategy",
            "runbook_url",
            "notes",
            "last_tested_at",
            "last_outcome",
            "last_test_notes",
            "test_cadence_days",
            "next_test_due_at",
            "test_overdue",
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
        w.writerow(
            [
                e.id,
                e.service_name,
                e.tier,
                e.rto_minutes,
                e.rpo_minutes,
                e.strategy,
                e.runbook_url or "",
                e.notes or "",
                e.last_tested_at or "",
                e.last_outcome,
                e.last_test_notes or "",
                e.test_cadence_days,
                e.next_test_due_at,
                "yes" if e.test_overdue else "no",
                e.version,
                e.created_by,
                e.created_at,
                e.updated_by or "",
                e.updated_at or "",
                e.archived_by or "",
                e.archived_at or "",
            ]
        )
    data = buf.getvalue()
    fname = f"bcdr-{tenant}.csv"
    return StreamingResponse(
        iter([data]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/{entry_id}", response_model=BcdrOut)
def get_one(
    entry_id: int,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> BcdrOut:
    v = bcdr_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if v is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    return _to_out(v)


@router.post("", response_model=BcdrOut, status_code=201)
def create(
    body: CreateBcdrIn,
    request: Request,
    dry_run: bool = Query(False, description="Preview without persisting."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.bcdr.create",
            principal=p,
            target=tenant,
            details={
                "service_name": body.service_name,
                "tier": body.tier,
                "rto_minutes": body.rto_minutes,
                "rpo_minutes": body.rpo_minutes,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="create_bcdr_entry",
            tenant_id=tenant,
            service_name=body.service_name,
            tier=body.tier,
        )
    try:
        view = bcdr_mod.create_entry(
            tenant_id=tenant,
            service_name=body.service_name,
            tier=body.tier,
            rto_minutes=body.rto_minutes,
            rpo_minutes=body.rpo_minutes,
            strategy=body.strategy,
            created_by=caller,
            runbook_url=body.runbook_url,
            notes=body.notes,
            test_cadence_days=body.test_cadence_days,
        )
    except bcdr_mod.BcdrError as exc:
        record_admin_action(
            action="workspace.bcdr.create",
            principal=p,
            target=tenant,
            details={"service_name": body.service_name},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.bcdr.create",
        principal=p,
        target=tenant,
        details={
            "id": view.id,
            "service_name": view.service_name,
            "tier": view.tier,
            "rto_minutes": view.rto_minutes,
            "rpo_minutes": view.rpo_minutes,
            "strategy": view.strategy,
        },
        request_id=_rid(request),
    )
    log.info("bcdr_entry_created", tenant=tenant, bcdr_id=view.id, caller=caller)
    return _to_out(view)


@router.put("/{entry_id}", response_model=BcdrOut)
def update(
    entry_id: int,
    body: UpdateBcdrIn,
    request: Request,
    dry_run: bool = Query(False, description="Preview without persisting."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = bcdr_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if existing is None or not existing.active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    if dry_run:
        record_admin_action(
            action="workspace.bcdr.update",
            principal=p,
            target=str(entry_id),
            details={
                "dry_run": True,
                "fields": [k for k, v in body.dict().items() if v is not None],
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="update_bcdr_entry",
            tenant_id=tenant,
            entry_id=entry_id,
        )
    try:
        view = bcdr_mod.update_entry(
            tenant_id=tenant,
            entry_id=entry_id,
            updated_by=caller,
            tier=body.tier,
            rto_minutes=body.rto_minutes,
            rpo_minutes=body.rpo_minutes,
            strategy=body.strategy,
            runbook_url=body.runbook_url,
            notes=body.notes,
            test_cadence_days=body.test_cadence_days,
        )
    except bcdr_mod.BcdrError as exc:
        record_admin_action(
            action="workspace.bcdr.update",
            principal=p,
            target=str(entry_id),
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
        action="workspace.bcdr.update",
        principal=p,
        target=str(entry_id),
        details={
            "version": view.version,
            "tier": view.tier,
            "rto_minutes": view.rto_minutes,
            "rpo_minutes": view.rpo_minutes,
        },
        request_id=_rid(request),
    )
    return _to_out(view)


@router.post("/{entry_id}/test", response_model=BcdrOut)
def record_test(
    entry_id: int,
    body: RecordTestIn,
    request: Request,
    dry_run: bool = Query(False, description="Preview without recording."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = bcdr_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if existing is None or not existing.active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    if dry_run:
        record_admin_action(
            action="workspace.bcdr.test",
            principal=p,
            target=str(entry_id),
            details={"dry_run": True, "outcome": body.outcome},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="record_bcdr_test",
            tenant_id=tenant,
            entry_id=entry_id,
            outcome=body.outcome,
        )
    try:
        view = bcdr_mod.record_test(
            tenant_id=tenant,
            entry_id=entry_id,
            outcome=body.outcome,
            tested_by=caller,
            test_notes=body.test_notes,
        )
    except bcdr_mod.BcdrError as exc:
        record_admin_action(
            action="workspace.bcdr.test",
            principal=p,
            target=str(entry_id),
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
        action="workspace.bcdr.test",
        principal=p,
        target=str(entry_id),
        details={
            "outcome": view.last_outcome,
            "last_tested_at": view.last_tested_at,
            "version": view.version,
        },
        request_id=_rid(request),
    )
    log.info(
        "bcdr_test_recorded",
        tenant=tenant,
        bcdr_id=entry_id,
        outcome=view.last_outcome,
        caller=caller,
    )
    return _to_out(view)


@router.post("/{entry_id}/archive", response_model=BcdrOut)
def archive(
    entry_id: int,
    request: Request,
    dry_run: bool = Query(False, description="Preview without archiving."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = bcdr_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if existing is None:
        record_admin_action(
            action="workspace.bcdr.archive",
            principal=p,
            target=str(entry_id),
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
            action="workspace.bcdr.archive",
            principal=p,
            target=str(entry_id),
            details={"dry_run": dry_run},
            ok=False,
            error="already archived",
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="entry already archived",
        )
    if dry_run:
        record_admin_action(
            action="workspace.bcdr.archive",
            principal=p,
            target=str(entry_id),
            details={"dry_run": True},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="archive_bcdr_entry",
            tenant_id=tenant,
            entry_id=entry_id,
        )
    view = bcdr_mod.archive_entry(
        tenant_id=tenant, entry_id=entry_id, archived_by=caller
    )
    if view is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="entry not found or already archived",
        )
    record_admin_action(
        action="workspace.bcdr.archive",
        principal=p,
        target=str(entry_id),
        request_id=_rid(request),
    )
    log.info("bcdr_entry_archived", tenant=tenant, bcdr_id=entry_id, caller=caller)
    return _to_out(view)
