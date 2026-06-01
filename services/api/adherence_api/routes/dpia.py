"""/v1/admin/dpia: per-tenant GDPR Article 35 Data Protection Impact Assessment register.

A controller processing data likely to result in a high risk to the
rights and freedoms of natural persons must carry out a DPIA before
processing begins. Health data, large-scale profiling, and automated
decisions about individuals all sit on every supervisory authority's
"must DPIA" list, so a regulated buyer cannot adopt this service
without a per-workspace DPIA register.

* ``GET    /v1/admin/dpia`` lists entries (active by default).
* ``POST   /v1/admin/dpia`` creates a new entry.
* ``GET    /v1/admin/dpia/{id}`` returns one entry.
* ``PUT    /v1/admin/dpia/{id}`` updates one entry and bumps version.
* ``POST   /v1/admin/dpia/{id}/archive`` archives one entry without
  destroying the historical record.
* ``GET    /v1/admin/dpia/export.csv`` returns the register as a CSV
  download for procurement and audit packs.

Reads require ``viewer`` and above. Mutations require ``admin`` and an
active MFA challenge, mirroring RoPA, legal hold, incidents, and
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
from adherence_common import dpia as dpia_mod
from adherence_common.admin_audit import record_admin_action
from adherence_common.logging import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/v1/admin/dpia", tags=["dpia"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class DpiaOut(BaseModel):
    id: int
    tenant_id: str
    title: str
    description: str
    necessity: Optional[str] = None
    risks: Optional[str] = None
    mitigations: Optional[str] = None
    residual_risk: str
    dpo_consulted: bool
    consultation_required: bool
    review_due_at: str
    review_overdue: bool
    version: int
    created_by: str
    created_at: str
    updated_by: Optional[str] = None
    updated_at: Optional[str] = None
    archived_by: Optional[str] = None
    archived_at: Optional[str] = None
    active: bool


class DpiaListOut(BaseModel):
    tenant_id: str
    active_count: int
    archived_count: int
    overdue_count: int
    entries: list[DpiaOut]


class CreateDpiaIn(BaseModel):
    title: str = Field(
        ...,
        min_length=dpia_mod.MIN_TITLE_LEN,
        max_length=dpia_mod.MAX_TITLE_LEN,
        description="Short label for the high-risk processing activity.",
    )
    description: str = Field(
        ...,
        min_length=dpia_mod.MIN_DESCRIPTION_LEN,
        max_length=dpia_mod.MAX_DESCRIPTION_LEN,
        description="Systematic description of the processing under Art. 35(7)(a).",
    )
    residual_risk: str = Field(
        ...,
        description=(
            "Residual risk after mitigations. One of: "
            + ", ".join(dpia_mod.RISK_RATINGS)
        ),
    )
    necessity: Optional[str] = Field(
        None,
        max_length=dpia_mod.MAX_NECESSITY_LEN,
        description="Necessity and proportionality assessment under Art. 35(7)(b).",
    )
    risks: Optional[str] = Field(
        None,
        max_length=dpia_mod.MAX_RISKS_LEN,
        description="Identified risks to data subjects under Art. 35(7)(c).",
    )
    mitigations: Optional[str] = Field(
        None,
        max_length=dpia_mod.MAX_MITIGATIONS_LEN,
        description="Measures envisaged to address the risks under Art. 35(7)(d).",
    )
    dpo_consulted: bool = Field(
        False, description="Whether the Data Protection Officer was consulted."
    )
    consultation_required: bool = Field(
        False,
        description=(
            "Whether prior consultation with the supervisory authority under "
            "Art. 36 is required."
        ),
    )
    review_in_days: Optional[int] = Field(
        None,
        ge=dpia_mod.MIN_REVIEW_DAYS,
        le=dpia_mod.MAX_REVIEW_DAYS,
        description=(
            "Days from now until the next scheduled review. Defaults to "
            f"{dpia_mod.DEFAULT_REVIEW_DAYS}."
        ),
    )


class UpdateDpiaIn(BaseModel):
    description: Optional[str] = Field(
        None,
        min_length=dpia_mod.MIN_DESCRIPTION_LEN,
        max_length=dpia_mod.MAX_DESCRIPTION_LEN,
    )
    necessity: Optional[str] = Field(None, max_length=dpia_mod.MAX_NECESSITY_LEN)
    risks: Optional[str] = Field(None, max_length=dpia_mod.MAX_RISKS_LEN)
    mitigations: Optional[str] = Field(None, max_length=dpia_mod.MAX_MITIGATIONS_LEN)
    residual_risk: Optional[str] = None
    dpo_consulted: Optional[bool] = None
    consultation_required: Optional[bool] = None
    review_in_days: Optional[int] = Field(
        None,
        ge=dpia_mod.MIN_REVIEW_DAYS,
        le=dpia_mod.MAX_REVIEW_DAYS,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _to_out(v: dpia_mod.DpiaView) -> DpiaOut:
    return DpiaOut(**v.__dict__)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=DpiaListOut)
def list_dpia(
    include_archived: bool = Query(False),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> DpiaListOut:
    entries = dpia_mod.list_entries(
        tenant_id=tenant,
        include_archived=include_archived,
        limit=limit,
        offset=offset,
    )
    active = sum(1 for e in entries if e.active)
    archived = sum(1 for e in entries if not e.active)
    overdue = sum(1 for e in entries if e.active and e.review_overdue)
    return DpiaListOut(
        tenant_id=tenant,
        active_count=active,
        archived_count=archived,
        overdue_count=overdue,
        entries=[_to_out(e) for e in entries],
    )


@router.get("/export.csv")
def export_dpia_csv(
    include_archived: bool = Query(False),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
):
    """Stream the register as CSV for procurement and audit packs."""
    entries = dpia_mod.list_entries(
        tenant_id=tenant, include_archived=include_archived, limit=500, offset=0
    )
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "id",
            "title",
            "description",
            "necessity",
            "risks",
            "mitigations",
            "residual_risk",
            "dpo_consulted",
            "consultation_required",
            "review_due_at",
            "review_overdue",
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
                e.title,
                e.description,
                e.necessity or "",
                e.risks or "",
                e.mitigations or "",
                e.residual_risk,
                "yes" if e.dpo_consulted else "no",
                "yes" if e.consultation_required else "no",
                e.review_due_at,
                "yes" if e.review_overdue else "no",
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
    fname = f"dpia-{tenant}.csv"
    return StreamingResponse(
        iter([data]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/{entry_id}", response_model=DpiaOut)
def get_one(
    entry_id: int,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> DpiaOut:
    v = dpia_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if v is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    return _to_out(v)


@router.post("", response_model=DpiaOut, status_code=201)
def create(
    body: CreateDpiaIn,
    request: Request,
    dry_run: bool = Query(False, description="Preview without persisting."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.dpia.create",
            principal=p,
            target=tenant,
            details={
                "title": body.title,
                "residual_risk": body.residual_risk,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="create_dpia_entry",
            tenant_id=tenant,
            title=body.title,
            residual_risk=body.residual_risk,
        )
    try:
        view = dpia_mod.create_entry(
            tenant_id=tenant,
            title=body.title,
            description=body.description,
            residual_risk=body.residual_risk,
            created_by=caller,
            necessity=body.necessity,
            risks=body.risks,
            mitigations=body.mitigations,
            dpo_consulted=body.dpo_consulted,
            consultation_required=body.consultation_required,
            review_in_days=body.review_in_days,
        )
    except dpia_mod.DpiaError as exc:
        record_admin_action(
            action="workspace.dpia.create",
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
        action="workspace.dpia.create",
        principal=p,
        target=tenant,
        details={
            "id": view.id,
            "title": view.title,
            "residual_risk": view.residual_risk,
            "consultation_required": view.consultation_required,
        },
        request_id=_rid(request),
    )
    log.info("dpia_entry_created", tenant=tenant, dpia_id=view.id, caller=caller)
    return _to_out(view)


@router.put("/{entry_id}", response_model=DpiaOut)
def update(
    entry_id: int,
    body: UpdateDpiaIn,
    request: Request,
    dry_run: bool = Query(False, description="Preview without persisting."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = dpia_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if existing is None or not existing.active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    if dry_run:
        record_admin_action(
            action="workspace.dpia.update",
            principal=p,
            target=str(entry_id),
            details={
                "dry_run": True,
                "fields": [k for k, v in body.dict().items() if v is not None],
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="update_dpia_entry",
            tenant_id=tenant,
            entry_id=entry_id,
        )
    try:
        view = dpia_mod.update_entry(
            tenant_id=tenant,
            entry_id=entry_id,
            updated_by=caller,
            description=body.description,
            necessity=body.necessity,
            risks=body.risks,
            mitigations=body.mitigations,
            residual_risk=body.residual_risk,
            dpo_consulted=body.dpo_consulted,
            consultation_required=body.consultation_required,
            review_in_days=body.review_in_days,
        )
    except dpia_mod.DpiaError as exc:
        record_admin_action(
            action="workspace.dpia.update",
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
        action="workspace.dpia.update",
        principal=p,
        target=str(entry_id),
        details={"version": view.version, "residual_risk": view.residual_risk},
        request_id=_rid(request),
    )
    return _to_out(view)


@router.post("/{entry_id}/archive", response_model=DpiaOut)
def archive(
    entry_id: int,
    request: Request,
    dry_run: bool = Query(False, description="Preview without archiving."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = dpia_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if existing is None:
        record_admin_action(
            action="workspace.dpia.archive",
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
            action="workspace.dpia.archive",
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
            action="workspace.dpia.archive",
            principal=p,
            target=str(entry_id),
            details={"dry_run": True},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="archive_dpia_entry",
            tenant_id=tenant,
            entry_id=entry_id,
        )
    view = dpia_mod.archive_entry(
        tenant_id=tenant, entry_id=entry_id, archived_by=caller
    )
    if view is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="entry not found or already archived",
        )
    record_admin_action(
        action="workspace.dpia.archive",
        principal=p,
        target=str(entry_id),
        request_id=_rid(request),
    )
    log.info("dpia_entry_archived", tenant=tenant, dpia_id=entry_id, caller=caller)
    return _to_out(view)
