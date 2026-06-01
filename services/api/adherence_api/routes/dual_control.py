"""/v1/admin/dual-control: per-tenant sensitive-action approval workflow.

Each workspace opts specific ``action_type`` strings into dual
control via the policy sub-resource. Once gated, the route handler
for that action must call :func:`adherence_common.dual_control.ensure_approved`
before executing; if the policy is in effect and no matching
approval covers the request payload, the call raises and the route
returns HTTP 428 ``dual_control_required``.

Workspace owners (admins) can:

* List, create, and remove dual-control policy entries.
* Open new approval requests (the requester).
* Approve or reject pending requests (the second admin). Self
  approval is rejected by the model layer.
* Cancel their own pending requests.
* Inspect every historical request for the workspace.

Strictly tenant scoped. There is no fleet-wide read or write on this
router; cross-tenant access goes through the existing break-glass
log like every other admin surface.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import current_tenant, require_admin, require_viewer
from adherence_api.dry_run import dry_run_response
from adherence_api.routes.admin_mfa import require_admin_mfa
from adherence_common import dual_control as dc
from adherence_common.admin_audit import record_admin_action
from adherence_common.logging import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/v1/admin/dual-control", tags=["dual-control"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class PolicyOut(BaseModel):
    id: int
    tenant_id: str
    action_type: str
    description: str | None
    ttl_seconds: int
    created_by: str
    created_at: str


class PolicyListOut(BaseModel):
    tenant_id: str
    entries: list[PolicyOut]


class PolicyIn(BaseModel):
    action_type: str = Field(..., min_length=1, max_length=dc.MAX_ACTION_TYPE_LEN)
    description: str | None = Field(None, max_length=dc.MAX_REASON_LEN)
    ttl_seconds: int | None = Field(
        None,
        ge=dc.MIN_TTL_SECONDS,
        le=dc.MAX_TTL_SECONDS,
        description=(
            "How long a pending request stays open before it auto-expires. "
            f"Default {dc.DEFAULT_TTL_SECONDS // 3600} hours."
        ),
    )


class RequestOut(BaseModel):
    id: int
    tenant_id: str
    action_type: str
    payload_hash: str
    payload: Any | None
    summary: str | None
    reason: str
    status: str
    requested_by: str
    requested_at: str
    expires_at: str
    decided_by: str | None
    decided_at: str | None
    decision_reason: str | None
    executed_at: str | None
    expired: bool


class RequestListOut(BaseModel):
    tenant_id: str
    pending_count: int
    entries: list[RequestOut]


class RequestIn(BaseModel):
    action_type: str = Field(..., min_length=1, max_length=dc.MAX_ACTION_TYPE_LEN)
    payload: Any = Field(..., description="Exact payload the action will receive.")
    reason: str = Field(
        ...,
        min_length=dc.MIN_REASON_LEN,
        max_length=dc.MAX_REASON_LEN,
    )
    summary: str | None = Field(None, max_length=256)
    ttl_seconds: int | None = Field(
        None, ge=dc.MIN_TTL_SECONDS, le=dc.MAX_TTL_SECONDS
    )


class DecisionIn(BaseModel):
    decision_reason: str | None = Field(None, max_length=dc.MAX_REASON_LEN)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _principal_id(p: dict[str, Any]) -> str:
    return str(p.get("sub") or p.get("key_name") or "unknown")


def _policy_to_out(v: dc.DualControlPolicyView) -> PolicyOut:
    return PolicyOut(
        id=v.id,
        tenant_id=v.tenant_id,
        action_type=v.action_type,
        description=v.description,
        ttl_seconds=v.ttl_seconds,
        created_by=v.created_by,
        created_at=v.created_at,
    )


def _request_to_out(v: dc.DualControlRequestView) -> RequestOut:
    return RequestOut(
        id=v.id,
        tenant_id=v.tenant_id,
        action_type=v.action_type,
        payload_hash=v.payload_hash,
        payload=v.payload,
        summary=v.summary,
        reason=v.reason,
        status=v.status,
        requested_by=v.requested_by,
        requested_at=v.requested_at,
        expires_at=v.expires_at,
        decided_by=v.decided_by,
        decided_at=v.decided_at,
        decision_reason=v.decision_reason,
        executed_at=v.executed_at,
        expired=v.expired,
    )


# ---------------------------------------------------------------------------
# Policy routes
# ---------------------------------------------------------------------------


@router.get("/policy", response_model=PolicyListOut)
def list_policy(
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> PolicyListOut:
    entries = [_policy_to_out(v) for v in dc.list_policies(tenant_id=tenant)]
    return PolicyListOut(tenant_id=tenant, entries=entries)


@router.put("/policy", response_model=PolicyOut)
def upsert_policy(
    body: PolicyIn,
    request: Request,
    dry_run: bool = Query(False, description="Preview without persisting."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = _principal_id(p)
    if dry_run:
        record_admin_action(
            action="workspace.dual_control.policy.set",
            principal=p,
            target=tenant,
            details={
                "action_type": body.action_type,
                "ttl_seconds": body.ttl_seconds,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="set_dual_control_policy",
            tenant_id=tenant,
            action_type=body.action_type,
            ttl_seconds=body.ttl_seconds,
        )
    try:
        view = dc.set_policy(
            tenant_id=tenant,
            action_type=body.action_type,
            created_by=caller,
            description=body.description,
            ttl_seconds=body.ttl_seconds,
        )
    except dc.DualControlError as exc:
        record_admin_action(
            action="workspace.dual_control.policy.set",
            principal=p,
            target=tenant,
            details={"action_type": body.action_type},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.dual_control.policy.set",
        principal=p,
        target=tenant,
        details={
            "id": view.id,
            "action_type": view.action_type,
            "ttl_seconds": view.ttl_seconds,
        },
        request_id=_rid(request),
    )
    return _policy_to_out(view)


@router.delete("/policy/{action_type}", status_code=204)
def delete_policy(
    action_type: str,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    try:
        removed = dc.clear_policy(tenant_id=tenant, action_type=action_type)
    except dc.DualControlError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.dual_control.policy.clear",
        principal=p,
        target=tenant,
        details={"action_type": action_type, "removed": removed},
        ok=removed,
        request_id=_rid(request),
    )
    if not removed:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="policy not found"
        )
    return None


# ---------------------------------------------------------------------------
# Request routes
# ---------------------------------------------------------------------------


@router.get("", response_model=RequestListOut)
def list_requests(
    statuses: list[str] | None = Query(
        None,
        description="Filter by status. Multiple ?statuses= allowed.",
    ),
    action_type: str | None = Query(None),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> RequestListOut:
    entries = [
        _request_to_out(v)
        for v in dc.list_requests(
            tenant_id=tenant,
            statuses=statuses,
            action_type=action_type,
            limit=limit,
            offset=offset,
        )
    ]
    return RequestListOut(
        tenant_id=tenant,
        pending_count=dc.pending_count(tenant_id=tenant),
        entries=entries,
    )


@router.get("/{request_id}", response_model=RequestOut)
def get_request(
    request_id: int,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> RequestOut:
    view = dc.get_request(tenant_id=tenant, request_id=request_id)
    if view is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="request not found"
        )
    return _request_to_out(view)


@router.post("", response_model=RequestOut, status_code=201)
def open_request(
    body: RequestIn,
    request: Request,
    dry_run: bool = Query(False, description="Preview without persisting."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = _principal_id(p)
    if dry_run:
        record_admin_action(
            action="workspace.dual_control.request.open",
            principal=p,
            target=tenant,
            details={
                "action_type": body.action_type,
                "summary": body.summary,
                "payload_hash": dc.compute_payload_hash(body.payload),
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="open_dual_control_request",
            tenant_id=tenant,
            action_type=body.action_type,
            payload_hash=dc.compute_payload_hash(body.payload),
        )
    try:
        view = dc.create_request(
            tenant_id=tenant,
            action_type=body.action_type,
            payload=body.payload,
            reason=body.reason,
            requested_by=caller,
            summary=body.summary,
            ttl_seconds=body.ttl_seconds,
        )
    except dc.DualControlError as exc:
        record_admin_action(
            action="workspace.dual_control.request.open",
            principal=p,
            target=tenant,
            details={"action_type": body.action_type},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.dual_control.request.open",
        principal=p,
        target=tenant,
        details={
            "id": view.id,
            "action_type": view.action_type,
            "payload_hash": view.payload_hash,
            "expires_at": view.expires_at,
        },
        request_id=_rid(request),
    )
    log.warning(
        "dual_control_request_opened",
        tenant=tenant,
        request_id=view.id,
        action_type=view.action_type,
        caller=caller,
    )
    return _request_to_out(view)


@router.post("/{request_id}/approve", response_model=RequestOut)
def approve_request(
    request_id: int,
    body: DecisionIn,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = _principal_id(p)
    try:
        view = dc.approve_request(
            tenant_id=tenant,
            request_id=request_id,
            approver=caller,
            decision_reason=body.decision_reason,
        )
    except dc.DualControlError as exc:
        record_admin_action(
            action="workspace.dual_control.request.approve",
            principal=p,
            target=str(request_id),
            details={"reason": str(exc)},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.dual_control.request.approve",
        principal=p,
        target=str(request_id),
        details={
            "action_type": view.action_type,
            "payload_hash": view.payload_hash,
        },
        request_id=_rid(request),
    )
    log.warning(
        "dual_control_request_approved",
        tenant=tenant,
        request_id=view.id,
        approver=caller,
    )
    return _request_to_out(view)


@router.post("/{request_id}/reject", response_model=RequestOut)
def reject_request(
    request_id: int,
    body: DecisionIn,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = _principal_id(p)
    try:
        view = dc.reject_request(
            tenant_id=tenant,
            request_id=request_id,
            approver=caller,
            decision_reason=body.decision_reason,
        )
    except dc.DualControlError as exc:
        record_admin_action(
            action="workspace.dual_control.request.reject",
            principal=p,
            target=str(request_id),
            details={"reason": str(exc)},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.dual_control.request.reject",
        principal=p,
        target=str(request_id),
        details={"action_type": view.action_type},
        request_id=_rid(request),
    )
    return _request_to_out(view)


@router.post("/{request_id}/cancel", response_model=RequestOut)
def cancel_request(
    request_id: int,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
):
    caller = _principal_id(p)
    try:
        view = dc.cancel_request(
            tenant_id=tenant,
            request_id=request_id,
            canceller=caller,
        )
    except dc.DualControlError as exc:
        record_admin_action(
            action="workspace.dual_control.request.cancel",
            principal=p,
            target=str(request_id),
            details={"reason": str(exc)},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.dual_control.request.cancel",
        principal=p,
        target=str(request_id),
        details={"action_type": view.action_type},
        request_id=_rid(request),
    )
    return _request_to_out(view)
