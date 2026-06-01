"""Per-workspace model approval policy endpoints.

Lets a workspace owner / admin define which ``(model_name,
model_version)`` pairs are approved for production scoring under this
tenant, and the enforcement mode that should apply when a request
asks for something else.

Endpoints (admin-only, MFA-gated, audit-logged, dry-run aware):

* ``GET    /v1/workspace/model-approval`` view current mode + counts
* ``PUT    /v1/workspace/model-approval`` set the enforcement mode
* ``GET    /v1/workspace/model-approval/versions`` list approved versions
* ``POST   /v1/workspace/model-approval/versions`` approve a version
* ``DELETE /v1/workspace/model-approval/versions/{model_name}/{model_version}``
  revoke approval

Strict tenant scoping: every read and write filters by the caller's
tenant. One workspace can never approve a version on behalf of another.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from adherence_api.deps import (
    current_tenant,
    require_admin,
    require_viewer,
)
from adherence_api.dry_run import dry_run_response
from adherence_api.routes.admin_mfa import require_admin_mfa
from adherence_common.admin_audit import record_admin_action
from adherence_common.model_approval import (
    ALLOWED_MODES,
    DEFAULT_MODE,
    MAX_APPROVED_VERSIONS_PER_TENANT,
    approve as approve_version,
    get_mode,
    list_approved,
    revoke as revoke_version,
    set_mode,
)

router = APIRouter(prefix="/v1/workspace/model-approval", tags=["workspace"])


_ALLOWED_SORTED = sorted(ALLOWED_MODES)


def _rid(request: Request) -> Optional[str]:
    return getattr(request.state, "request_id", None)


class ModeOut(BaseModel):
    tenant_id: str
    mode: str = Field(
        ...,
        description=(
            "Enforcement mode. 'disabled' lets any registered version "
            "score; 'audit' lets them through but records unapproved "
            "calls; 'enforce' returns HTTP 422 for any version not on "
            "the approved list."
        ),
    )
    pinned: bool = Field(
        ..., description="True when this workspace has set a mode explicitly."
    )
    updated_at: Optional[int] = None
    updated_by: Optional[str] = None
    default_mode: str = DEFAULT_MODE
    allowed_modes: list[str] = Field(default_factory=lambda: list(_ALLOWED_SORTED))
    approved_versions: int = 0
    max_approved_versions: int = MAX_APPROVED_VERSIONS_PER_TENANT


class ModeIn(BaseModel):
    mode: str = Field(
        ...,
        description=f"Target mode. Allowed values: {', '.join(_ALLOWED_SORTED)}.",
    )


class ApprovedVersionOut(BaseModel):
    id: int
    tenant_id: str
    model_name: str
    model_version: str
    approved_at: int
    approved_by: Optional[str]
    note: Optional[str]


class ApprovedListOut(BaseModel):
    tenant_id: str
    n: int
    items: list[ApprovedVersionOut]


class ApproveIn(BaseModel):
    model_name: str = Field(..., min_length=1, max_length=128)
    model_version: str = Field(..., min_length=1, max_length=64)
    note: Optional[str] = Field(
        None, max_length=4096,
        description="Optional change-ticket reference or justification.",
    )


def _principal_id(p: dict) -> str:
    return str(p.get("sub") or p.get("key_name") or "unknown")[:128]


def _mode_view(tenant_id: str) -> ModeOut:
    mv = get_mode(tenant_id)
    items = list_approved(tenant_id)
    return ModeOut(
        tenant_id=tenant_id,
        mode=mv.mode,
        pinned=mv.pinned,
        updated_at=mv.updated_at,
        updated_by=mv.updated_by,
        approved_versions=len(items),
    )


@router.get("", response_model=ModeOut)
def read_mode(
    _p=Depends(require_viewer),
    tenant_id: str = Depends(current_tenant),
) -> ModeOut:
    return _mode_view(tenant_id)


@router.put("", response_model=ModeOut)
def write_mode(
    body: ModeIn,
    request: Request,
    dry_run: bool = False,
    p=Depends(require_admin_mfa),
    tenant_id: str = Depends(current_tenant),
):
    target_mode = str(body.mode or "").strip().lower()
    if target_mode not in ALLOWED_MODES:
        record_admin_action(
            action="workspace.model_approval.mode.set",
            principal=p, target=tenant_id,
            details={"mode": body.mode, "ok": False},
            ok=False, error="invalid mode",
            request_id=_rid(request), tenant_id=tenant_id,
        )
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"mode must be one of: {', '.join(_ALLOWED_SORTED)}",
        )
    current = get_mode(tenant_id)
    if dry_run:
        record_admin_action(
            action="workspace.model_approval.mode.set",
            principal=p, target=tenant_id,
            details={"dry_run": True, "from": current.mode, "to": target_mode},
            request_id=_rid(request), tenant_id=tenant_id,
        )
        body_out = dry_run_response(
            would="set_mode", tenant_id=tenant_id,
            from_mode=current.mode, to_mode=target_mode,
        )
        return JSONResponse(body_out)
    try:
        set_mode(tenant_id, mode=target_mode, updated_by=_principal_id(p))
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc))
    record_admin_action(
        action="workspace.model_approval.mode.set",
        principal=p, target=tenant_id,
        details={"from": current.mode, "to": target_mode},
        request_id=_rid(request), tenant_id=tenant_id,
    )
    return _mode_view(tenant_id)


@router.get("/versions", response_model=ApprovedListOut)
def list_versions(
    _p=Depends(require_viewer),
    tenant_id: str = Depends(current_tenant),
) -> ApprovedListOut:
    items = list_approved(tenant_id)
    return ApprovedListOut(
        tenant_id=tenant_id,
        n=len(items),
        items=[
            ApprovedVersionOut(
                id=v.id, tenant_id=v.tenant_id,
                model_name=v.model_name, model_version=v.model_version,
                approved_at=v.approved_at, approved_by=v.approved_by,
                note=v.note,
            )
            for v in items
        ],
    )


@router.post("/versions", response_model=ApprovedVersionOut)
def approve_version_route(
    body: ApproveIn,
    request: Request,
    dry_run: bool = False,
    p=Depends(require_admin_mfa),
    tenant_id: str = Depends(current_tenant),
):
    if dry_run:
        record_admin_action(
            action="workspace.model_approval.version.approve",
            principal=p,
            target=f"{tenant_id}:{body.model_name}@{body.model_version}",
            details={"dry_run": True, "note": body.note},
            request_id=_rid(request), tenant_id=tenant_id,
        )
        return JSONResponse(dry_run_response(
            would="approve_version", tenant_id=tenant_id,
            model_name=body.model_name, model_version=body.model_version,
        ))
    try:
        v = approve_version(
            tenant_id,
            model_name=body.model_name,
            model_version=body.model_version,
            approved_by=_principal_id(p),
            note=body.note,
        )
    except ValueError as exc:
        record_admin_action(
            action="workspace.model_approval.version.approve",
            principal=p,
            target=f"{tenant_id}:{body.model_name}@{body.model_version}",
            ok=False, error=str(exc),
            request_id=_rid(request), tenant_id=tenant_id,
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc))
    record_admin_action(
        action="workspace.model_approval.version.approve",
        principal=p,
        target=f"{tenant_id}:{body.model_name}@{body.model_version}",
        details={"note": body.note},
        request_id=_rid(request), tenant_id=tenant_id,
    )
    return ApprovedVersionOut(
        id=v.id, tenant_id=v.tenant_id,
        model_name=v.model_name, model_version=v.model_version,
        approved_at=v.approved_at, approved_by=v.approved_by,
        note=v.note,
    )


@router.delete("/versions/{model_name}/{model_version}")
def revoke_version_route(
    model_name: str,
    model_version: str,
    request: Request,
    dry_run: bool = False,
    p=Depends(require_admin_mfa),
    tenant_id: str = Depends(current_tenant),
):
    target = f"{tenant_id}:{model_name}@{model_version}"
    if dry_run:
        # 404 still applies for dry-run on missing target so callers can
        # see they would 404 without us pretending the row exists.
        from adherence_common.model_approval import is_approved
        if not is_approved(
            tenant_id, model_name=model_name, model_version=model_version,
        ):
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                detail="approved version not found",
            )
        record_admin_action(
            action="workspace.model_approval.version.revoke",
            principal=p, target=target,
            details={"dry_run": True},
            request_id=_rid(request), tenant_id=tenant_id,
        )
        return JSONResponse(dry_run_response(
            would="revoke_version", tenant_id=tenant_id,
            model_name=model_name, model_version=model_version,
        ))
    removed = revoke_version(
        tenant_id, model_name=model_name, model_version=model_version,
    )
    if not removed:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="approved version not found",
        )
    record_admin_action(
        action="workspace.model_approval.version.revoke",
        principal=p, target=target,
        request_id=_rid(request), tenant_id=tenant_id,
    )
    return {"revoked": True, "tenant_id": tenant_id,
            "model_name": model_name, "model_version": model_version}
