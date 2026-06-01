"""Per-workspace enforce-SSO policy endpoints.

A workspace owner can flip enforce-SSO on for their tenant so that only
OIDC-issued sessions (and explicitly allow-listed break-glass subjects /
service-account API keys) may call the API. The toggle is admin-only,
MFA-gated, audit-logged, and supports ``?dry_run=true``.

Wired into :func:`adherence_common.sso_enforcement.enforce`, which is
called from :func:`services.api.adherence_api.deps._principal_from_headers`
on every authenticated request, so the policy bites every existing route
without per-route changes.

Endpoints (all under ``/v1/workspace/sso-enforcement``):

* ``GET``    view the current tenant policy (admin role required to see
             the break-glass list; viewers see only ``require_sso``).
* ``PUT``    set or update the policy.
* ``DELETE`` clear the policy (fall back to no enforcement).
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
from adherence_common.sso_enforcement import (
    MAX_BREAK_GLASS_SUBJECTS,
    MAX_SUBJECT_LEN,
    clear_policy,
    get_policy,
    set_policy,
)

router = APIRouter(prefix="/v1/workspace/sso-enforcement", tags=["workspace"])


def _rid(request: Request) -> Optional[str]:
    return getattr(request.state, "request_id", None)


class PolicyOut(BaseModel):
    tenant_id: str
    require_sso: bool = False
    break_glass_subjects: list[str] = Field(default_factory=list)
    updated_at: Optional[int] = None
    updated_by: Optional[str] = None
    max_break_glass_subjects: int = MAX_BREAK_GLASS_SUBJECTS
    max_subject_len: int = MAX_SUBJECT_LEN


class PolicyIn(BaseModel):
    require_sso: bool
    break_glass_subjects: list[str] = Field(
        default_factory=list,
        max_length=MAX_BREAK_GLASS_SUBJECTS,
        description=(
            "Up to "
            f"{MAX_BREAK_GLASS_SUBJECTS} subject ids (JWT 'sub' or API key "
            "name) that may bypass the enforce-SSO gate. Every bypass is "
            "written to the admin audit log."
        ),
    )


def _view(tenant_id: str, *, redact_break_glass: bool = False) -> PolicyOut:
    pv = get_policy(tenant_id)
    if pv is None:
        return PolicyOut(tenant_id=tenant_id)
    return PolicyOut(
        tenant_id=pv.tenant_id,
        require_sso=pv.require_sso,
        break_glass_subjects=(
            [] if redact_break_glass else list(pv.break_glass_subjects)
        ),
        updated_at=pv.updated_at,
        updated_by=pv.updated_by,
    )


@router.get("", response_model=PolicyOut)
def read_policy(
    tenant: str = Depends(current_tenant),
    p=Depends(require_viewer),
) -> PolicyOut:
    # Viewers can see whether SSO is enforced, but not the break-glass
    # list (operationally that is admin-only material).
    return _view(tenant, redact_break_glass=(p.get("role") != "admin"))


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
    details = {
        "require_sso": bool(body.require_sso),
        "break_glass_subjects_count": len(body.break_glass_subjects),
    }
    if dry_run:
        record_admin_action(
            action="workspace.sso_enforcement.set",
            principal=p,
            target=tenant,
            details={**details, "dry_run": True},
            request_id=_rid(request),
            tenant_id=tenant,
        )
        return JSONResponse(  # type: ignore[return-value]
            dry_run_response(
                would="set",
                tenant_id=tenant,
                **details,
            )
        )
    try:
        pv = set_policy(
            tenant,
            require_sso=body.require_sso,
            break_glass_subjects=body.break_glass_subjects,
            updated_by=caller,
        )
    except ValueError as exc:
        record_admin_action(
            action="workspace.sso_enforcement.set",
            principal=p,
            target=tenant,
            details=details,
            ok=False,
            error=str(exc),
            request_id=_rid(request),
            tenant_id=tenant,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.sso_enforcement.set",
        principal=p,
        target=tenant,
        details=details,
        request_id=_rid(request),
        tenant_id=tenant,
    )
    return PolicyOut(
        tenant_id=pv.tenant_id,
        require_sso=pv.require_sso,
        break_glass_subjects=list(pv.break_glass_subjects),
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
            action="workspace.sso_enforcement.clear",
            principal=p,
            target=tenant,
            details={"dry_run": True},
            request_id=_rid(request),
            tenant_id=tenant,
        )
        return JSONResponse(  # type: ignore[return-value]
            dry_run_response(would="clear", tenant_id=tenant)
        )
    removed = clear_policy(tenant)
    record_admin_action(
        action="workspace.sso_enforcement.clear",
        principal=p,
        target=tenant,
        details={"removed": bool(removed)},
        request_id=_rid(request),
        tenant_id=tenant,
    )
    return _view(tenant)
