"""/v1/admin/sla: per-tenant SLA commitment register.

Reads require ``viewer``. Mutations require ``admin`` and an active MFA
challenge. Every mutation writes an admin audit row with actor, IP, and
request id. All queries are strictly tenant-scoped: there is no path
that can read or mutate another tenant's commitments.

A read-only view of the in-force commitment is exposed at
``/v1/sla/current`` for the caller's own tenant only.
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
from adherence_common import sla_register as sla_mod
from adherence_common.admin_audit import record_admin_action
from adherence_common.logging import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/v1/admin/sla", tags=["sla"])
public_router = APIRouter(prefix="/v1/sla", tags=["sla"])


class CommitmentOut(BaseModel):
    id: int
    tenant_id: str
    contract_ref: str
    plan: str
    uptime_pct: float
    sev1_response_hours: float
    sev2_response_hours: float
    sev3_response_hours: float
    sev4_response_hours: float
    rto_minutes: int
    rpo_minutes: int
    effective_from: str
    effective_until: Optional[str] = None
    notes: Optional[str] = None
    version: int
    status: str
    created_by: str
    created_at: str
    archived_by: Optional[str] = None
    archived_at: Optional[str] = None
    archive_reason: Optional[str] = None
    superseded_by_id: Optional[int] = None
    active: bool


class ListOut(BaseModel):
    tenant_id: str
    active_count: int
    archived_count: int
    in_force_count: int
    total: int
    entries: list[CommitmentOut]


class CurrentOut(BaseModel):
    tenant_id: str
    in_force: Optional[CommitmentOut] = None


class CreateIn(BaseModel):
    contract_ref: str = Field(..., min_length=sla_mod.MIN_REF_LEN, max_length=sla_mod.MAX_REF_LEN)
    plan: str = Field("enterprise", min_length=1, max_length=64)
    uptime_pct: float = Field(..., ge=sla_mod.UPTIME_MIN, le=sla_mod.UPTIME_MAX)
    sev1_response_hours: float = Field(..., ge=sla_mod.RESPONSE_HOUR_MIN, le=sla_mod.RESPONSE_HOUR_MAX)
    sev2_response_hours: float = Field(..., ge=sla_mod.RESPONSE_HOUR_MIN, le=sla_mod.RESPONSE_HOUR_MAX)
    sev3_response_hours: float = Field(..., ge=sla_mod.RESPONSE_HOUR_MIN, le=sla_mod.RESPONSE_HOUR_MAX)
    sev4_response_hours: float = Field(..., ge=sla_mod.RESPONSE_HOUR_MIN, le=sla_mod.RESPONSE_HOUR_MAX)
    rto_minutes: int = Field(..., ge=sla_mod.RECOVERY_MIN, le=sla_mod.RECOVERY_MAX)
    rpo_minutes: int = Field(..., ge=sla_mod.RECOVERY_MIN, le=sla_mod.RECOVERY_MAX)
    effective_from: str
    effective_until: Optional[str] = None
    notes: Optional[str] = Field(None, max_length=sla_mod.MAX_NOTES_LEN)
    supersede_reason: Optional[str] = Field(None, max_length=256)


class ArchiveIn(BaseModel):
    reason: Optional[str] = Field(None, max_length=256)


def _rid(request):
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _to_out(v):
    return CommitmentOut(**v.__dict__)


@router.get("", response_model=ListOut)
def list_sla(
    include_archived: bool = Query(False),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
):
    entries = sla_mod.list_commitments(
        tenant_id=tenant,
        include_archived=include_archived,
        limit=limit,
        offset=offset,
    )
    c = sla_mod.counts(tenant_id=tenant)
    return ListOut(
        tenant_id=tenant,
        active_count=int(c["active"]),
        archived_count=int(c["archived"]),
        in_force_count=int(c["in_force"]),
        total=int(c["total"]),
        entries=[_to_out(e) for e in entries],
    )


@router.get("/export.csv")
def export_csv(
    include_archived: bool = Query(True),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
):
    entries = sla_mod.list_commitments(
        tenant_id=tenant, include_archived=include_archived, limit=500, offset=0
    )
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([
        "id", "contract_ref", "plan", "uptime_pct",
        "sev1_response_hours", "sev2_response_hours",
        "sev3_response_hours", "sev4_response_hours",
        "rto_minutes", "rpo_minutes",
        "effective_from", "effective_until", "status", "version",
        "created_by", "created_at",
        "archived_by", "archived_at", "archive_reason", "superseded_by_id",
        "notes",
    ])
    for e in entries:
        w.writerow([
            e.id, e.contract_ref, e.plan, e.uptime_pct,
            e.sev1_response_hours, e.sev2_response_hours,
            e.sev3_response_hours, e.sev4_response_hours,
            e.rto_minutes, e.rpo_minutes,
            e.effective_from, e.effective_until or "", e.status, e.version,
            e.created_by, e.created_at,
            e.archived_by or "", e.archived_at or "", e.archive_reason or "",
            e.superseded_by_id or "",
            (e.notes or "").replace("\n", " "),
        ])
    data = buf.getvalue()
    fname = "sla-commitments-%s.csv" % tenant
    return StreamingResponse(
        iter([data]),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="%s"' % fname},
    )


@router.get("/{commitment_id}", response_model=CommitmentOut)
def get_one(
    commitment_id: int,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
):
    v = sla_mod.get_commitment(tenant_id=tenant, commitment_id=commitment_id)
    if v is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    return _to_out(v)


@router.post("", response_model=CommitmentOut, status_code=201)
def create(
    body: CreateIn,
    request: Request,
    dry_run: bool = Query(False),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.sla.create",
            principal=p,
            target=tenant,
            details={
                "contract_ref": body.contract_ref,
                "plan": body.plan,
                "uptime_pct": body.uptime_pct,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="record_sla_commitment",
            tenant_id=tenant,
            contract_ref=body.contract_ref,
            uptime_pct=body.uptime_pct,
            effective_from=body.effective_from,
            effective_until=body.effective_until,
        )
    try:
        view = sla_mod.create_commitment(
            tenant_id=tenant,
            contract_ref=body.contract_ref,
            plan=body.plan,
            uptime_pct=body.uptime_pct,
            sev1_response_hours=body.sev1_response_hours,
            sev2_response_hours=body.sev2_response_hours,
            sev3_response_hours=body.sev3_response_hours,
            sev4_response_hours=body.sev4_response_hours,
            rto_minutes=body.rto_minutes,
            rpo_minutes=body.rpo_minutes,
            effective_from=body.effective_from,
            effective_until=body.effective_until,
            notes=body.notes,
            created_by=caller,
            supersede_reason=body.supersede_reason,
        )
    except sla_mod.SLAError as exc:
        record_admin_action(
            action="workspace.sla.create",
            principal=p,
            target=tenant,
            details={"contract_ref": body.contract_ref},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.sla.create",
        principal=p,
        target=tenant,
        details={
            "id": view.id,
            "contract_ref": view.contract_ref,
            "plan": view.plan,
            "uptime_pct": view.uptime_pct,
            "sev1_hours": view.sev1_response_hours,
            "rto_minutes": view.rto_minutes,
            "rpo_minutes": view.rpo_minutes,
            "effective_from": view.effective_from,
            "effective_until": view.effective_until,
            "version": view.version,
        },
        request_id=_rid(request),
    )
    log.info(
        "sla_commitment_created",
        tenant=tenant, commitment_id=view.id, caller=caller,
    )
    return _to_out(view)


@router.post("/{commitment_id}/archive", response_model=CommitmentOut)
def archive(
    commitment_id: int,
    request: Request,
    body: ArchiveIn | None = None,
    dry_run: bool = Query(False),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    reason = body.reason if body is not None else None
    existing = sla_mod.get_commitment(tenant_id=tenant, commitment_id=commitment_id)
    if existing is None:
        record_admin_action(
            action="workspace.sla.archive",
            principal=p,
            target=str(commitment_id),
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
            action="workspace.sla.archive",
            principal=p,
            target=str(commitment_id),
            details={"dry_run": dry_run},
            ok=False,
            error="already archived",
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="commitment already archived",
        )
    if dry_run:
        record_admin_action(
            action="workspace.sla.archive",
            principal=p,
            target=str(commitment_id),
            details={"dry_run": True, "reason": reason},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="archive_sla_commitment",
            tenant_id=tenant,
            commitment_id=commitment_id,
        )
    view = sla_mod.archive_commitment(
        tenant_id=tenant,
        commitment_id=commitment_id,
        archived_by=caller,
        reason=reason,
    )
    if view is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="commitment not found or already archived",
        )
    record_admin_action(
        action="workspace.sla.archive",
        principal=p,
        target=str(commitment_id),
        details={"reason": reason},
        request_id=_rid(request),
    )
    log.info(
        "sla_commitment_archived",
        tenant=tenant, commitment_id=commitment_id, caller=caller,
    )
    return _to_out(view)


@public_router.get("/current", response_model=CurrentOut)
def current(
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
):
    """Return the in-force SLA commitment for the caller's own tenant."""
    v = sla_mod.current_commitment(tenant_id=tenant)
    return CurrentOut(tenant_id=tenant, in_force=_to_out(v) if v else None)
