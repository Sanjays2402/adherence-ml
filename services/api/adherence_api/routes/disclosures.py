"""/v1/admin/disclosures: per-tenant HIPAA Accounting of Disclosures.

The HIPAA Privacy Rule (45 CFR 164.528) gives a patient the right
to receive an accounting of disclosures of their PHI made by a
covered entity. A buyer who is a covered entity or business
associate cannot sign the BAA without evidence the vendor can
produce that accounting on demand, per workspace, on every
disclosure category that requires accounting under the rule.

Endpoints:

* ``GET    /v1/admin/disclosures`` lists entries with optional
  ``subject_id``, ``purpose``, ``since``, ``until``, and ``limit``
  filters.
* ``POST   /v1/admin/disclosures`` records one disclosure.
* ``GET    /v1/admin/disclosures/{id}`` returns one entry.
* ``POST   /v1/admin/disclosures/{id}/correct`` appends a correction
  entry that references the prior id. The prior row is never
  modified; that is the immutability guarantee a regulator
  expects.
* ``GET    /v1/admin/disclosures/subject/{subject_id}/accounting``
  returns the patient-ready accounting (default 6 year window).
* ``GET    /v1/admin/disclosures/summary`` returns counts for the
  admin overview tile.
* ``GET    /v1/admin/disclosures/export.csv`` returns the register
  as a CSV download for procurement and audit packs.

Reads require ``viewer`` and above. Mutations require ``admin`` and
an active MFA challenge, mirroring DPIA, RoPA, BCDR, pentests, and
the rest of the compliance plane. Every mutation writes an admin
audit row. All queries are strictly tenant-scoped: there is no
cross-tenant code path on this router.
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
from adherence_common import disclosures as disc_mod
from adherence_common.csv_safe import safe_row
from adherence_common.admin_audit import record_admin_action
from adherence_common.logging import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/v1/admin/disclosures", tags=["disclosures"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class DisclosureOut(BaseModel):
    id: int
    tenant_id: str
    subject_id: str
    recipient_name: str
    recipient_org: Optional[str] = None
    purpose: str
    phi_description: str
    legal_basis: Optional[str] = None
    requested_by: str
    disclosed_at: str
    notes: Optional[str] = None
    corrects_entry_id: Optional[int] = None
    created_by: str
    created_at: str
    retain_until: str


class DisclosureListOut(BaseModel):
    tenant_id: str
    count: int
    entries: list[DisclosureOut]


class SubjectAccountingOut(BaseModel):
    tenant_id: str
    subject_id: str
    lookback_years: int
    count: int
    entries: list[DisclosureOut]


class SummaryOut(BaseModel):
    tenant_id: str
    total: int
    unique_subjects: int
    by_purpose: dict[str, int]
    last_disclosed_at: Optional[str] = None


class RecordDisclosureIn(BaseModel):
    subject_id: str = Field(..., min_length=1, max_length=disc_mod.MAX_SUBJECT_LEN)
    recipient_name: str = Field(..., min_length=2, max_length=disc_mod.MAX_RECIPIENT_LEN)
    recipient_org: Optional[str] = Field(None, max_length=disc_mod.MAX_ORG_LEN)
    purpose: str = Field(..., description="One of disc_mod.PURPOSE_CATEGORIES.")
    phi_description: str = Field(
        ..., min_length=2, max_length=disc_mod.MAX_DESCRIPTION_LEN
    )
    legal_basis: Optional[str] = Field(None, max_length=disc_mod.MAX_BASIS_LEN)
    requested_by: str = Field(..., min_length=2, max_length=disc_mod.MAX_REQUESTER_LEN)
    disclosed_at: Optional[datetime] = None
    notes: Optional[str] = Field(None, max_length=disc_mod.MAX_NOTES_LEN)


class CorrectDisclosureIn(BaseModel):
    recipient_name: str = Field(..., min_length=2, max_length=disc_mod.MAX_RECIPIENT_LEN)
    recipient_org: Optional[str] = Field(None, max_length=disc_mod.MAX_ORG_LEN)
    purpose: str
    phi_description: str = Field(
        ..., min_length=2, max_length=disc_mod.MAX_DESCRIPTION_LEN
    )
    legal_basis: Optional[str] = Field(None, max_length=disc_mod.MAX_BASIS_LEN)
    requested_by: str = Field(..., min_length=2, max_length=disc_mod.MAX_REQUESTER_LEN)
    disclosed_at: Optional[datetime] = None
    notes: Optional[str] = Field(None, max_length=disc_mod.MAX_NOTES_LEN)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _to_out(view) -> DisclosureOut:
    return DisclosureOut(
        id=view.id,
        tenant_id=view.tenant_id,
        subject_id=view.subject_id,
        recipient_name=view.recipient_name,
        recipient_org=view.recipient_org,
        purpose=view.purpose,
        phi_description=view.phi_description,
        legal_basis=view.legal_basis,
        requested_by=view.requested_by,
        disclosed_at=view.disclosed_at,
        notes=view.notes,
        corrects_entry_id=view.corrects_entry_id,
        created_by=view.created_by,
        created_at=view.created_at,
        retain_until=view.retain_until,
    )


def _bad_request(exc: Exception) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=DisclosureListOut)
def list_disclosures(
    request: Request,
    tenant: str = Depends(current_tenant),
    _v: dict = Depends(require_viewer),
    subject_id: Optional[str] = Query(None, max_length=disc_mod.MAX_SUBJECT_LEN),
    purpose: Optional[str] = Query(None),
    since: Optional[datetime] = Query(None),
    until: Optional[datetime] = Query(None),
    limit: int = Query(200, ge=1, le=1000),
) -> DisclosureListOut:
    try:
        rows = disc_mod.list_entries(
            tenant_id=tenant,
            subject_id=subject_id,
            purpose=purpose,
            since=since,
            until=until,
            limit=limit,
        )
    except disc_mod.DisclosureError as exc:
        raise _bad_request(exc)
    return DisclosureListOut(
        tenant_id=tenant, count=len(rows), entries=[_to_out(r) for r in rows]
    )


@router.get("/summary", response_model=SummaryOut)
def summary(
    tenant: str = Depends(current_tenant),
    _v: dict = Depends(require_viewer),
) -> SummaryOut:
    s = disc_mod.summary(tenant_id=tenant)
    return SummaryOut(**s)


@router.get("/export.csv")
def export_csv(
    tenant: str = Depends(current_tenant),
    _v: dict = Depends(require_viewer),
) -> StreamingResponse:
    rows = disc_mod.list_entries(tenant_id=tenant, limit=1000)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "id",
            "tenant_id",
            "subject_id",
            "recipient_name",
            "recipient_org",
            "purpose",
            "phi_description",
            "legal_basis",
            "requested_by",
            "disclosed_at",
            "corrects_entry_id",
            "created_by",
            "created_at",
            "retain_until",
            "notes",
        ]
    )
    for r in rows:
        w.writerow(safe_row(
            [
                r.id,
                r.tenant_id,
                r.subject_id,
                r.recipient_name,
                r.recipient_org or "",
                r.purpose,
                r.phi_description,
                r.legal_basis or "",
                r.requested_by,
                r.disclosed_at,
                r.corrects_entry_id or "",
                r.created_by,
                r.created_at,
                r.retain_until,
                (r.notes or "").replace("\n", " "),
            ]
        ))
    buf.seek(0)
    fname = f"disclosures-{tenant}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get(
    "/subject/{subject_id}/accounting", response_model=SubjectAccountingOut
)
def subject_accounting(
    subject_id: str,
    tenant: str = Depends(current_tenant),
    _v: dict = Depends(require_viewer),
    lookback_years: int = Query(disc_mod.RETENTION_YEARS, ge=1, le=10),
) -> SubjectAccountingOut:
    try:
        rows = disc_mod.subject_accounting(
            tenant_id=tenant,
            subject_id=subject_id,
            lookback_years=lookback_years,
        )
    except disc_mod.DisclosureError as exc:
        raise _bad_request(exc)
    return SubjectAccountingOut(
        tenant_id=tenant,
        subject_id=subject_id,
        lookback_years=lookback_years,
        count=len(rows),
        entries=[_to_out(r) for r in rows],
    )


@router.get("/{entry_id}", response_model=DisclosureOut)
def get_disclosure(
    entry_id: int,
    tenant: str = Depends(current_tenant),
    _v: dict = Depends(require_viewer),
) -> DisclosureOut:
    row = disc_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if row is None:
        raise HTTPException(status_code=404, detail="disclosure entry not found")
    return _to_out(row)


@router.post(
    "",
    response_model=DisclosureOut,
    status_code=status.HTTP_201_CREATED,
)
def record_disclosure(
    body: RecordDisclosureIn,
    request: Request,
    tenant: str = Depends(current_tenant),
    principal: dict = Depends(require_admin),
    _mfa: dict = Depends(require_admin_mfa),
    dry_run: bool = Query(False),
):
    if dry_run:
        return dry_run_response(
            would="disclosures.record",
            tenant=tenant,
            payload=body.model_dump(),
        )
    try:
        view = disc_mod.record_disclosure(
            tenant_id=tenant,
            subject_id=body.subject_id,
            recipient_name=body.recipient_name,
            recipient_org=body.recipient_org,
            purpose=body.purpose,
            phi_description=body.phi_description,
            legal_basis=body.legal_basis,
            requested_by=body.requested_by,
            disclosed_at=body.disclosed_at,
            notes=body.notes,
            created_by=str(principal.get("sub") or "admin"),
        )
    except disc_mod.DisclosureError as exc:
        raise _bad_request(exc)
    record_admin_action(
        action="disclosures.record",
        principal=principal,
        target=f"disclosure:{view.id}",
        details={
            "subject_id": view.subject_id,
            "recipient_name": view.recipient_name,
            "purpose": view.purpose,
        },
        tenant_id=tenant,
        request_id=getattr(request.state, "request_id", None),
    )
    return _to_out(view)


@router.post(
    "/{entry_id}/correct",
    response_model=DisclosureOut,
    status_code=status.HTTP_201_CREATED,
)
def correct_disclosure(
    entry_id: int,
    body: CorrectDisclosureIn,
    request: Request,
    tenant: str = Depends(current_tenant),
    principal: dict = Depends(require_admin),
    _mfa: dict = Depends(require_admin_mfa),
    dry_run: bool = Query(False),
):
    prior = disc_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if prior is None:
        raise HTTPException(status_code=404, detail="disclosure entry not found")
    if dry_run:
        return dry_run_response(
            would="disclosures.correct",
            tenant=tenant,
            payload={"corrects_entry_id": entry_id, **body.model_dump()},
        )
    try:
        view = disc_mod.record_disclosure(
            tenant_id=tenant,
            subject_id=prior.subject_id,
            recipient_name=body.recipient_name,
            recipient_org=body.recipient_org,
            purpose=body.purpose,
            phi_description=body.phi_description,
            legal_basis=body.legal_basis,
            requested_by=body.requested_by,
            disclosed_at=body.disclosed_at,
            notes=body.notes,
            corrects_entry_id=entry_id,
            created_by=str(principal.get("sub") or "admin"),
        )
    except disc_mod.DisclosureError as exc:
        raise _bad_request(exc)
    record_admin_action(
        action="disclosures.correct",
        principal=principal,
        target=f"disclosure:{view.id}",
        details={
            "corrects_entry_id": entry_id,
            "subject_id": view.subject_id,
            "purpose": view.purpose,
        },
        tenant_id=tenant,
        request_id=getattr(request.state, "request_id", None),
    )
    return _to_out(view)
