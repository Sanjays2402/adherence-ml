"""/v1/admin/model-cards: per-tenant AI Transparency Register.

Reads require ``viewer``. Mutations require ``admin`` and an active MFA
challenge. Every mutation writes an admin audit row with actor, IP, and
request id. All queries are strictly tenant-scoped: there is no path
that can read or mutate another tenant's model cards.

A read-only view of the in-force card for a given ``(model_name,
model_version)`` is exposed at ``/v1/model-cards/active`` for the
caller's own tenant only.
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
from adherence_common import model_cards as mc_mod
from adherence_common.csv_safe import safe_row
from adherence_common.admin_audit import record_admin_action
from adherence_common.logging import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/v1/admin/model-cards", tags=["model-cards"])
public_router = APIRouter(prefix="/v1/model-cards", tags=["model-cards"])


class CardOut(BaseModel):
    id: int
    tenant_id: str
    model_name: str
    model_version: str
    owner: str
    intended_use: Optional[str] = None
    training_data_summary: Optional[str] = None
    training_data_sensitivity: str
    evaluation_summary: Optional[str] = None
    limitations: Optional[str] = None
    phi_suitable: bool
    fairness_status: str
    last_validated_at: Optional[str] = None
    model_card_url: Optional[str] = None
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
    phi_suitable_count: int
    unvalidated_active_count: int
    total: int
    entries: list[CardOut]


class ActiveOut(BaseModel):
    tenant_id: str
    model_name: str
    model_version: str
    active: Optional[CardOut] = None


class CreateIn(BaseModel):
    model_name: str = Field(..., min_length=mc_mod.MIN_NAME_LEN, max_length=mc_mod.MAX_NAME_LEN)
    model_version: str = Field(..., min_length=1, max_length=mc_mod.MAX_VERSION_LEN)
    owner: str = Field(..., min_length=1, max_length=mc_mod.MAX_OWNER_LEN)
    intended_use: Optional[str] = Field(None, max_length=mc_mod.MAX_INTENDED_USE_LEN)
    training_data_summary: Optional[str] = Field(
        None, max_length=mc_mod.MAX_TRAINING_DATA_LEN
    )
    training_data_sensitivity: str = Field("none", max_length=16)
    evaluation_summary: Optional[str] = Field(None, max_length=mc_mod.MAX_EVAL_LEN)
    limitations: Optional[str] = Field(None, max_length=mc_mod.MAX_LIMITATIONS_LEN)
    phi_suitable: bool = False
    fairness_status: str = Field("not_assessed", max_length=32)
    last_validated_at: Optional[str] = None
    model_card_url: Optional[str] = Field(None, max_length=mc_mod.MAX_URL_LEN)
    notes: Optional[str] = Field(None, max_length=mc_mod.MAX_NOTES_LEN)
    supersede_reason: Optional[str] = Field(None, max_length=mc_mod.MAX_REASON_LEN)

    model_config = {"protected_namespaces": ()}


class ArchiveIn(BaseModel):
    reason: Optional[str] = Field(None, max_length=mc_mod.MAX_REASON_LEN)


def _rid(request):
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _to_out(v):
    return CardOut(**v.__dict__)


@router.get("", response_model=ListOut)
def list_cards(
    include_archived: bool = Query(False),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
):
    entries = mc_mod.list_cards(
        tenant_id=tenant,
        include_archived=include_archived,
        limit=limit,
        offset=offset,
    )
    c = mc_mod.counts(tenant_id=tenant)
    return ListOut(
        tenant_id=tenant,
        active_count=int(c["active"]),
        archived_count=int(c["archived"]),
        phi_suitable_count=int(c["phi_suitable"]),
        unvalidated_active_count=int(c["unvalidated_active"]),
        total=int(c["total"]),
        entries=[_to_out(e) for e in entries],
    )


@router.get("/export.csv")
def export_csv(
    include_archived: bool = Query(True),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
):
    entries = mc_mod.list_cards(
        tenant_id=tenant, include_archived=include_archived, limit=500, offset=0
    )
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([
        "id", "model_name", "model_version", "owner",
        "training_data_sensitivity", "phi_suitable", "fairness_status",
        "last_validated_at", "model_card_url", "status", "version",
        "created_by", "created_at",
        "archived_by", "archived_at", "archive_reason", "superseded_by_id",
        "intended_use", "training_data_summary", "evaluation_summary",
        "limitations", "notes",
    ])
    for e in entries:
        w.writerow(safe_row([
            e.id, e.model_name, e.model_version, e.owner,
            e.training_data_sensitivity, "1" if e.phi_suitable else "0",
            e.fairness_status, e.last_validated_at or "",
            e.model_card_url or "", e.status, e.version,
            e.created_by, e.created_at,
            e.archived_by or "", e.archived_at or "", e.archive_reason or "",
            e.superseded_by_id or "",
            (e.intended_use or "").replace("\n", " "),
            (e.training_data_summary or "").replace("\n", " "),
            (e.evaluation_summary or "").replace("\n", " "),
            (e.limitations or "").replace("\n", " "),
            (e.notes or "").replace("\n", " "),
        ]))
    data = buf.getvalue()
    fname = "ai-model-cards-%s.csv" % tenant
    return StreamingResponse(
        iter([data]),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="%s"' % fname},
    )


@router.get("/{card_id}", response_model=CardOut)
def get_one(
    card_id: int,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
):
    v = mc_mod.get_card(tenant_id=tenant, card_id=card_id)
    if v is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    return _to_out(v)


@router.post("", response_model=CardOut, status_code=201)
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
            action="workspace.model_card.create",
            principal=p,
            target=tenant,
            details={
                "model_name": body.model_name,
                "model_version": body.model_version,
                "phi_suitable": body.phi_suitable,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="record_model_card",
            tenant_id=tenant,
            model_name=body.model_name,
            model_version=body.model_version,
            phi_suitable=body.phi_suitable,
        )
    try:
        view = mc_mod.create_card(
            tenant_id=tenant,
            model_name=body.model_name,
            model_version=body.model_version,
            owner=body.owner,
            intended_use=body.intended_use,
            training_data_summary=body.training_data_summary,
            training_data_sensitivity=body.training_data_sensitivity,
            evaluation_summary=body.evaluation_summary,
            limitations=body.limitations,
            phi_suitable=body.phi_suitable,
            fairness_status=body.fairness_status,
            last_validated_at=body.last_validated_at,
            model_card_url=body.model_card_url,
            notes=body.notes,
            created_by=caller,
            supersede_reason=body.supersede_reason,
        )
    except mc_mod.ModelCardError as exc:
        record_admin_action(
            action="workspace.model_card.create",
            principal=p,
            target=tenant,
            details={
                "model_name": body.model_name,
                "model_version": body.model_version,
            },
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.model_card.create",
        principal=p,
        target=tenant,
        details={
            "id": view.id,
            "model_name": view.model_name,
            "model_version": view.model_version,
            "owner": view.owner,
            "phi_suitable": view.phi_suitable,
            "training_data_sensitivity": view.training_data_sensitivity,
            "fairness_status": view.fairness_status,
            "version": view.version,
        },
        request_id=_rid(request),
    )
    log.info(
        "ai_model_card_created",
        tenant=tenant, card_id=view.id, caller=caller,
        model=view.model_name, version=view.model_version,
    )
    return _to_out(view)


@router.post("/{card_id}/archive", response_model=CardOut)
def archive(
    card_id: int,
    request: Request,
    body: ArchiveIn | None = None,
    dry_run: bool = Query(False),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    reason = body.reason if body is not None else None
    existing = mc_mod.get_card(tenant_id=tenant, card_id=card_id)
    if existing is None:
        record_admin_action(
            action="workspace.model_card.archive",
            principal=p,
            target=str(card_id),
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
            action="workspace.model_card.archive",
            principal=p,
            target=str(card_id),
            details={"dry_run": dry_run},
            ok=False,
            error="already archived",
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="model card already archived",
        )
    if dry_run:
        record_admin_action(
            action="workspace.model_card.archive",
            principal=p,
            target=str(card_id),
            details={"dry_run": True, "reason": reason},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="archive_model_card",
            tenant_id=tenant,
            card_id=card_id,
        )
    view = mc_mod.archive_card(
        tenant_id=tenant,
        card_id=card_id,
        archived_by=caller,
        reason=reason,
    )
    if view is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="model card not found or already archived",
        )
    record_admin_action(
        action="workspace.model_card.archive",
        principal=p,
        target=str(card_id),
        details={
            "reason": reason,
            "model_name": view.model_name,
            "model_version": view.model_version,
        },
        request_id=_rid(request),
    )
    log.info(
        "ai_model_card_archived",
        tenant=tenant, card_id=card_id, caller=caller,
    )
    return _to_out(view)


@public_router.get("/active", response_model=ActiveOut)
def active(
    model_name: str = Query(..., min_length=mc_mod.MIN_NAME_LEN, max_length=mc_mod.MAX_NAME_LEN),
    model_version: str = Query(..., min_length=1, max_length=mc_mod.MAX_VERSION_LEN),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
):
    """Return the in-force model card for ``(model_name, model_version)``."""
    try:
        v = mc_mod.get_active(
            tenant_id=tenant,
            model_name=model_name,
            model_version=model_version,
        )
    except mc_mod.ModelCardError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return ActiveOut(
        tenant_id=tenant,
        model_name=model_name,
        model_version=model_version,
        active=_to_out(v) if v else None,
    )
