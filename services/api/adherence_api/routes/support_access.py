"""Per-workspace vendor support access endpoints.

A tenant owner can flip their workspace into "lock-down" mode so that
no vendor admin may cross the tenant boundary without first being
issued a time-bound grant. The break-glass justification header is
still required on every cross-tenant call; this layer adds an explicit
prior authorisation step on top.

Endpoints (admin-only, MFA-gated, audit-logged, dry-run aware):

* ``GET    /v1/workspace/support-access/policy``               view policy
* ``PUT    /v1/workspace/support-access/policy``               set ``require_grant``
* ``GET    /v1/workspace/support-access/grants``               list grants
* ``POST   /v1/workspace/support-access/grants``               create a grant
* ``POST   /v1/workspace/support-access/grants/{id}/revoke``   revoke one
"""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from adherence_api.deps import current_tenant, require_admin, require_viewer
from adherence_api.dry_run import dry_run_response
from adherence_api.routes.admin_mfa import require_admin_mfa
from adherence_common.admin_audit import record_admin_action
from adherence_common import support_access as sa

router = APIRouter(
    prefix="/v1/workspace/support-access",
    tags=["workspace"],
)


def _rid(request: Request) -> Optional[str]:
    return getattr(request.state, "request_id", None)


class PolicyOut(BaseModel):
    tenant_id: str
    require_grant: bool = False
    updated_at: Optional[int] = None
    updated_by: Optional[str] = None
    min_ttl_seconds: int = sa.MIN_TTL_SECONDS
    max_ttl_seconds: int = sa.MAX_TTL_SECONDS
    default_ttl_seconds: int = sa.DEFAULT_TTL_SECONDS


class PolicyIn(BaseModel):
    require_grant: bool


class GrantOut(BaseModel):
    id: int
    public_id: str
    tenant_id: str
    grantee_sub: Optional[str] = None
    reason: str
    granted_by: str
    granted_at: int
    expires_at: int
    revoked_at: Optional[int] = None
    revoked_by: Optional[str] = None
    last_used_at: Optional[int] = None
    use_count: int = 0
    is_active: bool


class GrantListOut(BaseModel):
    tenant_id: str
    grants: List[GrantOut]
    include_inactive: bool = False


class GrantIn(BaseModel):
    reason: str = Field(..., min_length=10, max_length=1000)
    ttl_seconds: int = Field(
        default=sa.DEFAULT_TTL_SECONDS,
        ge=sa.MIN_TTL_SECONDS,
        le=sa.MAX_TTL_SECONDS,
    )
    grantee_sub: Optional[str] = Field(
        default=None,
        max_length=128,
        description=(
            "Principal subject the grant binds to (for example 'api-key:vendor-support'). "
            "Leave blank to allow any vendor admin."
        ),
    )


def _to_grant_out(v: sa.GrantView) -> GrantOut:
    return GrantOut(
        id=v.id,
        public_id=v.public_id,
        tenant_id=v.tenant_id,
        grantee_sub=v.grantee_sub,
        reason=v.reason,
        granted_by=v.granted_by,
        granted_at=v.granted_at,
        expires_at=v.expires_at,
        revoked_at=v.revoked_at,
        revoked_by=v.revoked_by,
        last_used_at=v.last_used_at,
        use_count=v.use_count,
        is_active=v.is_active,
    )


def _policy_view(tenant_id: str) -> PolicyOut:
    pv = sa.get_policy(tenant_id)
    if pv is None:
        return PolicyOut(tenant_id=tenant_id)
    return PolicyOut(
        tenant_id=pv.tenant_id,
        require_grant=pv.require_grant,
        updated_at=pv.updated_at,
        updated_by=pv.updated_by,
    )


# ---------- policy ----------


@router.get("/policy", response_model=PolicyOut)
def read_policy(
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> PolicyOut:
    return _policy_view(tenant)


@router.put("/policy", response_model=PolicyOut)
def write_policy(
    body: PolicyIn,
    request: Request,
    dry_run: bool = False,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
) -> PolicyOut:
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.support_access.policy.set",
            principal=p,
            target=tenant,
            details={"require_grant": body.require_grant, "dry_run": True},
            request_id=_rid(request),
        )
        return JSONResponse(  # type: ignore[return-value]
            dry_run_response(
                would="set",
                tenant_id=tenant,
                require_grant=body.require_grant,
            )
        )
    pv = sa.set_policy(
        tenant,
        require_grant=body.require_grant,
        updated_by=caller,
    )
    record_admin_action(
        action="workspace.support_access.policy.set",
        principal=p,
        target=tenant,
        details={"require_grant": pv.require_grant},
        request_id=_rid(request),
    )
    return PolicyOut(
        tenant_id=pv.tenant_id,
        require_grant=pv.require_grant,
        updated_at=pv.updated_at,
        updated_by=pv.updated_by,
    )


# ---------- grants ----------


@router.get("/grants", response_model=GrantListOut)
def list_grants(
    include_inactive: bool = False,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> GrantListOut:
    rows = sa.list_grants(tenant, include_inactive=include_inactive)
    return GrantListOut(
        tenant_id=tenant,
        grants=[_to_grant_out(r) for r in rows],
        include_inactive=include_inactive,
    )


@router.post("/grants", response_model=GrantOut, status_code=201)
def create_grant(
    body: GrantIn,
    request: Request,
    dry_run: bool = False,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
) -> GrantOut:
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.support_access.grant.create",
            principal=p,
            target=tenant,
            details={
                "ttl_seconds": body.ttl_seconds,
                "grantee_sub": body.grantee_sub or "",
                "reason_preview": body.reason[:80],
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return JSONResponse(  # type: ignore[return-value]
            dry_run_response(
                would="create",
                tenant_id=tenant,
                ttl_seconds=body.ttl_seconds,
                grantee_sub=body.grantee_sub,
            )
        )
    try:
        gv = sa.create_grant(
            tenant,
            granted_by=caller,
            reason=body.reason,
            ttl_seconds=body.ttl_seconds,
            grantee_sub=body.grantee_sub,
        )
    except ValueError as exc:
        record_admin_action(
            action="workspace.support_access.grant.create",
            principal=p,
            target=tenant,
            details={"ttl_seconds": body.ttl_seconds},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.support_access.grant.create",
        principal=p,
        target=tenant,
        details={
            "public_id": gv.public_id,
            "ttl_seconds": body.ttl_seconds,
            "grantee_sub": gv.grantee_sub or "",
            "expires_at": gv.expires_at,
        },
        request_id=_rid(request),
    )
    return _to_grant_out(gv)


@router.post("/grants/{public_id}/revoke", response_model=GrantOut)
def revoke_grant(
    public_id: str,
    request: Request,
    dry_run: bool = False,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
) -> GrantOut:
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.support_access.grant.revoke",
            principal=p,
            target=tenant,
            details={"public_id": public_id, "dry_run": True},
            request_id=_rid(request),
        )
        return JSONResponse(  # type: ignore[return-value]
            dry_run_response(
                would="revoke", tenant_id=tenant, public_id=public_id
            )
        )
    gv = sa.revoke_grant(tenant, public_id, revoked_by=caller)
    if gv is None:
        record_admin_action(
            action="workspace.support_access.grant.revoke",
            principal=p,
            target=tenant,
            details={"public_id": public_id},
            ok=False,
            error="not_found",
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="grant not found"
        )
    record_admin_action(
        action="workspace.support_access.grant.revoke",
        principal=p,
        target=tenant,
        details={"public_id": gv.public_id, "revoked_at": gv.revoked_at},
        request_id=_rid(request),
    )
    return _to_grant_out(gv)
