"""/v1/admin/baa: per-tenant HIPAA Business Associate Agreement register.

A covered entity cannot lawfully disclose PHI to a business associate
without a signed BAA in force (45 CFR 164.502(e), 164.504(e)). A
medication adherence service is a business associate by construction,
so procurement at any U.S. health system, payer, or pharmacy chain
blocks adoption until the buyer can hand its compliance office
evidence that a BAA exists, names the right counterparty, covers the
in-scope services, and is currently in effect.

Reads require ``viewer`` and above. Mutations require ``admin`` and an
active MFA challenge, mirroring DPIA, RoPA, legal hold, incidents, and
retention policy. Every mutation writes an admin audit row. All
queries are strictly tenant-scoped: there is no cross-tenant code path
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
from adherence_common import baa as baa_mod
from adherence_common.csv_safe import safe_row
from adherence_common.admin_audit import record_admin_action
from adherence_common.logging import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/v1/admin/baa", tags=["baa"])


class BaaOut(BaseModel):
    id: int
    tenant_id: str
    counterparty: str
    document_version: str
    status: str
    effective_status: str
    effective_on: Optional[str] = None
    expires_on: Optional[str] = None
    breach_notify_hours: int
    covered_entity_signatory: Optional[str] = None
    business_associate_signatory: Optional[str] = None
    evidence_url: Optional[str] = None
    notes: Optional[str] = None
    version: int
    created_by: str
    created_at: str
    updated_by: Optional[str] = None
    updated_at: Optional[str] = None


class BaaListOut(BaseModel):
    tenant_id: str
    active_count: int
    expiring_30d: int
    total: int
    has_active_baa: bool
    entries: list[BaaOut]


class CreateBaaIn(BaseModel):
    counterparty: str = Field(
        ...,
        min_length=baa_mod.MIN_COUNTERPARTY_LEN,
        max_length=baa_mod.MAX_COUNTERPARTY_LEN,
        description="Legal name of the BAA counterparty.",
    )
    document_version: str = Field(
        ...,
        min_length=1,
        max_length=baa_mod.MAX_DOC_VERSION_LEN,
        description="Version label of the executed document.",
    )
    status: str = Field(
        "draft", description="One of: " + ", ".join(baa_mod.STATUSES)
    )
    effective_on: Optional[str] = Field(None, description="ISO-8601 YYYY-MM-DD.")
    expires_on: Optional[str] = Field(None, description="ISO-8601 YYYY-MM-DD.")
    breach_notify_hours: Optional[int] = Field(
        None,
        ge=baa_mod.MIN_BREACH_NOTIFY_HOURS,
        le=baa_mod.MAX_BREACH_NOTIFY_HOURS,
    )
    covered_entity_signatory: Optional[str] = Field(
        None, max_length=baa_mod.MAX_SIGNATORY_LEN
    )
    business_associate_signatory: Optional[str] = Field(
        None, max_length=baa_mod.MAX_SIGNATORY_LEN
    )
    evidence_url: Optional[str] = Field(None, max_length=baa_mod.MAX_EVIDENCE_URL_LEN)
    notes: Optional[str] = Field(None, max_length=baa_mod.MAX_NOTES_LEN)


class UpdateBaaIn(BaseModel):
    status: Optional[str] = None
    effective_on: Optional[str] = None
    expires_on: Optional[str] = None
    breach_notify_hours: Optional[int] = Field(
        None,
        ge=baa_mod.MIN_BREACH_NOTIFY_HOURS,
        le=baa_mod.MAX_BREACH_NOTIFY_HOURS,
    )
    covered_entity_signatory: Optional[str] = Field(
        None, max_length=baa_mod.MAX_SIGNATORY_LEN
    )
    business_associate_signatory: Optional[str] = Field(
        None, max_length=baa_mod.MAX_SIGNATORY_LEN
    )
    evidence_url: Optional[str] = Field(None, max_length=baa_mod.MAX_EVIDENCE_URL_LEN)
    notes: Optional[str] = Field(None, max_length=baa_mod.MAX_NOTES_LEN)


class BaaPolicyOut(BaseModel):
    tenant_id: str
    require_baa_for_phi: bool
    grace_until: Optional[str] = None
    updated_by: Optional[str] = None
    updated_at: str


class SetPolicyIn(BaseModel):
    require_baa_for_phi: bool = Field(...)
    grace_until: Optional[str] = Field(None)


class BaaStatusOut(BaseModel):
    tenant_id: str
    require_baa_for_phi: bool
    has_active_baa: bool
    in_grace: bool
    grace_until: Optional[str] = None
    should_block: bool


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _to_out(v: baa_mod.BaaView) -> BaaOut:
    return BaaOut(**v.__dict__)


@router.get("", response_model=BaaListOut)
def list_baa(
    include_terminated: bool = Query(False),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> BaaListOut:
    entries = baa_mod.list_entries(
        tenant_id=tenant,
        include_terminated=include_terminated,
        limit=limit,
        offset=offset,
    )
    return BaaListOut(
        tenant_id=tenant,
        active_count=baa_mod.active_count(tenant),
        expiring_30d=baa_mod.expiring_within(tenant, days=30),
        total=len(entries),
        has_active_baa=baa_mod.has_active(tenant),
        entries=[_to_out(e) for e in entries],
    )


@router.get("/export.csv")
def export_baa_csv(
    include_terminated: bool = Query(False),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
):
    entries = baa_mod.list_entries(
        tenant_id=tenant,
        include_terminated=include_terminated,
        limit=500,
        offset=0,
    )
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "id",
            "counterparty",
            "document_version",
            "status",
            "effective_status",
            "effective_on",
            "expires_on",
            "breach_notify_hours",
            "covered_entity_signatory",
            "business_associate_signatory",
            "evidence_url",
            "version",
            "created_by",
            "created_at",
            "updated_by",
            "updated_at",
        ]
    )
    for e in entries:
        w.writerow(safe_row(
            [
                e.id,
                e.counterparty,
                e.document_version,
                e.status,
                e.effective_status,
                e.effective_on or "",
                e.expires_on or "",
                e.breach_notify_hours,
                e.covered_entity_signatory or "",
                e.business_associate_signatory or "",
                e.evidence_url or "",
                e.version,
                e.created_by,
                e.created_at,
                e.updated_by or "",
                e.updated_at or "",
            ]
        ))
    data = buf.getvalue()
    fname = f"baa-{tenant}.csv"
    return StreamingResponse(
        iter([data]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/policy", response_model=BaaPolicyOut)
def get_policy(
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> BaaPolicyOut:
    pv = baa_mod.get_policy(tenant)
    return BaaPolicyOut(**pv.__dict__)


@router.put("/policy", response_model=BaaPolicyOut)
def set_policy(
    body: SetPolicyIn,
    request: Request,
    dry_run: bool = Query(False),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.baa.policy.set",
            principal=p,
            target=tenant,
            details={
                "require_baa_for_phi": body.require_baa_for_phi,
                "grace_until": body.grace_until,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="set_baa_policy",
            tenant_id=tenant,
            require_baa_for_phi=body.require_baa_for_phi,
            grace_until=body.grace_until,
        )
    try:
        pv = baa_mod.set_policy(
            tenant_id=tenant,
            require_baa_for_phi=body.require_baa_for_phi,
            grace_until=body.grace_until,
            updated_by=caller,
        )
    except baa_mod.BaaError as exc:
        record_admin_action(
            action="workspace.baa.policy.set",
            principal=p,
            target=tenant,
            details={"require_baa_for_phi": body.require_baa_for_phi},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.baa.policy.set",
        principal=p,
        target=tenant,
        details={
            "require_baa_for_phi": pv.require_baa_for_phi,
            "grace_until": pv.grace_until,
        },
        request_id=_rid(request),
    )
    return BaaPolicyOut(**pv.__dict__)


@router.get("/status", response_model=BaaStatusOut)
def get_status(
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> BaaStatusOut:
    st = baa_mod.enforcement_state(tenant)
    return BaaStatusOut(tenant_id=tenant, **st)


@router.get("/{entry_id}", response_model=BaaOut)
def get_one(
    entry_id: int,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> BaaOut:
    v = baa_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if v is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    return _to_out(v)


@router.post("", response_model=BaaOut, status_code=201)
def create(
    body: CreateBaaIn,
    request: Request,
    dry_run: bool = Query(False),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.baa.create",
            principal=p,
            target=tenant,
            details={
                "counterparty": body.counterparty,
                "document_version": body.document_version,
                "status": body.status,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="create_baa_entry",
            tenant_id=tenant,
            counterparty=body.counterparty,
            document_version=body.document_version,
        )
    try:
        view = baa_mod.create_entry(
            tenant_id=tenant,
            counterparty=body.counterparty,
            document_version=body.document_version,
            created_by=caller,
            status=body.status,
            effective_on=body.effective_on,
            expires_on=body.expires_on,
            breach_notify_hours=body.breach_notify_hours,
            covered_entity_signatory=body.covered_entity_signatory,
            business_associate_signatory=body.business_associate_signatory,
            evidence_url=body.evidence_url,
            notes=body.notes,
        )
    except baa_mod.BaaError as exc:
        record_admin_action(
            action="workspace.baa.create",
            principal=p,
            target=tenant,
            details={"counterparty": body.counterparty},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.baa.create",
        principal=p,
        target=tenant,
        details={
            "id": view.id,
            "counterparty": view.counterparty,
            "document_version": view.document_version,
            "status": view.status,
        },
        request_id=_rid(request),
    )
    log.info("baa_entry_created", tenant=tenant, baa_id=view.id, caller=caller)
    return _to_out(view)


@router.put("/{entry_id}", response_model=BaaOut)
def update(
    entry_id: int,
    body: UpdateBaaIn,
    request: Request,
    dry_run: bool = Query(False),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = baa_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if existing is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    if dry_run:
        record_admin_action(
            action="workspace.baa.update",
            principal=p,
            target=str(entry_id),
            details={
                "dry_run": True,
                "fields": [k for k, v in body.dict().items() if v is not None],
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="update_baa_entry",
            tenant_id=tenant,
            entry_id=entry_id,
        )
    try:
        view = baa_mod.update_entry(
            tenant_id=tenant,
            entry_id=entry_id,
            updated_by=caller,
            status=body.status,
            effective_on=body.effective_on,
            expires_on=body.expires_on,
            breach_notify_hours=body.breach_notify_hours,
            covered_entity_signatory=body.covered_entity_signatory,
            business_associate_signatory=body.business_associate_signatory,
            evidence_url=body.evidence_url,
            notes=body.notes,
        )
    except baa_mod.BaaError as exc:
        record_admin_action(
            action="workspace.baa.update",
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
        action="workspace.baa.update",
        principal=p,
        target=str(entry_id),
        details={"version": view.version, "status": view.status},
        request_id=_rid(request),
    )
    return _to_out(view)


@router.post("/{entry_id}/terminate", response_model=BaaOut)
def terminate(
    entry_id: int,
    request: Request,
    dry_run: bool = Query(False),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = baa_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if existing is None:
        record_admin_action(
            action="workspace.baa.terminate",
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
    if dry_run:
        record_admin_action(
            action="workspace.baa.terminate",
            principal=p,
            target=str(entry_id),
            details={"dry_run": True},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="terminate_baa_entry",
            tenant_id=tenant,
            entry_id=entry_id,
        )
    view = baa_mod.terminate_entry(
        tenant_id=tenant, entry_id=entry_id, terminated_by=caller
    )
    if view is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    record_admin_action(
        action="workspace.baa.terminate",
        principal=p,
        target=str(entry_id),
        request_id=_rid(request),
    )
    log.info("baa_entry_terminated", tenant=tenant, baa_id=entry_id, caller=caller)
    return _to_out(view)
