"""/v1/admin/dsar: per-tenant Data Subject Access Request register.

Compliance scope
----------------

* GDPR Art. 12(3): controllers respond to subject requests within one
  month. ``response_deadline_at`` is auto-computed on intake; the UI
  counts down against it and flags ``past_deadline`` requests for the
  admin tile.
* GDPR Art. 15-22 / CCPA-CPRA: the seven supported ``request_type``
  values cover access, erasure, rectification, restriction,
  portability, objection, and CCPA opt-out-of-sale.
* SOC2 CC1.4 / CC2.3: the append-only event timeline gives auditors
  evidence that intake, identity verification, fulfilment, and any
  rejection rationale were recorded with actor, timestamp, and tenant.

Authorization
-------------

* Read: ``viewer`` and above (privacy ops often sit outside engineering).
* Mutations: ``admin`` role *and* an active MFA challenge (same pattern
  as incidents, legal hold, and retention policy). Every mutation is
  mirrored into the admin audit log with the redacted subject e-mail
  fingerprint, never the raw address.

All operations are scoped strictly to the caller's tenant. There is
no cross-tenant read or write surface on this router. The intake POST
accepts an e-mail address but stores only a tenant-salted sha256
fingerprint plus an optional display redaction (``j***@acme.co``);
the raw address is retained only when the operator opts in via
``store_raw_contact`` and is purged automatically on close.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import current_tenant, require_admin, require_viewer
from adherence_api.dry_run import dry_run_response
from adherence_api.routes.admin_mfa import require_admin_mfa
from adherence_common import dsar as dsar_mod
from adherence_common.admin_audit import record_admin_action
from adherence_common.logging import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/v1/admin/dsar", tags=["dsar"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class DSAREventOut(BaseModel):
    id: int
    request_id: int
    kind: str
    author: str
    note: str
    created_at: str


class DSAROut(BaseModel):
    id: int
    tenant_id: str
    request_type: str
    status: str
    subject_name: str
    subject_email_hash: str
    subject_email_redacted: str | None
    has_raw_contact: bool
    description: str
    external_ref: str | None
    received_via: str | None
    opened_by: str
    received_at: str
    acknowledged_at: str | None
    identity_verified_at: str | None
    response_deadline_at: str
    closed_at: str | None
    closed_by: str | None
    resolution_note: str | None
    events: list[DSAREventOut]


class DSARSummary(BaseModel):
    open: int
    past_deadline: int
    due_soon: int
    by_type: dict[str, int] = Field(default_factory=dict)


class DSARListOut(BaseModel):
    tenant_id: str
    summary: DSARSummary
    entries: list[DSAROut]


class OpenDSARIn(BaseModel):
    request_type: str = Field(
        ...,
        description=(
            "access | erasure | rectification | restriction | "
            "portability | objection | opt_out_sale"
        ),
    )
    subject_name: str = Field(
        ...,
        min_length=dsar_mod.MIN_SUBJECT_LEN,
        max_length=dsar_mod.MAX_SUBJECT_LEN,
    )
    subject_email: str = Field(..., max_length=320)
    description: str = Field(
        ...,
        min_length=dsar_mod.MIN_DESC_LEN,
        max_length=dsar_mod.MAX_DESC_LEN,
    )
    received_via: str | None = Field(None, max_length=64)
    external_ref: str | None = Field(None, max_length=dsar_mod.MAX_REF_LEN)
    store_raw_contact: bool = False


class EventIn(BaseModel):
    kind: str = Field(
        ...,
        description=(
            "ack_sent | identity_verified | extension | "
            "data_package_generated | rejection | "
            "regulator_correspondence | note"
        ),
    )
    note: str = Field(..., min_length=1, max_length=dsar_mod.MAX_NOTE_LEN)


class CloseIn(BaseModel):
    status: str = Field(
        ...,
        description="fulfilled | rejected | withdrawn",
    )
    resolution_note: str | None = Field(
        None, max_length=dsar_mod.MAX_NOTE_LEN
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _to_out(v: dsar_mod.DSARView) -> DSAROut:
    return DSAROut(
        id=v.id,
        tenant_id=v.tenant_id,
        request_type=v.request_type,
        status=v.status,
        subject_name=v.subject_name,
        subject_email_hash=v.subject_email_hash,
        subject_email_redacted=v.subject_email_redacted,
        has_raw_contact=v.has_raw_contact,
        description=v.description,
        external_ref=v.external_ref,
        received_via=v.received_via,
        opened_by=v.opened_by,
        received_at=v.received_at,
        acknowledged_at=v.acknowledged_at,
        identity_verified_at=v.identity_verified_at,
        response_deadline_at=v.response_deadline_at,
        closed_at=v.closed_at,
        closed_by=v.closed_by,
        resolution_note=v.resolution_note,
        events=[
            DSAREventOut(
                id=e.id,
                request_id=e.request_id,
                kind=e.kind,
                author=e.author,
                note=e.note,
                created_at=e.created_at,
            )
            for e in v.events
        ],
    )


def _redacted_audit_target(view: dsar_mod.DSARView | None, name: str) -> str:
    if view is None:
        return name[:64]
    return f"{view.id}:{view.subject_email_hash[:12]}"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=DSARListOut)
def list_dsar(
    include_closed: bool = Query(True),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> DSARListOut:
    entries = dsar_mod.list_requests(
        tenant_id=tenant,
        include_closed=include_closed,
        limit=limit,
        offset=offset,
    )
    summary = dsar_mod.open_summary(tenant)
    return DSARListOut(
        tenant_id=tenant,
        summary=DSARSummary(**summary),
        entries=[_to_out(e) for e in entries],
    )


@router.get("/{request_id}", response_model=DSAROut)
def get_dsar(
    request_id: int,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> DSAROut:
    view = dsar_mod.get_request(tenant_id=tenant, request_id=request_id)
    if view is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="dsar request not found",
        )
    return _to_out(view)


@router.post("", status_code=201)
def open_dsar(
    body: OpenDSARIn,
    request: Request,
    dry_run: bool = Query(False),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    email_fp = dsar_mod.hash_email(tenant, str(body.subject_email))[:12]
    if dry_run:
        record_admin_action(
            action="workspace.dsar.open",
            principal=p,
            target=email_fp,
            details={
                "request_type": body.request_type,
                "received_via": body.received_via,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="open_dsar",
            tenant_id=tenant,
            request_type=body.request_type,
            subject_email_hash=dsar_mod.hash_email(
                tenant, str(body.subject_email)
            ),
            response_deadline_days=dsar_mod.RESPONSE_WINDOW_DAYS,
        )
    try:
        view = dsar_mod.open_request(
            tenant_id=tenant,
            request_type=body.request_type,
            subject_name=body.subject_name,
            subject_email=str(body.subject_email),
            description=body.description,
            opened_by=caller,
            received_via=body.received_via,
            external_ref=body.external_ref,
            store_raw_contact=body.store_raw_contact,
        )
    except dsar_mod.DSARError as exc:
        record_admin_action(
            action="workspace.dsar.open",
            principal=p,
            target=email_fp,
            details={"request_type": body.request_type},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.dsar.open",
        principal=p,
        target=_redacted_audit_target(view, body.subject_name),
        details={
            "request_type": view.request_type,
            "deadline": view.response_deadline_at,
            "received_via": view.received_via,
            "store_raw_contact": body.store_raw_contact,
        },
        request_id=_rid(request),
    )
    log.warning(
        "dsar_opened",
        tenant=tenant,
        request_id=view.id,
        type=view.request_type,
        deadline=view.response_deadline_at,
        http_request_id=_rid(request),
    )
    return _to_out(view)


@router.post(
    "/{request_id}/events",
    response_model=DSAROut,
    status_code=201,
)
def append_event(
    request_id: int,
    body: EventIn,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    try:
        view = dsar_mod.append_event(
            tenant_id=tenant,
            request_id=request_id,
            kind=body.kind,
            author=caller,
            note=body.note,
        )
    except dsar_mod.DSARError as exc:
        record_admin_action(
            action=f"workspace.dsar.event.{body.kind}",
            principal=p,
            target=str(request_id),
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
            action=f"workspace.dsar.event.{body.kind}",
            principal=p,
            target=str(request_id),
            details=None,
            ok=False,
            error="dsar request not found",
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="dsar request not found",
        )
    record_admin_action(
        action=f"workspace.dsar.event.{body.kind}",
        principal=p,
        target=_redacted_audit_target(view, str(request_id)),
        details={
            "status": view.status,
            "deadline": view.response_deadline_at,
        },
        request_id=_rid(request),
    )
    return _to_out(view)


@router.post("/{request_id}/close", response_model=DSAROut)
def close_dsar(
    request_id: int,
    body: CloseIn,
    request: Request,
    dry_run: bool = Query(False),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.dsar.close",
            principal=p,
            target=str(request_id),
            details={"status": body.status, "dry_run": True},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="close_dsar",
            tenant_id=tenant,
            request_id=request_id,
            status=body.status,
        )
    try:
        view = dsar_mod.close_request(
            tenant_id=tenant,
            request_id=request_id,
            status_in=body.status,
            closed_by=caller,
            resolution_note=body.resolution_note,
        )
    except dsar_mod.DSARError as exc:
        record_admin_action(
            action="workspace.dsar.close",
            principal=p,
            target=str(request_id),
            details={"status": body.status},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    if view is None:
        record_admin_action(
            action="workspace.dsar.close",
            principal=p,
            target=str(request_id),
            details=None,
            ok=False,
            error="dsar request not found",
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="dsar request not found",
        )
    record_admin_action(
        action="workspace.dsar.close",
        principal=p,
        target=_redacted_audit_target(view, str(request_id)),
        details={
            "status": view.status,
            "closed_at": view.closed_at,
        },
        request_id=_rid(request),
    )
    log.warning(
        "dsar_closed",
        tenant=tenant,
        request_id=view.id,
        status=view.status,
        http_request_id=_rid(request),
    )
    return _to_out(view)
