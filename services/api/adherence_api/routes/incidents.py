"""/v1/admin/incidents: per-tenant security incident register.

Compliance scope
----------------

* GDPR Art. 33(1): customers can prove the 72-hour authority
  notification window. ``notification_deadline_at`` is auto-computed
  for high/critical incidents and for anything flagged as a personal
  data breach.
* GDPR Art. 34: subject-notification timestamp is captured.
* SOC2 CC7.4: incidents have a full lifecycle (open, contained,
  resolved) plus an append-only timeline of operator updates.

Authorization
-------------

* Read: ``viewer`` and above.
* Mutations: ``admin`` role *and* an active MFA challenge (same
  pattern as legal hold and retention policy). Every mutation is
  mirrored into the admin audit log with a redacted detail payload.

All operations are scoped strictly to the caller's tenant. There is
no cross-tenant read or write surface on this router.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import current_tenant, require_admin, require_viewer
from adherence_api.dry_run import dry_run_response
from adherence_api.routes.admin_mfa import require_admin_mfa
from adherence_common import incidents as inc_mod
from adherence_common.admin_audit import record_admin_action
from adherence_common.logging import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/v1/admin/incidents", tags=["incidents"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class IncidentUpdateOut(BaseModel):
    id: int
    incident_id: int
    author: str
    note: str
    created_at: str


class IncidentOut(BaseModel):
    id: int
    tenant_id: str
    title: str
    summary: str
    severity: str
    status: str
    personal_data_breach: bool
    affected_user_count: int | None
    external_ref: str | None
    opened_by: str
    discovered_at: str
    opened_at: str
    contained_at: str | None
    resolved_at: str | None
    resolved_by: str | None
    resolution_note: str | None
    notified_authority_at: str | None
    notified_subjects_at: str | None
    notification_deadline_at: str | None
    updates: list[IncidentUpdateOut]


class IncidentSummary(BaseModel):
    open: int
    breaches_open: int
    past_deadline: int


class IncidentListOut(BaseModel):
    tenant_id: str
    summary: IncidentSummary
    entries: list[IncidentOut]


class OpenIncidentIn(BaseModel):
    title: str = Field(
        ...,
        min_length=inc_mod.MIN_TITLE_LEN,
        max_length=inc_mod.MAX_TITLE_LEN,
    )
    summary: str = Field(
        ...,
        min_length=inc_mod.MIN_SUMMARY_LEN,
        max_length=inc_mod.MAX_SUMMARY_LEN,
    )
    severity: str = Field(..., description="low | medium | high | critical")
    personal_data_breach: bool = False
    affected_user_count: int | None = Field(None, ge=0)
    external_ref: str | None = Field(None, max_length=inc_mod.MAX_REF_LEN)


class UpdateIn(BaseModel):
    note: str = Field(..., min_length=1, max_length=inc_mod.MAX_UPDATE_LEN)


class MilestoneIn(BaseModel):
    milestone: str = Field(
        ...,
        description=(
            "contained | notified_authority | notified_subjects | resolved"
        ),
    )
    note: str | None = Field(None, max_length=inc_mod.MAX_SUMMARY_LEN)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _to_out(v: inc_mod.IncidentView) -> IncidentOut:
    return IncidentOut(
        id=v.id,
        tenant_id=v.tenant_id,
        title=v.title,
        summary=v.summary,
        severity=v.severity,
        status=v.status,
        personal_data_breach=v.personal_data_breach,
        affected_user_count=v.affected_user_count,
        external_ref=v.external_ref,
        opened_by=v.opened_by,
        discovered_at=v.discovered_at,
        opened_at=v.opened_at,
        contained_at=v.contained_at,
        resolved_at=v.resolved_at,
        resolved_by=v.resolved_by,
        resolution_note=v.resolution_note,
        notified_authority_at=v.notified_authority_at,
        notified_subjects_at=v.notified_subjects_at,
        notification_deadline_at=v.notification_deadline_at,
        updates=[
            IncidentUpdateOut(
                id=u.id,
                incident_id=u.incident_id,
                author=u.author,
                note=u.note,
                created_at=u.created_at,
            )
            for u in v.updates
        ],
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=IncidentListOut)
def list_incidents(
    include_resolved: bool = Query(True),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> IncidentListOut:
    entries = inc_mod.list_incidents(
        tenant_id=tenant,
        include_resolved=include_resolved,
        limit=limit,
        offset=offset,
    )
    summary = inc_mod.open_breach_summary(tenant)
    return IncidentListOut(
        tenant_id=tenant,
        summary=IncidentSummary(**summary),
        entries=[_to_out(e) for e in entries],
    )


@router.get("/{incident_id}", response_model=IncidentOut)
def get_incident(
    incident_id: int,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> IncidentOut:
    view = inc_mod.get_incident(tenant_id=tenant, incident_id=incident_id)
    if view is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="incident not found"
        )
    return _to_out(view)


@router.post("", status_code=201)
def open_incident(
    body: OpenIncidentIn,
    request: Request,
    dry_run: bool = Query(False),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.incident.open",
            principal=p,
            target=body.title[:64],
            details={
                "severity": body.severity,
                "personal_data_breach": body.personal_data_breach,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="open_incident",
            tenant_id=tenant,
            title=body.title,
            severity=body.severity,
            personal_data_breach=body.personal_data_breach,
        )
    try:
        view = inc_mod.open_incident(
            tenant_id=tenant,
            title=body.title,
            summary=body.summary,
            severity=body.severity,
            opened_by=caller,
            personal_data_breach=body.personal_data_breach,
            affected_user_count=body.affected_user_count,
            external_ref=body.external_ref,
        )
    except inc_mod.IncidentError as exc:
        record_admin_action(
            action="workspace.incident.open",
            principal=p,
            target=body.title[:64],
            details={"severity": body.severity},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.incident.open",
        principal=p,
        target=str(view.id),
        details={
            "severity": view.severity,
            "personal_data_breach": view.personal_data_breach,
            "deadline": view.notification_deadline_at,
        },
        request_id=_rid(request),
    )
    log.warning(
        "incident_opened",
        tenant=tenant,
        incident_id=view.id,
        severity=view.severity,
        personal_data_breach=view.personal_data_breach,
        request_id=_rid(request),
    )
    return _to_out(view)


@router.post("/{incident_id}/updates", response_model=IncidentUpdateOut, status_code=201)
def append_update(
    incident_id: int,
    body: UpdateIn,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    try:
        view = inc_mod.append_update(
            tenant_id=tenant,
            incident_id=incident_id,
            author=caller,
            note=body.note,
        )
    except inc_mod.IncidentError as exc:
        record_admin_action(
            action="workspace.incident.update",
            principal=p,
            target=str(incident_id),
            details={"len": len(body.note)},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    if view is None:
        record_admin_action(
            action="workspace.incident.update",
            principal=p,
            target=str(incident_id),
            details=None,
            ok=False,
            error="incident not found",
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="incident not found"
        )
    record_admin_action(
        action="workspace.incident.update",
        principal=p,
        target=str(incident_id),
        details={"update_id": view.id},
        request_id=_rid(request),
    )
    return IncidentUpdateOut(
        id=view.id,
        incident_id=view.incident_id,
        author=view.author,
        note=view.note,
        created_at=view.created_at,
    )


@router.post("/{incident_id}/milestone", response_model=IncidentOut)
def record_milestone(
    incident_id: int,
    body: MilestoneIn,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    try:
        view = inc_mod.record_milestone(
            tenant_id=tenant,
            incident_id=incident_id,
            milestone=body.milestone,
            actor=caller,
            note=body.note,
        )
    except inc_mod.IncidentError as exc:
        record_admin_action(
            action=f"workspace.incident.milestone.{body.milestone}",
            principal=p,
            target=str(incident_id),
            details=None,
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    if view is None:
        record_admin_action(
            action=f"workspace.incident.milestone.{body.milestone}",
            principal=p,
            target=str(incident_id),
            details=None,
            ok=False,
            error="incident not found",
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="incident not found"
        )
    record_admin_action(
        action=f"workspace.incident.milestone.{body.milestone}",
        principal=p,
        target=str(incident_id),
        details={"status": view.status},
        request_id=_rid(request),
    )
    log.warning(
        "incident_milestone",
        tenant=tenant,
        incident_id=incident_id,
        milestone=body.milestone,
        request_id=_rid(request),
    )
    return _to_out(view)
