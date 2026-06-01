"""/v1/admin/legal-holds: per-tenant litigation / preservation holds.

While at least one hold is active for the caller's workspace, all
deletion paths refuse to run:

* ``DELETE /v1/users/{user_id}/data`` returns ``423 Locked`` with
  ``code: legal_hold_active``.
* ``POST   /v1/admin/retention-policy/sweep`` returns the same.

Placing or releasing a hold requires admin role *and* an active MFA
challenge, mirrors the pattern used for retention policy changes, and
writes both an admin audit row and a row in :class:`LegalHold` itself.

All operations are scoped strictly to the caller's tenant. There is
no cross-tenant read or write surface on this router. Cross-tenant
support access still has to go through the existing break-glass log.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import current_tenant, require_admin, require_viewer
from adherence_api.dry_run import dry_run_response
from adherence_api.routes.admin_mfa import require_admin_mfa
from adherence_common import legal_hold as lh_mod
from adherence_common import dual_control as dc_mod
from adherence_common.admin_audit import record_admin_action
from adherence_common.logging import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/v1/admin/legal-holds", tags=["legal-hold"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class LegalHoldOut(BaseModel):
    id: int
    tenant_id: str
    label: str | None
    reason: str
    ticket_ref: str | None
    placed_by: str
    placed_at: str
    released_by: str | None
    released_at: str | None
    release_reason: str | None
    active: bool


class LegalHoldListOut(BaseModel):
    tenant_id: str
    on_hold: bool
    active_count: int
    entries: list[LegalHoldOut]


class PlaceHoldIn(BaseModel):
    reason: str = Field(
        ...,
        min_length=lh_mod.MIN_REASON_LEN,
        max_length=lh_mod.MAX_REASON_LEN,
        description="Free-text justification recorded immutably.",
    )
    label: str | None = Field(None, max_length=lh_mod.MAX_LABEL_LEN)
    ticket_ref: str | None = Field(None, max_length=lh_mod.MAX_TICKET_LEN)


class ReleaseHoldIn(BaseModel):
    release_reason: str | None = Field(
        None,
        max_length=lh_mod.MAX_REASON_LEN,
        description=(
            "Optional note explaining why preservation is being lifted "
            "(e.g. 'matter SUP-4218 closed by counsel')."
        ),
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _to_out(v: lh_mod.LegalHoldView) -> LegalHoldOut:
    return LegalHoldOut(
        id=v.id,
        tenant_id=v.tenant_id,
        label=v.label,
        reason=v.reason,
        ticket_ref=v.ticket_ref,
        placed_by=v.placed_by,
        placed_at=v.placed_at,
        released_by=v.released_by,
        released_at=v.released_at,
        release_reason=v.release_reason,
        active=v.active,
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=LegalHoldListOut)
def list_holds(
    include_released: bool = Query(
        True, description="Include released (historical) holds."
    ),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> LegalHoldListOut:
    entries = lh_mod.list_holds(
        tenant_id=tenant,
        include_released=include_released,
        limit=limit,
        offset=offset,
    )
    active = sum(1 for e in entries if e.active)
    on_hold = lh_mod.is_on_hold(tenant)
    return LegalHoldListOut(
        tenant_id=tenant,
        on_hold=on_hold,
        active_count=active,
        entries=[_to_out(e) for e in entries],
    )


@router.post("", response_model=LegalHoldOut, status_code=201)
def place_hold(
    body: PlaceHoldIn,
    request: Request,
    dry_run: bool = Query(
        False,
        description=(
            "Preview without persisting the hold. Returns the would-be "
            "payload but does not freeze deletions."
        ),
    ),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.legal_hold.place",
            principal=p,
            target=tenant,
            details={
                "label": body.label,
                "ticket_ref": body.ticket_ref,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="place_legal_hold",
            tenant_id=tenant,
            label=body.label,
            ticket_ref=body.ticket_ref,
        )
    try:
        view = lh_mod.place_hold(
            tenant_id=tenant,
            reason=body.reason,
            placed_by=caller,
            label=body.label,
            ticket_ref=body.ticket_ref,
        )
    except lh_mod.LegalHoldError as exc:
        record_admin_action(
            action="workspace.legal_hold.place",
            principal=p,
            target=tenant,
            details={"label": body.label, "ticket_ref": body.ticket_ref},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.legal_hold.place",
        principal=p,
        target=tenant,
        details={
            "id": view.id,
            "label": view.label,
            "ticket_ref": view.ticket_ref,
        },
        request_id=_rid(request),
    )
    log.warning(
        "legal_hold_placed",
        tenant=tenant,
        hold_id=view.id,
        caller=caller,
        request_id=_rid(request),
    )
    return _to_out(view)


@router.post("/{hold_id}/release", response_model=LegalHoldOut)
def release_hold(
    hold_id: int,
    body: ReleaseHoldIn,
    request: Request,
    dry_run: bool = Query(
        False,
        description=(
            "Preview without releasing. Returns 404 if no active hold "
            "with that id exists for this workspace."
        ),
    ),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = lh_mod.get_hold(tenant_id=tenant, hold_id=hold_id)
    if existing is None:
        record_admin_action(
            action="workspace.legal_hold.release",
            principal=p,
            target=str(hold_id),
            details={"dry_run": dry_run},
            ok=False,
            error="hold not found",
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="hold not found"
        )
    if not existing.active:
        record_admin_action(
            action="workspace.legal_hold.release",
            principal=p,
            target=str(hold_id),
            details={"dry_run": dry_run},
            ok=False,
            error="hold already released",
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="hold already released",
        )
    if dry_run:
        record_admin_action(
            action="workspace.legal_hold.release",
            principal=p,
            target=str(hold_id),
            details={"dry_run": True, "release_reason": body.release_reason},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="release_legal_hold",
            tenant_id=tenant,
            hold_id=hold_id,
        )
    # Dual-control gate: if this workspace requires four-eyes on
    # legal-hold releases, a second admin must have approved a
    # request whose payload hash matches exactly. Otherwise this
    # branch is a no-op and the action proceeds in single-control.
    approval = None
    payload_for_approval = {
        "hold_id": int(hold_id),
        "release_reason": body.release_reason,
    }
    try:
        approval = dc_mod.ensure_approved(
            tenant_id=tenant,
            action_type="legal_hold.release",
            payload=payload_for_approval,
            principal_id=caller,
        )
    except dc_mod.DualControlError as exc:
        record_admin_action(
            action="workspace.legal_hold.release",
            principal=p,
            target=str(hold_id),
            details={
                "reason": str(exc),
                "required_payload_hash": dc_mod.compute_payload_hash(
                    payload_for_approval
                ),
            },
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_428_PRECONDITION_REQUIRED,
            detail={
                "code": "dual_control_required",
                "action_type": "legal_hold.release",
                "payload_hash": dc_mod.compute_payload_hash(
                    payload_for_approval
                ),
                "reason": str(exc),
            },
        ) from exc
    view = lh_mod.release_hold(
        tenant_id=tenant,
        hold_id=hold_id,
        released_by=caller,
        release_reason=body.release_reason,
    )
    if view is None:
        # Race: someone else released between our read and write.
        record_admin_action(
            action="workspace.legal_hold.release",
            principal=p,
            target=str(hold_id),
            ok=False,
            error="hold not found or already released",
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="hold not found or already released",
        )
    record_admin_action(
        action="workspace.legal_hold.release",
        principal=p,
        target=str(hold_id),
        details={
            "release_reason": body.release_reason,
            "dual_control_request_id": (approval.id if approval else None),
        },
        request_id=_rid(request),
    )
    if approval is not None:
        try:
            dc_mod.mark_executed(
                tenant_id=tenant, request_id=approval.id
            )
        except Exception as exc:  # pragma: no cover - defensive
            log.warning(
                "dual_control_mark_executed_failed",
                tenant=tenant,
                request_id=approval.id,
                error=str(exc),
            )
    log.warning(
        "legal_hold_released",
        tenant=tenant,
        hold_id=hold_id,
        caller=caller,
        request_id=_rid(request),
    )
    return _to_out(view)
