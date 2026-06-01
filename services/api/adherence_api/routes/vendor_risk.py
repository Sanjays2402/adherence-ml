"""/v1/admin/vendor-risk: per-tenant Vendor Risk Assessment register.

Procurement, security, and privacy reviewers all expect the customer
to maintain their own vendor risk register independently of the
supplier-published sub-processor list. SOC 2 CC9.2, ISO 27001
A.5.19/A.5.22, HIPAA 164.308(b), and most SIG/CAIQ packs ask for it
explicitly.

* ``GET    /v1/admin/vendor-risk`` lists rows (active by default).
* ``GET    /v1/admin/vendor-risk/summary`` returns aggregate counts.
* ``GET    /v1/admin/vendor-risk/export.csv`` streams the register.
* ``GET    /v1/admin/vendor-risk/{id}`` returns one row.
* ``GET    /v1/admin/vendor-risk/{id}/reviews`` returns the review log.
* ``POST   /v1/admin/vendor-risk`` registers a new vendor.
* ``PUT    /v1/admin/vendor-risk/{id}`` updates one row and bumps version.
* ``POST   /v1/admin/vendor-risk/{id}/review`` records a review outcome.
* ``POST   /v1/admin/vendor-risk/{id}/retire`` retires (soft-deletes) a row.

Reads require ``viewer`` and above. Mutations require ``admin`` plus
an active MFA challenge, mirroring DPIA, RoPA, BAA, BCDR, risk
register, and incidents. Every mutation writes an admin audit row.
All queries are strictly tenant-scoped: there is no cross-tenant
code path on this router.
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
from adherence_common import vendor_risk as vr_mod
from adherence_common.admin_audit import record_admin_action
from adherence_common.logging import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/v1/admin/vendor-risk", tags=["vendor-risk"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class VendorOut(BaseModel):
    id: int
    tenant_id: str
    vendor_name: str
    vendor_type: str
    data_shared: str
    inherent_risk: str
    residual_risk: str
    soc2: bool
    iso27001: bool
    hipaa: bool
    pci_dss: bool
    evidence_url: Optional[str] = None
    owner: str
    status: str
    notes: Optional[str] = None
    review_cadence_days: int
    last_reviewed_at: Optional[str] = None
    last_review_outcome: Optional[str] = None
    next_review_at: str
    review_overdue: bool
    version: int
    created_by: str
    created_at: str
    updated_by: Optional[str] = None
    updated_at: Optional[str] = None
    retired_by: Optional[str] = None
    retired_at: Optional[str] = None
    active: bool


class VendorListOut(BaseModel):
    tenant_id: str
    active_count: int
    retired_count: int
    overdue_count: int
    entries: list[VendorOut]


class ReviewOut(BaseModel):
    id: int
    vendor_id: int
    outcome: str
    notes: Optional[str] = None
    reviewed_by: str
    reviewed_at: str


class CreateVendorIn(BaseModel):
    vendor_name: str = Field(
        ..., min_length=vr_mod.MIN_NAME_LEN, max_length=vr_mod.MAX_NAME_LEN
    )
    vendor_type: str
    owner: str = Field(..., min_length=1, max_length=vr_mod.MAX_OWNER_LEN)
    data_shared: Optional[str] = "none"
    inherent_risk: Optional[str] = "medium"
    residual_risk: Optional[str] = None
    soc2: bool = False
    iso27001: bool = False
    hipaa: bool = False
    pci_dss: bool = False
    evidence_url: Optional[str] = Field(None, max_length=vr_mod.MAX_URL_LEN)
    status: Optional[str] = "proposed"
    notes: Optional[str] = Field(None, max_length=vr_mod.MAX_NOTES_LEN)
    review_cadence_days: Optional[int] = Field(
        None,
        ge=vr_mod.MIN_REVIEW_CADENCE_DAYS,
        le=vr_mod.MAX_REVIEW_CADENCE_DAYS,
    )


class UpdateVendorIn(BaseModel):
    vendor_type: Optional[str] = None
    data_shared: Optional[str] = None
    inherent_risk: Optional[str] = None
    residual_risk: Optional[str] = None
    soc2: Optional[bool] = None
    iso27001: Optional[bool] = None
    hipaa: Optional[bool] = None
    pci_dss: Optional[bool] = None
    evidence_url: Optional[str] = Field(None, max_length=vr_mod.MAX_URL_LEN)
    owner: Optional[str] = Field(None, min_length=1, max_length=vr_mod.MAX_OWNER_LEN)
    status: Optional[str] = None
    notes: Optional[str] = Field(None, max_length=vr_mod.MAX_NOTES_LEN)
    review_cadence_days: Optional[int] = Field(
        None,
        ge=vr_mod.MIN_REVIEW_CADENCE_DAYS,
        le=vr_mod.MAX_REVIEW_CADENCE_DAYS,
    )


class ReviewIn(BaseModel):
    outcome: str
    notes: Optional[str] = Field(None, max_length=vr_mod.MAX_NOTES_LEN)


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _to_out(v: vr_mod.VendorRiskView) -> VendorOut:
    return VendorOut(**v.__dict__)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=VendorListOut)
def list_vendors(
    include_retired: bool = Query(False),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> VendorListOut:
    entries = vr_mod.list_entries(
        tenant_id=tenant,
        include_retired=include_retired,
        limit=limit,
        offset=offset,
    )
    active = sum(1 for e in entries if e.active)
    retired = sum(1 for e in entries if not e.active)
    overdue = sum(1 for e in entries if e.active and e.review_overdue)
    return VendorListOut(
        tenant_id=tenant,
        active_count=active,
        retired_count=retired,
        overdue_count=overdue,
        entries=[_to_out(e) for e in entries],
    )


@router.get("/summary")
def summary(
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
):
    return vr_mod.summary(tenant_id=tenant)


@router.get("/export.csv")
def export_csv(
    include_retired: bool = Query(False),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
):
    entries = vr_mod.list_entries(
        tenant_id=tenant,
        include_retired=include_retired,
        limit=500,
        offset=0,
    )
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "id",
            "vendor_name",
            "vendor_type",
            "data_shared",
            "inherent_risk",
            "residual_risk",
            "soc2",
            "iso27001",
            "hipaa",
            "pci_dss",
            "evidence_url",
            "owner",
            "status",
            "review_cadence_days",
            "last_reviewed_at",
            "last_review_outcome",
            "next_review_at",
            "review_overdue",
            "version",
            "created_by",
            "created_at",
            "updated_by",
            "updated_at",
            "retired_by",
            "retired_at",
            "notes",
        ]
    )
    for e in entries:
        w.writerow(
            [
                e.id,
                e.vendor_name,
                e.vendor_type,
                e.data_shared,
                e.inherent_risk,
                e.residual_risk,
                "yes" if e.soc2 else "no",
                "yes" if e.iso27001 else "no",
                "yes" if e.hipaa else "no",
                "yes" if e.pci_dss else "no",
                e.evidence_url or "",
                e.owner,
                e.status,
                e.review_cadence_days,
                e.last_reviewed_at or "",
                e.last_review_outcome or "",
                e.next_review_at,
                "yes" if e.review_overdue else "no",
                e.version,
                e.created_by,
                e.created_at,
                e.updated_by or "",
                e.updated_at or "",
                e.retired_by or "",
                e.retired_at or "",
                e.notes or "",
            ]
        )
    fname = f"vendor-risk-{tenant}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/{entry_id}", response_model=VendorOut)
def get_one(
    entry_id: int,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> VendorOut:
    v = vr_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if v is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    return _to_out(v)


@router.get("/{entry_id}/reviews", response_model=list[ReviewOut])
def list_reviews(
    entry_id: int,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> list[ReviewOut]:
    rows = vr_mod.list_reviews(tenant_id=tenant, entry_id=entry_id)
    return [ReviewOut(**r.__dict__) for r in rows]


@router.post("", response_model=VendorOut, status_code=201)
def create(
    body: CreateVendorIn,
    request: Request,
    dry_run: bool = Query(False, description="Preview without persisting."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.vendor_risk.create",
            principal=p,
            target=tenant,
            details={
                "vendor_name": body.vendor_name,
                "vendor_type": body.vendor_type,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="create_vendor_risk_entry",
            tenant_id=tenant,
            vendor_name=body.vendor_name,
            vendor_type=body.vendor_type,
        )
    try:
        view = vr_mod.create_entry(
            tenant_id=tenant,
            vendor_name=body.vendor_name,
            vendor_type=body.vendor_type,
            owner=body.owner,
            created_by=caller,
            data_shared=body.data_shared,
            inherent_risk=body.inherent_risk,
            residual_risk=body.residual_risk,
            soc2=body.soc2,
            iso27001=body.iso27001,
            hipaa=body.hipaa,
            pci_dss=body.pci_dss,
            evidence_url=body.evidence_url,
            status=body.status,
            notes=body.notes,
            review_cadence_days=body.review_cadence_days,
        )
    except vr_mod.VendorRiskError as exc:
        record_admin_action(
            action="workspace.vendor_risk.create",
            principal=p,
            target=tenant,
            details={"vendor_name": body.vendor_name},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.vendor_risk.create",
        principal=p,
        target=tenant,
        details={
            "id": view.id,
            "vendor_name": view.vendor_name,
            "vendor_type": view.vendor_type,
            "data_shared": view.data_shared,
            "inherent_risk": view.inherent_risk,
            "residual_risk": view.residual_risk,
            "status": view.status,
        },
        request_id=_rid(request),
    )
    log.info(
        "vendor_risk_created", tenant=tenant, vendor_id=view.id, caller=caller
    )
    return _to_out(view)


@router.put("/{entry_id}", response_model=VendorOut)
def update(
    entry_id: int,
    body: UpdateVendorIn,
    request: Request,
    dry_run: bool = Query(False),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = vr_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if existing is None or not existing.active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    if dry_run:
        record_admin_action(
            action="workspace.vendor_risk.update",
            principal=p,
            target=str(entry_id),
            details={
                "dry_run": True,
                "fields": [k for k, v in body.dict().items() if v is not None],
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="update_vendor_risk_entry",
            tenant_id=tenant,
            entry_id=entry_id,
        )
    try:
        view = vr_mod.update_entry(
            tenant_id=tenant,
            entry_id=entry_id,
            updated_by=caller,
            vendor_type=body.vendor_type,
            data_shared=body.data_shared,
            inherent_risk=body.inherent_risk,
            residual_risk=body.residual_risk,
            soc2=body.soc2,
            iso27001=body.iso27001,
            hipaa=body.hipaa,
            pci_dss=body.pci_dss,
            evidence_url=body.evidence_url,
            owner=body.owner,
            status=body.status,
            notes=body.notes,
            review_cadence_days=body.review_cadence_days,
        )
    except vr_mod.VendorRiskError as exc:
        record_admin_action(
            action="workspace.vendor_risk.update",
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
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    record_admin_action(
        action="workspace.vendor_risk.update",
        principal=p,
        target=str(entry_id),
        details={
            "version": view.version,
            "status": view.status,
            "residual_risk": view.residual_risk,
        },
        request_id=_rid(request),
    )
    return _to_out(view)


@router.post("/{entry_id}/review", response_model=VendorOut)
def record_review(
    entry_id: int,
    body: ReviewIn,
    request: Request,
    dry_run: bool = Query(False),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = vr_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if existing is None or not existing.active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    if dry_run:
        record_admin_action(
            action="workspace.vendor_risk.review",
            principal=p,
            target=str(entry_id),
            details={"outcome": body.outcome, "dry_run": True},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="record_vendor_risk_review",
            tenant_id=tenant,
            entry_id=entry_id,
            outcome=body.outcome,
        )
    try:
        result = vr_mod.record_review(
            tenant_id=tenant,
            entry_id=entry_id,
            outcome=body.outcome,
            reviewed_by=caller,
            notes=body.notes,
        )
    except vr_mod.VendorRiskError as exc:
        record_admin_action(
            action="workspace.vendor_risk.review",
            principal=p,
            target=str(entry_id),
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    view, review = result
    record_admin_action(
        action="workspace.vendor_risk.review",
        principal=p,
        target=str(entry_id),
        details={
            "outcome": review.outcome,
            "review_id": review.id,
            "status": view.status,
            "next_review_at": view.next_review_at,
        },
        request_id=_rid(request),
    )
    return _to_out(view)


@router.post("/{entry_id}/retire", response_model=VendorOut)
def retire(
    entry_id: int,
    request: Request,
    dry_run: bool = Query(False),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = vr_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    if not existing.active:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="already retired"
        )
    if dry_run:
        record_admin_action(
            action="workspace.vendor_risk.retire",
            principal=p,
            target=str(entry_id),
            details={"dry_run": True},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="retire_vendor_risk_entry",
            tenant_id=tenant,
            entry_id=entry_id,
        )
    view = vr_mod.retire_entry(
        tenant_id=tenant,
        entry_id=entry_id,
        retired_by=caller,
    )
    if view is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    record_admin_action(
        action="workspace.vendor_risk.retire",
        principal=p,
        target=str(entry_id),
        details={"vendor_name": view.vendor_name},
        request_id=_rid(request),
    )
    return _to_out(view)
