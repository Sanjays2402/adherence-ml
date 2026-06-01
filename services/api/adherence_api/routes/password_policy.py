"""Per-workspace password policy endpoints.

Companion to :mod:`adherence_common.password_policy`. Mirrors the
shape of the session-policy and retention-policy routes: viewer-readable
GET, admin-only PUT/DELETE gated by MFA step-up, dry-run aware, every
mutation recorded in the admin audit log.

A separate ``POST /v1/workspace/password-policy/check`` endpoint runs
the validator without storing or hashing the candidate, so the settings
UI can give live feedback and SCIM provisioners can pre-flight a
password before they ship it to identity providers.

Endpoints:

* ``GET    /v1/workspace/password-policy``  current tenant policy
* ``PUT    /v1/workspace/password-policy``  set or update the policy
* ``DELETE /v1/workspace/password-policy``  clear (fall back to default)
* ``POST   /v1/workspace/password-policy/check``  validate a candidate
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
from adherence_common.password_policy import (
    DEFAULT_POLICY,
    HISTORY_CEILING,
    MAX_AGE_DAYS_CEILING,
    MIN_LENGTH_CEILING,
    MIN_LENGTH_FLOOR,
    PolicyView,
    clear_policy,
    get_policy,
    set_policy,
    validate_password,
)

router = APIRouter(prefix="/v1/workspace/password-policy", tags=["workspace"])


def _rid(request: Request) -> Optional[str]:
    return getattr(request.state, "request_id", None)


class PolicyOut(BaseModel):
    tenant_id: Optional[str] = None
    min_length: int
    require_upper: bool
    require_lower: bool
    require_digit: bool
    require_symbol: bool
    max_age_days: int
    history_size: int
    updated_at: Optional[int] = None
    updated_by: Optional[str] = None
    using_default: bool
    bounds: dict


class PolicyIn(BaseModel):
    min_length: int = Field(
        ..., ge=MIN_LENGTH_FLOOR, le=MIN_LENGTH_CEILING,
        description=(
            f"Minimum password length in characters; "
            f"[{MIN_LENGTH_FLOOR}, {MIN_LENGTH_CEILING}]."
        ),
    )
    require_upper: bool = True
    require_lower: bool = True
    require_digit: bool = True
    require_symbol: bool = False
    max_age_days: int = Field(
        0, ge=0, le=MAX_AGE_DAYS_CEILING,
        description="Days before forced rotation. 0 disables rotation.",
    )
    history_size: int = Field(
        5, ge=0, le=HISTORY_CEILING,
        description="Number of previous passwords that may not be reused.",
    )


class CheckIn(BaseModel):
    # max_length kept generous; we never log or persist the candidate.
    password: str = Field(..., min_length=1, max_length=512)


class CheckOut(BaseModel):
    ok: bool
    reasons: list[str]
    policy_min_length: int


_BOUNDS = {
    "min_length_floor": MIN_LENGTH_FLOOR,
    "min_length_ceiling": MIN_LENGTH_CEILING,
    "max_age_days_ceiling": MAX_AGE_DAYS_CEILING,
    "history_ceiling": HISTORY_CEILING,
}


def _view(tenant_id: str) -> PolicyOut:
    pv: PolicyView = get_policy(tenant_id)
    return PolicyOut(
        tenant_id=pv.tenant_id or tenant_id,
        min_length=pv.min_length,
        require_upper=pv.require_upper,
        require_lower=pv.require_lower,
        require_digit=pv.require_digit,
        require_symbol=pv.require_symbol,
        max_age_days=pv.max_age_days,
        history_size=pv.history_size,
        updated_at=pv.updated_at,
        updated_by=pv.updated_by,
        using_default=(pv.tenant_id is None),
        bounds=_BOUNDS,
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
    details = body.model_dump()
    if dry_run:
        record_admin_action(
            action="workspace.password_policy.set",
            principal=p,
            target=tenant,
            details={**details, "dry_run": True},
            request_id=_rid(request),
        )
        return JSONResponse(  # type: ignore[return-value]
            dry_run_response(would="set", tenant_id=tenant, **details)
        )
    try:
        pv = set_policy(
            tenant,
            min_length=body.min_length,
            require_upper=body.require_upper,
            require_lower=body.require_lower,
            require_digit=body.require_digit,
            require_symbol=body.require_symbol,
            max_age_days=body.max_age_days,
            history_size=body.history_size,
            updated_by=caller,
        )
    except ValueError as exc:
        record_admin_action(
            action="workspace.password_policy.set",
            principal=p,
            target=tenant,
            details=details,
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.password_policy.set",
        principal=p,
        target=tenant,
        details=details,
        request_id=_rid(request),
    )
    return _view(tenant)


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
            action="workspace.password_policy.clear",
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
        action="workspace.password_policy.clear",
        principal=p,
        target=tenant,
        details={"removed": bool(removed)},
        request_id=_rid(request),
    )
    return _view(tenant)


@router.post("/check", response_model=CheckOut)
def check_password(
    body: CheckIn,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> CheckOut:
    """Run the validator without persisting or logging the candidate.

    The password value is never stored, audited, or echoed back. Only the
    aggregate ``ok`` flag and the reason strings produced by
    :func:`validate_password` are returned. The handler deliberately
    does not call ``record_admin_action`` here so that live-typing checks
    in the settings UI do not flood the audit log.
    """
    pv = get_policy(tenant)
    reasons = validate_password(body.password, policy=pv)
    return CheckOut(
        ok=not reasons,
        reasons=reasons,
        policy_min_length=pv.min_length,
    )


__all__ = ["router", "DEFAULT_POLICY"]
