"""Per-workspace API-key lifetime policy endpoints.

Lets a workspace admin force every API key issued (or rotated with a
fresh TTL) inside the tenant to declare an expiry, capped at a
configurable maximum. This is the deal-blocker request from
procurement teams that demand a documented key-rotation cadence; the
backend rejects ``api_key.create`` and ``api_key.rotate`` calls that
would violate the policy and writes an admin-audit row showing the
attempt.

Endpoints (admin-only, MFA-gated, audit-logged, dry-run aware):

* ``GET    /v1/workspace/api-key-policy`` view current tenant policy
* ``PUT    /v1/workspace/api-key-policy`` set or update the cap
* ``DELETE /v1/workspace/api-key-policy`` clear the cap
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
from adherence_common.api_key_policy import (
    MAX_MAX_TTL_SECONDS,
    MIN_MAX_TTL_SECONDS,
    clear_policy,
    get_policy,
    set_policy,
)

router = APIRouter(prefix="/v1/workspace/api-key-policy", tags=["workspace"])


def _rid(request: Request) -> Optional[str]:
    return getattr(request.state, "request_id", None)


class PolicyOut(BaseModel):
    tenant_id: str
    max_ttl_seconds: Optional[int] = Field(
        None,
        description=(
            "None when no per-tenant policy is set. When present, every "
            "api_key.create / api_key.rotate in this tenant must request "
            "a ttl_seconds at most this large."
        ),
    )
    require_expiry: bool = Field(
        False,
        description=(
            "When true the tenant forbids non-expiring keys; "
            "ttl_seconds must be supplied on create."
        ),
    )
    updated_at: Optional[int] = None
    updated_by: Optional[str] = None
    min_allowed_seconds: int = MIN_MAX_TTL_SECONDS
    max_allowed_seconds: int = MAX_MAX_TTL_SECONDS


class PolicyIn(BaseModel):
    max_ttl_seconds: int = Field(
        ...,
        ge=MIN_MAX_TTL_SECONDS,
        le=MAX_MAX_TTL_SECONDS,
        description=(
            f"Maximum TTL any new or rotated key may carry, in seconds. "
            f"Allowed range [{MIN_MAX_TTL_SECONDS}, {MAX_MAX_TTL_SECONDS}]."
        ),
    )
    require_expiry: bool = Field(
        True,
        description=(
            "When true (the default) non-expiring keys are rejected. "
            "Set to false to allow open-ended keys while still capping "
            "those that do declare an expiry."
        ),
    )


def _view(tenant_id: str) -> PolicyOut:
    pv = get_policy(tenant_id)
    if pv is None:
        return PolicyOut(tenant_id=tenant_id)
    return PolicyOut(
        tenant_id=pv.tenant_id,
        max_ttl_seconds=pv.max_ttl_seconds,
        require_expiry=pv.require_expiry,
        updated_at=pv.updated_at,
        updated_by=pv.updated_by,
    )


@router.get("", response_model=PolicyOut)
def read_policy(
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> PolicyOut:
    return _view(tenant)


@router.put("", response_model=PolicyOut)
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
            action="workspace.api_key_policy.set",
            principal=p,
            target=tenant,
            details={
                "max_ttl_seconds": body.max_ttl_seconds,
                "require_expiry": body.require_expiry,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return JSONResponse(  # type: ignore[return-value]
            dry_run_response(
                would="set",
                tenant_id=tenant,
                max_ttl_seconds=body.max_ttl_seconds,
                require_expiry=body.require_expiry,
            )
        )
    try:
        pv = set_policy(
            tenant,
            max_ttl_seconds=body.max_ttl_seconds,
            require_expiry=body.require_expiry,
            updated_by=caller,
        )
    except ValueError as exc:
        record_admin_action(
            action="workspace.api_key_policy.set",
            principal=p,
            target=tenant,
            details={
                "max_ttl_seconds": body.max_ttl_seconds,
                "require_expiry": body.require_expiry,
            },
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.api_key_policy.set",
        principal=p,
        target=tenant,
        details={
            "max_ttl_seconds": pv.max_ttl_seconds,
            "require_expiry": pv.require_expiry,
        },
        request_id=_rid(request),
    )
    return PolicyOut(
        tenant_id=pv.tenant_id,
        max_ttl_seconds=pv.max_ttl_seconds,
        require_expiry=pv.require_expiry,
        updated_at=pv.updated_at,
        updated_by=pv.updated_by,
    )


@router.delete("", response_model=PolicyOut)
def delete_policy(
    request: Request,
    dry_run: bool = False,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
) -> PolicyOut:
    if dry_run:
        record_admin_action(
            action="workspace.api_key_policy.clear",
            principal=p,
            target=tenant,
            details={"dry_run": True},
            request_id=_rid(request),
        )
        return JSONResponse(  # type: ignore[return-value]
            dry_run_response(would="clear", tenant_id=tenant)
        )
    removed = clear_policy(tenant)
    record_admin_action(
        action="workspace.api_key_policy.clear",
        principal=p,
        target=tenant,
        details={"removed": bool(removed)},
        request_id=_rid(request),
    )
    return _view(tenant)
