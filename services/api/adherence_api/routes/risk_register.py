"""/v1/admin/risk-register: per-tenant enterprise risk register.

ISO 31000 / COSO ERM / SOC 2 CC3.2 / NIST RMF all require a
forward-looking risk register. This router exposes one as REST so a
workspace owner can show their auditor or buyer a live register
instead of a static spreadsheet.

* ``GET    /v1/admin/risk-register`` lists entries (active by default,
  optional ``category`` filter).
* ``POST   /v1/admin/risk-register`` creates a new entry.
* ``GET    /v1/admin/risk-register/summary`` returns counts of active,
  closed, overdue, and a top-residual-risk breakdown.
* ``GET    /v1/admin/risk-register/{id}`` returns one entry.
* ``PUT    /v1/admin/risk-register/{id}`` updates one entry and bumps
  ``version``.
* ``POST   /v1/admin/risk-register/{id}/close`` closes one entry
  without destroying the historical record.
* ``GET    /v1/admin/risk-register/export.csv`` streams the register
  as CSV for procurement and audit packs.

Reads require ``viewer`` and above. Mutations require ``admin`` *and*
an active MFA challenge, mirroring legal hold, retention policy, RoPA,
DPIA, and incidents. Every mutation writes an admin audit row. All
queries are strictly tenant-scoped: there is no cross-tenant read or
write surface on this router.
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
from adherence_common import risk_register as rr_mod
from adherence_common.csv_safe import safe_row
from adherence_common.admin_audit import record_admin_action
from adherence_common.logging import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/v1/admin/risk-register", tags=["risk-register"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class RiskOut(BaseModel):
    id: int
    tenant_id: str
    title: str
    category: str
    description: str
    asset: Optional[str] = None
    likelihood: int
    impact: int
    inherent_score: int
    mitigations: Optional[str] = None
    residual_likelihood: int
    residual_impact: int
    residual_score: int
    treatment: str
    owner: str
    status: str
    identified_at: str
    next_review_at: Optional[str] = None
    notes: Optional[str] = None
    version: int
    created_by: str
    created_at: str
    updated_by: Optional[str] = None
    updated_at: Optional[str] = None
    closed_by: Optional[str] = None
    closed_at: Optional[str] = None
    closed_reason: Optional[str] = None
    active: bool
    review_overdue: bool


class RiskListOut(BaseModel):
    tenant_id: str
    active_count: int
    closed_count: int
    overdue_count: int
    entries: list[RiskOut]


class RiskSummaryOut(BaseModel):
    tenant_id: str
    active_count: int
    overdue_count: int
    by_category: dict[str, int]
    by_status: dict[str, int]
    by_treatment: dict[str, int]
    top_residual: list[RiskOut]


class CreateRiskIn(BaseModel):
    title: str = Field(
        ...,
        min_length=rr_mod.MIN_TITLE_LEN,
        max_length=rr_mod.MAX_TITLE_LEN,
    )
    category: str = Field(
        ...,
        description="One of: " + ", ".join(rr_mod.CATEGORIES),
    )
    description: str = Field(
        ...,
        min_length=rr_mod.MIN_DESC_LEN,
        max_length=rr_mod.MAX_DESC_LEN,
    )
    asset: Optional[str] = Field(None, max_length=rr_mod.MAX_ASSET_LEN)
    likelihood: int = Field(..., ge=rr_mod.SCORE_MIN, le=rr_mod.SCORE_MAX)
    impact: int = Field(..., ge=rr_mod.SCORE_MIN, le=rr_mod.SCORE_MAX)
    mitigations: Optional[str] = Field(None, max_length=rr_mod.MAX_MITIGATIONS_LEN)
    residual_likelihood: Optional[int] = Field(
        None, ge=rr_mod.SCORE_MIN, le=rr_mod.SCORE_MAX
    )
    residual_impact: Optional[int] = Field(
        None, ge=rr_mod.SCORE_MIN, le=rr_mod.SCORE_MAX
    )
    treatment: str = Field(
        ..., description="One of: " + ", ".join(rr_mod.TREATMENTS)
    )
    owner: str = Field(..., min_length=1, max_length=rr_mod.MAX_OWNER_LEN)
    status: Optional[str] = Field(
        None, description="One of: " + ", ".join(rr_mod.STATUSES)
    )
    identified_at: Optional[str] = Field(
        None, description="ISO-8601 date or datetime; defaults to now."
    )
    next_review_at: Optional[str] = Field(
        None, description="ISO-8601 date or datetime; review due date."
    )
    notes: Optional[str] = Field(None, max_length=rr_mod.MAX_NOTES_LEN)


class UpdateRiskIn(BaseModel):
    title: Optional[str] = Field(
        None,
        min_length=rr_mod.MIN_TITLE_LEN,
        max_length=rr_mod.MAX_TITLE_LEN,
    )
    category: Optional[str] = None
    description: Optional[str] = Field(
        None,
        min_length=rr_mod.MIN_DESC_LEN,
        max_length=rr_mod.MAX_DESC_LEN,
    )
    asset: Optional[str] = Field(None, max_length=rr_mod.MAX_ASSET_LEN)
    likelihood: Optional[int] = Field(
        None, ge=rr_mod.SCORE_MIN, le=rr_mod.SCORE_MAX
    )
    impact: Optional[int] = Field(
        None, ge=rr_mod.SCORE_MIN, le=rr_mod.SCORE_MAX
    )
    mitigations: Optional[str] = Field(None, max_length=rr_mod.MAX_MITIGATIONS_LEN)
    residual_likelihood: Optional[int] = Field(
        None, ge=rr_mod.SCORE_MIN, le=rr_mod.SCORE_MAX
    )
    residual_impact: Optional[int] = Field(
        None, ge=rr_mod.SCORE_MIN, le=rr_mod.SCORE_MAX
    )
    treatment: Optional[str] = None
    owner: Optional[str] = Field(
        None, min_length=1, max_length=rr_mod.MAX_OWNER_LEN
    )
    status: Optional[str] = None
    identified_at: Optional[str] = None
    next_review_at: Optional[str] = None
    notes: Optional[str] = Field(None, max_length=rr_mod.MAX_NOTES_LEN)


class CloseRiskIn(BaseModel):
    reason: Optional[str] = Field(None, max_length=256)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _to_out(v: rr_mod.RiskView) -> RiskOut:
    return RiskOut(**v.__dict__)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=RiskListOut)
def list_risks(
    include_closed: bool = Query(False),
    category: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> RiskListOut:
    entries = rr_mod.list_entries(
        tenant_id=tenant,
        include_closed=include_closed,
        category=category,
        limit=limit,
        offset=offset,
    )
    active = sum(1 for e in entries if e.active)
    closed = sum(1 for e in entries if not e.active)
    overdue = sum(1 for e in entries if e.review_overdue)
    return RiskListOut(
        tenant_id=tenant,
        active_count=active,
        closed_count=closed,
        overdue_count=overdue,
        entries=[_to_out(e) for e in entries],
    )


@router.get("/summary", response_model=RiskSummaryOut)
def summary(
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> RiskSummaryOut:
    active = rr_mod.list_entries(tenant_id=tenant, include_closed=False, limit=500)
    by_category: dict[str, int] = {}
    by_status: dict[str, int] = {}
    by_treatment: dict[str, int] = {}
    for e in active:
        by_category[e.category] = by_category.get(e.category, 0) + 1
        by_status[e.status] = by_status.get(e.status, 0) + 1
        by_treatment[e.treatment] = by_treatment.get(e.treatment, 0) + 1
    top = sorted(active, key=lambda e: (-e.residual_score, -e.inherent_score))[:5]
    return RiskSummaryOut(
        tenant_id=tenant,
        active_count=len(active),
        overdue_count=sum(1 for e in active if e.review_overdue),
        by_category=by_category,
        by_status=by_status,
        by_treatment=by_treatment,
        top_residual=[_to_out(e) for e in top],
    )


@router.get("/export.csv")
def export_csv(
    include_closed: bool = Query(False),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
):
    """Stream the register as CSV for procurement and audit packs."""
    entries = rr_mod.list_entries(
        tenant_id=tenant, include_closed=include_closed, limit=500, offset=0
    )
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "id",
            "title",
            "category",
            "description",
            "asset",
            "likelihood",
            "impact",
            "inherent_score",
            "mitigations",
            "residual_likelihood",
            "residual_impact",
            "residual_score",
            "treatment",
            "owner",
            "status",
            "identified_at",
            "next_review_at",
            "review_overdue",
            "notes",
            "version",
            "created_by",
            "created_at",
            "updated_by",
            "updated_at",
            "closed_by",
            "closed_at",
            "closed_reason",
        ]
    )
    for e in entries:
        w.writerow(safe_row(
            [
                e.id,
                e.title,
                e.category,
                e.description,
                e.asset or "",
                e.likelihood,
                e.impact,
                e.inherent_score,
                e.mitigations or "",
                e.residual_likelihood,
                e.residual_impact,
                e.residual_score,
                e.treatment,
                e.owner,
                e.status,
                e.identified_at,
                e.next_review_at or "",
                "true" if e.review_overdue else "false",
                e.notes or "",
                e.version,
                e.created_by,
                e.created_at,
                e.updated_by or "",
                e.updated_at or "",
                e.closed_by or "",
                e.closed_at or "",
                e.closed_reason or "",
            ]
        ))
    data = buf.getvalue()
    fname = f"risk-register-{tenant}.csv"
    return StreamingResponse(
        iter([data]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/{entry_id}", response_model=RiskOut)
def get_one(
    entry_id: int,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> RiskOut:
    v = rr_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if v is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    return _to_out(v)


@router.post("", response_model=RiskOut, status_code=201)
def create(
    body: CreateRiskIn,
    request: Request,
    dry_run: bool = Query(False, description="Preview without persisting."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.risk_register.create",
            principal=p,
            target=tenant,
            details={
                "title": body.title,
                "category": body.category,
                "treatment": body.treatment,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="create_risk_entry",
            tenant_id=tenant,
            title=body.title,
            category=body.category,
            treatment=body.treatment,
        )
    try:
        view = rr_mod.create_entry(
            tenant_id=tenant,
            title=body.title,
            category=body.category,
            description=body.description,
            asset=body.asset,
            likelihood=body.likelihood,
            impact=body.impact,
            mitigations=body.mitigations,
            residual_likelihood=body.residual_likelihood,
            residual_impact=body.residual_impact,
            treatment=body.treatment,
            owner=body.owner,
            status=body.status,
            identified_at=body.identified_at,
            next_review_at=body.next_review_at,
            notes=body.notes,
            created_by=caller,
        )
    except rr_mod.RiskRegisterError as exc:
        record_admin_action(
            action="workspace.risk_register.create",
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
        action="workspace.risk_register.create",
        principal=p,
        target=tenant,
        details={
            "id": view.id,
            "title": view.title,
            "category": view.category,
            "treatment": view.treatment,
            "inherent_score": view.inherent_score,
            "residual_score": view.residual_score,
        },
        request_id=_rid(request),
    )
    log.info(
        "risk_entry_created",
        tenant=tenant,
        risk_id=view.id,
        caller=caller,
    )
    return _to_out(view)


@router.put("/{entry_id}", response_model=RiskOut)
def update(
    entry_id: int,
    body: UpdateRiskIn,
    request: Request,
    dry_run: bool = Query(False, description="Preview without persisting."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = rr_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if existing is None or not existing.active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    if dry_run:
        record_admin_action(
            action="workspace.risk_register.update",
            principal=p,
            target=str(entry_id),
            details={
                "dry_run": True,
                "fields": [
                    k for k, v in body.dict().items() if v is not None
                ],
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="update_risk_entry",
            tenant_id=tenant,
            entry_id=entry_id,
        )
    try:
        view = rr_mod.update_entry(
            tenant_id=tenant,
            entry_id=entry_id,
            updated_by=caller,
            title=body.title,
            category=body.category,
            description=body.description,
            asset=body.asset,
            likelihood=body.likelihood,
            impact=body.impact,
            mitigations=body.mitigations,
            residual_likelihood=body.residual_likelihood,
            residual_impact=body.residual_impact,
            treatment=body.treatment,
            owner=body.owner,
            status=body.status,
            identified_at=body.identified_at,
            next_review_at=body.next_review_at,
            notes=body.notes,
        )
    except rr_mod.RiskRegisterError as exc:
        record_admin_action(
            action="workspace.risk_register.update",
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
        action="workspace.risk_register.update",
        principal=p,
        target=str(entry_id),
        details={
            "version": view.version,
            "residual_score": view.residual_score,
        },
        request_id=_rid(request),
    )
    return _to_out(view)


@router.post("/{entry_id}/close", response_model=RiskOut)
def close(
    entry_id: int,
    request: Request,
    body: CloseRiskIn = CloseRiskIn(),
    dry_run: bool = Query(False, description="Preview without closing."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = rr_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if existing is None:
        record_admin_action(
            action="workspace.risk_register.close",
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
            action="workspace.risk_register.close",
            principal=p,
            target=str(entry_id),
            details={"dry_run": dry_run},
            ok=False,
            error="already closed",
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="entry already closed",
        )
    if dry_run:
        record_admin_action(
            action="workspace.risk_register.close",
            principal=p,
            target=str(entry_id),
            details={"dry_run": True, "reason": body.reason},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="close_risk_entry",
            tenant_id=tenant,
            entry_id=entry_id,
        )
    view = rr_mod.close_entry(
        tenant_id=tenant,
        entry_id=entry_id,
        closed_by=caller,
        reason=body.reason,
    )
    if view is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="entry not found or already closed",
        )
    record_admin_action(
        action="workspace.risk_register.close",
        principal=p,
        target=str(entry_id),
        details={"reason": body.reason},
        request_id=_rid(request),
    )
    log.info(
        "risk_entry_closed",
        tenant=tenant,
        risk_id=entry_id,
        caller=caller,
    )
    return _to_out(view)
