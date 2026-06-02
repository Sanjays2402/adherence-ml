"""/v1/admin/consents: per-tenant data subject consent register.

Reads require ``viewer``. Mutations require ``admin`` and an active MFA
challenge. Every mutation writes an admin audit row. All queries are
strictly tenant-scoped.
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
from adherence_common import consents as cons_mod
from adherence_common.csv_safe import safe_row
from adherence_common.admin_audit import record_admin_action
from adherence_common.logging import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/v1/admin/consents", tags=["consents"])


class ConsentOut(BaseModel):
    id: int
    tenant_id: str
    subject_ref: str
    subject_hash: str
    purpose: str
    lawful_basis: str
    capture_channel: str
    evidence_ref: Optional[str] = None
    notes: Optional[str] = None
    version: int
    granted_by: str
    granted_at: str
    updated_by: Optional[str] = None
    updated_at: Optional[str] = None
    withdrawn_by: Optional[str] = None
    withdrawn_at: Optional[str] = None
    withdrawal_reason: Optional[str] = None
    active: bool


class ConsentListOut(BaseModel):
    tenant_id: str
    active_count: int
    withdrawn_count: int
    active_subjects: int
    active_purposes: list[str]
    entries: list[ConsentOut]


class GrantConsentIn(BaseModel):
    subject_ref: str = Field(
        ...,
        min_length=cons_mod.MIN_SUBJECT_LEN,
        max_length=cons_mod.MAX_SUBJECT_LEN,
    )
    purpose: str = Field(
        ...,
        min_length=cons_mod.MIN_PURPOSE_LEN,
        max_length=cons_mod.MAX_PURPOSE_LEN,
    )
    lawful_basis: str
    capture_channel: str
    evidence_ref: Optional[str] = Field(None, max_length=cons_mod.MAX_EVIDENCE_LEN)
    notes: Optional[str] = Field(None, max_length=cons_mod.MAX_NOTES_LEN)


class WithdrawConsentIn(BaseModel):
    reason: Optional[str] = Field(None, max_length=256)


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _to_out(v: cons_mod.ConsentView) -> ConsentOut:
    return ConsentOut(**v.__dict__)


@router.get("", response_model=ConsentListOut)
def list_consents(
    subject_ref: Optional[str] = Query(None, max_length=cons_mod.MAX_SUBJECT_LEN),
    purpose: Optional[str] = Query(None, max_length=cons_mod.MAX_PURPOSE_LEN),
    include_withdrawn: bool = Query(False),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> ConsentListOut:
    try:
        entries = cons_mod.list_consents(
            tenant_id=tenant,
            subject_ref=subject_ref,
            purpose=purpose,
            include_withdrawn=include_withdrawn,
            limit=limit,
            offset=offset,
        )
    except cons_mod.ConsentError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    summary = cons_mod.counts(tenant)
    return ConsentListOut(
        tenant_id=tenant,
        active_count=summary["active"],
        withdrawn_count=summary["withdrawn"],
        active_subjects=summary["active_subjects"],
        active_purposes=summary["active_purposes"],
        entries=[_to_out(e) for e in entries],
    )


@router.get("/export.csv")
def export_csv(
    include_withdrawn: bool = Query(True),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
):
    entries = cons_mod.list_consents(
        tenant_id=tenant,
        include_withdrawn=include_withdrawn,
        limit=500,
        offset=0,
    )
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([
        "id", "subject_ref", "subject_hash", "purpose", "lawful_basis",
        "capture_channel", "evidence_ref", "version", "granted_by", "granted_at",
        "updated_by", "updated_at",
        "withdrawn_by", "withdrawn_at", "withdrawal_reason", "active",
    ])
    for e in entries:
        w.writerow(safe_row([
            e.id, e.subject_ref, e.subject_hash, e.purpose, e.lawful_basis,
            e.capture_channel, e.evidence_ref or "", e.version,
            e.granted_by, e.granted_at,
            e.updated_by or "", e.updated_at or "",
            e.withdrawn_by or "", e.withdrawn_at or "",
            e.withdrawal_reason or "", "true" if e.active else "false",
        ]))
    data = buf.getvalue()
    fname = f"consents-{tenant}.csv"
    return StreamingResponse(
        iter([data]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/{consent_id}", response_model=ConsentOut)
def get_one(
    consent_id: int,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> ConsentOut:
    v = cons_mod.get_consent(tenant_id=tenant, consent_id=consent_id)
    if v is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    return _to_out(v)


@router.post("", response_model=ConsentOut, status_code=201)
def grant(
    body: GrantConsentIn,
    request: Request,
    dry_run: bool = Query(False),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.consent.grant",
            principal=p,
            target=tenant,
            details={
                "purpose": body.purpose,
                "lawful_basis": body.lawful_basis,
                "capture_channel": body.capture_channel,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="grant_consent",
            tenant_id=tenant,
            purpose=body.purpose,
            lawful_basis=body.lawful_basis,
        )
    try:
        view = cons_mod.grant_consent(
            tenant_id=tenant,
            subject_ref=body.subject_ref,
            purpose=body.purpose,
            lawful_basis=body.lawful_basis,
            capture_channel=body.capture_channel,
            evidence_ref=body.evidence_ref,
            notes=body.notes,
            granted_by=caller,
        )
    except cons_mod.ConsentError as exc:
        record_admin_action(
            action="workspace.consent.grant",
            principal=p,
            target=tenant,
            details={"purpose": body.purpose},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.consent.grant",
        principal=p,
        target=tenant,
        details={
            "id": view.id,
            "subject_hash": view.subject_hash,
            "purpose": view.purpose,
            "lawful_basis": view.lawful_basis,
            "capture_channel": view.capture_channel,
            "version": view.version,
        },
        request_id=_rid(request),
    )
    log.info(
        "consent_granted",
        tenant=tenant, consent_id=view.id,
        purpose=view.purpose, caller=caller,
    )
    return _to_out(view)


@router.post("/{consent_id}/withdraw", response_model=ConsentOut)
def withdraw(
    consent_id: int,
    request: Request,
    body: WithdrawConsentIn | None = None,
    dry_run: bool = Query(False),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    reason = body.reason if body is not None else None
    existing = cons_mod.get_consent(tenant_id=tenant, consent_id=consent_id)
    if existing is None:
        record_admin_action(
            action="workspace.consent.withdraw",
            principal=p,
            target=str(consent_id),
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
            action="workspace.consent.withdraw",
            principal=p,
            target=str(consent_id),
            details={"dry_run": dry_run},
            ok=False,
            error="already withdrawn",
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="consent already withdrawn",
        )
    if dry_run:
        record_admin_action(
            action="workspace.consent.withdraw",
            principal=p,
            target=str(consent_id),
            details={"dry_run": True, "reason": reason},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="withdraw_consent",
            tenant_id=tenant,
            consent_id=consent_id,
        )
    try:
        view = cons_mod.withdraw_consent(
            tenant_id=tenant,
            consent_id=consent_id,
            withdrawn_by=caller,
            reason=reason,
        )
    except cons_mod.ConsentError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    if view is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="consent not found or already withdrawn",
        )
    record_admin_action(
        action="workspace.consent.withdraw",
        principal=p,
        target=str(consent_id),
        details={
            "subject_hash": view.subject_hash,
            "purpose": view.purpose,
            "reason": reason,
        },
        request_id=_rid(request),
    )
    log.info(
        "consent_withdrawn",
        tenant=tenant, consent_id=consent_id, caller=caller,
    )
    return _to_out(view)
