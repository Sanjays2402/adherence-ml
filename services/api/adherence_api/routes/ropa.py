"""/v1/admin/ropa: per-tenant GDPR Article 30 Record of Processing Activities.

Every processor of EU personal data must keep a written record of the
processing activities it carries out on behalf of each controller. This
router exposes that register as REST so a workspace owner can answer
their own auditor or regulator without leaving the product.

* ``GET    /v1/admin/ropa`` lists entries (active by default).
* ``POST   /v1/admin/ropa`` creates a new entry.
* ``GET    /v1/admin/ropa/{id}`` returns one entry.
* ``PUT    /v1/admin/ropa/{id}`` updates one entry and bumps version.
* ``POST   /v1/admin/ropa/{id}/archive`` archives one entry without
  destroying the historical record.
* ``GET    /v1/admin/ropa/export.csv`` returns the active register as a
  CSV download for procurement and audit packs.

Reads require ``viewer`` and above. Mutations require ``admin`` *and*
an active MFA challenge, mirroring legal hold, retention policy, and
incidents. Every mutation writes an admin audit row. All queries are
strictly tenant-scoped: there is no cross-tenant read or write surface
on this router.
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
from adherence_common import ropa as ropa_mod
from adherence_common.csv_safe import safe_row
from adherence_common.admin_audit import record_admin_action
from adherence_common.logging import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/v1/admin/ropa", tags=["ropa"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class RopaOut(BaseModel):
    id: int
    tenant_id: str
    name: str
    purpose: str
    lawful_basis: str
    data_categories: Optional[str] = None
    data_subjects: Optional[str] = None
    recipients: Optional[str] = None
    retention: Optional[str] = None
    transfers: Optional[str] = None
    security_measures: Optional[str] = None
    version: int
    created_by: str
    created_at: str
    updated_by: Optional[str] = None
    updated_at: Optional[str] = None
    archived_by: Optional[str] = None
    archived_at: Optional[str] = None
    active: bool


class RopaListOut(BaseModel):
    tenant_id: str
    active_count: int
    archived_count: int
    entries: list[RopaOut]


class CreateRopaIn(BaseModel):
    name: str = Field(
        ...,
        min_length=ropa_mod.MIN_NAME_LEN,
        max_length=ropa_mod.MAX_NAME_LEN,
        description="Short label for this processing activity.",
    )
    purpose: str = Field(
        ...,
        min_length=ropa_mod.MIN_PURPOSE_LEN,
        max_length=ropa_mod.MAX_PURPOSE_LEN,
        description="Why the personal data is processed.",
    )
    lawful_basis: str = Field(
        ...,
        description=(
            "GDPR Art. 6 lawful basis. One of: "
            + ", ".join(ropa_mod.LAWFUL_BASES)
        ),
    )
    data_categories: Optional[str] = Field(
        None, max_length=ropa_mod.MAX_CATEGORIES_LEN
    )
    data_subjects: Optional[str] = Field(
        None, max_length=ropa_mod.MAX_SUBJECTS_LEN
    )
    recipients: Optional[str] = Field(
        None, max_length=ropa_mod.MAX_RECIPIENTS_LEN
    )
    retention: Optional[str] = Field(
        None, max_length=ropa_mod.MAX_RETENTION_LEN
    )
    transfers: Optional[str] = Field(
        None, max_length=ropa_mod.MAX_TRANSFERS_LEN
    )
    security_measures: Optional[str] = Field(
        None, max_length=ropa_mod.MAX_MEASURES_LEN
    )


class UpdateRopaIn(BaseModel):
    purpose: Optional[str] = Field(
        None,
        min_length=ropa_mod.MIN_PURPOSE_LEN,
        max_length=ropa_mod.MAX_PURPOSE_LEN,
    )
    lawful_basis: Optional[str] = None
    data_categories: Optional[str] = Field(
        None, max_length=ropa_mod.MAX_CATEGORIES_LEN
    )
    data_subjects: Optional[str] = Field(
        None, max_length=ropa_mod.MAX_SUBJECTS_LEN
    )
    recipients: Optional[str] = Field(
        None, max_length=ropa_mod.MAX_RECIPIENTS_LEN
    )
    retention: Optional[str] = Field(
        None, max_length=ropa_mod.MAX_RETENTION_LEN
    )
    transfers: Optional[str] = Field(
        None, max_length=ropa_mod.MAX_TRANSFERS_LEN
    )
    security_measures: Optional[str] = Field(
        None, max_length=ropa_mod.MAX_MEASURES_LEN
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _to_out(v: ropa_mod.RopaView) -> RopaOut:
    return RopaOut(**v.__dict__)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=RopaListOut)
def list_ropa(
    include_archived: bool = Query(False),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> RopaListOut:
    entries = ropa_mod.list_entries(
        tenant_id=tenant,
        include_archived=include_archived,
        limit=limit,
        offset=offset,
    )
    active = sum(1 for e in entries if e.active)
    archived = sum(1 for e in entries if not e.active)
    return RopaListOut(
        tenant_id=tenant,
        active_count=active,
        archived_count=archived,
        entries=[_to_out(e) for e in entries],
    )


@router.get("/export.csv")
def export_ropa_csv(
    include_archived: bool = Query(False),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
):
    """Stream the register as CSV for procurement and audit packs."""
    entries = ropa_mod.list_entries(
        tenant_id=tenant, include_archived=include_archived, limit=500, offset=0
    )
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "id",
            "name",
            "purpose",
            "lawful_basis",
            "data_categories",
            "data_subjects",
            "recipients",
            "retention",
            "transfers",
            "security_measures",
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
                e.name,
                e.purpose,
                e.lawful_basis,
                e.data_categories or "",
                e.data_subjects or "",
                e.recipients or "",
                e.retention or "",
                e.transfers or "",
                e.security_measures or "",
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
    fname = f"ropa-{tenant}.csv"
    return StreamingResponse(
        iter([data]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/{entry_id}", response_model=RopaOut)
def get_one(
    entry_id: int,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> RopaOut:
    v = ropa_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if v is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    return _to_out(v)


@router.post("", response_model=RopaOut, status_code=201)
def create(
    body: CreateRopaIn,
    request: Request,
    dry_run: bool = Query(False, description="Preview without persisting."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.ropa.create",
            principal=p,
            target=tenant,
            details={"name": body.name, "lawful_basis": body.lawful_basis, "dry_run": True},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="create_ropa_entry",
            tenant_id=tenant,
            name=body.name,
            lawful_basis=body.lawful_basis,
        )
    try:
        view = ropa_mod.create_entry(
            tenant_id=tenant,
            name=body.name,
            purpose=body.purpose,
            lawful_basis=body.lawful_basis,
            created_by=caller,
            data_categories=body.data_categories,
            data_subjects=body.data_subjects,
            recipients=body.recipients,
            retention=body.retention,
            transfers=body.transfers,
            security_measures=body.security_measures,
        )
    except ropa_mod.RopaError as exc:
        record_admin_action(
            action="workspace.ropa.create",
            principal=p,
            target=tenant,
            details={"name": body.name},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.ropa.create",
        principal=p,
        target=tenant,
        details={"id": view.id, "name": view.name, "lawful_basis": view.lawful_basis},
        request_id=_rid(request),
    )
    log.info("ropa_entry_created", tenant=tenant, ropa_id=view.id, caller=caller)
    return _to_out(view)


@router.put("/{entry_id}", response_model=RopaOut)
def update(
    entry_id: int,
    body: UpdateRopaIn,
    request: Request,
    dry_run: bool = Query(False, description="Preview without persisting."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = ropa_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if existing is None or not existing.active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    if dry_run:
        record_admin_action(
            action="workspace.ropa.update",
            principal=p,
            target=str(entry_id),
            details={"dry_run": True, "fields": [k for k, v in body.dict().items() if v is not None]},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="update_ropa_entry",
            tenant_id=tenant,
            entry_id=entry_id,
        )
    try:
        view = ropa_mod.update_entry(
            tenant_id=tenant,
            entry_id=entry_id,
            updated_by=caller,
            purpose=body.purpose,
            lawful_basis=body.lawful_basis,
            data_categories=body.data_categories,
            data_subjects=body.data_subjects,
            recipients=body.recipients,
            retention=body.retention,
            transfers=body.transfers,
            security_measures=body.security_measures,
        )
    except ropa_mod.RopaError as exc:
        record_admin_action(
            action="workspace.ropa.update",
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
        action="workspace.ropa.update",
        principal=p,
        target=str(entry_id),
        details={"version": view.version},
        request_id=_rid(request),
    )
    return _to_out(view)


@router.post("/{entry_id}/archive", response_model=RopaOut)
def archive(
    entry_id: int,
    request: Request,
    dry_run: bool = Query(False, description="Preview without archiving."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = ropa_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if existing is None:
        record_admin_action(
            action="workspace.ropa.archive",
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
            action="workspace.ropa.archive",
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
            action="workspace.ropa.archive",
            principal=p,
            target=str(entry_id),
            details={"dry_run": True},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="archive_ropa_entry",
            tenant_id=tenant,
            entry_id=entry_id,
        )
    view = ropa_mod.archive_entry(
        tenant_id=tenant, entry_id=entry_id, archived_by=caller
    )
    if view is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="entry not found or already archived",
        )
    record_admin_action(
        action="workspace.ropa.archive",
        principal=p,
        target=str(entry_id),
        request_id=_rid(request),
    )
    log.info("ropa_entry_archived", tenant=tenant, ropa_id=entry_id, caller=caller)
    return _to_out(view)
