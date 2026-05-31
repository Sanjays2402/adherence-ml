"""Per-workspace session max-age policy endpoints.

Lets a workspace admin cap how long a JWT session is honoured inside
their tenant, independent of the global ``jwt_ttl_seconds``. Regulated
verticals (healthcare, finance) routinely require an idle/absolute cap
that the global setting can't satisfy because it applies across all
tenants.

Wired into :func:`adherence_common.auth.verify_jwt` via
:func:`adherence_common.session_policy.enforce_session_age`, so every
authenticated request feels the policy without per-route changes.

Endpoints (admin-only, MFA-gated, audit-logged, dry-run aware):

* ``GET    /v1/workspace/session-policy`` view current tenant policy
* ``PUT    /v1/workspace/session-policy`` set or update the cap
* ``DELETE /v1/workspace/session-policy`` clear the cap (fall back to global)
"""
from __future__ import annotations

from datetime import datetime, timezone
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
from adherence_common.session_policy import (
    MAX_MAX_AGE_SECONDS,
    MIN_MAX_AGE_SECONDS,
    clear_policy,
    get_policy,
    set_policy,
)

router = APIRouter(prefix="/v1/workspace/session-policy", tags=["workspace"])


def _rid(request: Request) -> Optional[str]:
    return getattr(request.state, "request_id", None)


class PolicyOut(BaseModel):
    tenant_id: str
    max_age_seconds: Optional[int] = Field(
        None,
        description="None when the tenant uses the global jwt_ttl_seconds.",
    )
    updated_at: Optional[int] = None
    updated_by: Optional[str] = None
    min_allowed_seconds: int = MIN_MAX_AGE_SECONDS
    max_allowed_seconds: int = MAX_MAX_AGE_SECONDS


class PolicyIn(BaseModel):
    max_age_seconds: int = Field(
        ...,
        ge=MIN_MAX_AGE_SECONDS,
        le=MAX_MAX_AGE_SECONDS,
        description=(
            f"Cap in seconds; allowed range "
            f"[{MIN_MAX_AGE_SECONDS}, {MAX_MAX_AGE_SECONDS}]."
        ),
    )


def _view(tenant_id: str) -> PolicyOut:
    pv = get_policy(tenant_id)
    if pv is None:
        return PolicyOut(tenant_id=tenant_id)
    return PolicyOut(
        tenant_id=pv.tenant_id,
        max_age_seconds=pv.max_age_seconds,
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
            action="workspace.session_policy.set",
            principal=p,
            target=tenant,
            details={
                "max_age_seconds": body.max_age_seconds,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return JSONResponse(  # type: ignore[return-value]
            dry_run_response(
                would="set",
                tenant_id=tenant,
                max_age_seconds=body.max_age_seconds,
            )
        )
    try:
        pv = set_policy(
            tenant,
            max_age_seconds=body.max_age_seconds,
            updated_by=caller,
        )
    except ValueError as exc:
        record_admin_action(
            action="workspace.session_policy.set",
            principal=p,
            target=tenant,
            details={"max_age_seconds": body.max_age_seconds},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.session_policy.set",
        principal=p,
        target=tenant,
        details={"max_age_seconds": pv.max_age_seconds},
        request_id=_rid(request),
    )
    return PolicyOut(
        tenant_id=pv.tenant_id,
        max_age_seconds=pv.max_age_seconds,
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
            action="workspace.session_policy.clear",
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
        action="workspace.session_policy.clear",
        principal=p,
        target=tenant,
        details={"removed": bool(removed)},
        request_id=_rid(request),
    )
    return _view(tenant)
