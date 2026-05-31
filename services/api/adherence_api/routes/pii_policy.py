"""Per-workspace PII redaction policy endpoints.

Lets a workspace admin pick which built-in PII patterns (email, phone,
ssn, mrn, credit_card, ipv4) and optional custom regexes are scrubbed
from narrative fields the platform persists on behalf of their tenant.

Wired into:

* :func:`adherence_common.admin_audit.record_admin_action` which scrubs
  the ``details`` blob of every admin-plane mutation.
* The medtracker inbound webhook which scrubs ``DoseOutcome.notes``
  when the operator has mapped its source to this tenant via the
  ``inbound_source_tenants`` setting.

Endpoints (admin-only, MFA-gated, audit-logged, dry-run aware):

* ``GET    /v1/workspace/pii-policy`` view current tenant policy
* ``PUT    /v1/workspace/pii-policy`` set or update enabled patterns
* ``DELETE /v1/workspace/pii-policy`` clear the policy (no scrubbing)
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from adherence_api.deps import current_tenant, require_admin, require_viewer
from adherence_api.dry_run import dry_run_response
from adherence_api.routes.admin_mfa import require_admin_mfa
from adherence_common.admin_audit import record_admin_action
from adherence_common.pii_policy import (
    BUILTIN_NAMES,
    DEFAULT_MASK,
    MAX_CUSTOM_PATTERNS,
    MAX_MASK_LEN,
    MAX_PATTERN_LEN,
    clear_policy,
    get_policy,
    set_policy,
)

router = APIRouter(prefix="/v1/workspace/pii-policy", tags=["workspace"])


def _rid(request: Request) -> Optional[str]:
    return getattr(request.state, "request_id", None)


class PolicyOut(BaseModel):
    tenant_id: str
    enabled_builtins: list[str] = Field(default_factory=list)
    custom_patterns: list[str] = Field(default_factory=list)
    mask: str = DEFAULT_MASK
    updated_at: Optional[int] = None
    updated_by: Optional[str] = None
    supported_builtins: list[str] = Field(default_factory=lambda: list(BUILTIN_NAMES))
    max_custom_patterns: int = MAX_CUSTOM_PATTERNS
    max_pattern_length: int = MAX_PATTERN_LEN
    max_mask_length: int = MAX_MASK_LEN


class PolicyIn(BaseModel):
    enabled_builtins: list[str] = Field(
        default_factory=list, max_length=len(BUILTIN_NAMES),
    )
    custom_patterns: list[str] = Field(
        default_factory=list, max_length=MAX_CUSTOM_PATTERNS,
    )
    mask: str = Field(
        default=DEFAULT_MASK, min_length=1, max_length=MAX_MASK_LEN,
    )


def _view(tenant_id: str) -> PolicyOut:
    pv = get_policy(tenant_id)
    if pv is None:
        return PolicyOut(tenant_id=tenant_id)
    return PolicyOut(
        tenant_id=pv.tenant_id,
        enabled_builtins=list(pv.enabled_builtins),
        custom_patterns=list(pv.custom_patterns),
        mask=pv.mask,
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
    summary = {
        "enabled_builtins": list(body.enabled_builtins),
        "custom_patterns_count": len(body.custom_patterns),
        "mask": body.mask,
    }
    if dry_run:
        record_admin_action(
            action="workspace.pii_policy.set",
            principal=p, target=tenant,
            details={**summary, "dry_run": True},
            request_id=_rid(request),
        )
        return JSONResponse(
            dry_run_response(
                would="set", tenant_id=tenant,
                enabled_builtins=list(body.enabled_builtins),
                custom_patterns_count=len(body.custom_patterns),
                mask=body.mask,
            )
        )
    try:
        pv = set_policy(
            tenant,
            enabled_builtins=body.enabled_builtins,
            custom_patterns=body.custom_patterns,
            mask=body.mask,
            updated_by=caller,
        )
    except ValueError as exc:
        record_admin_action(
            action="workspace.pii_policy.set",
            principal=p, target=tenant, details=summary,
            ok=False, error=str(exc), request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.pii_policy.set",
        principal=p, target=tenant,
        details={
            "enabled_builtins": list(pv.enabled_builtins),
            "custom_patterns_count": len(pv.custom_patterns),
            "mask": pv.mask,
        },
        request_id=_rid(request),
    )
    return PolicyOut(
        tenant_id=pv.tenant_id,
        enabled_builtins=list(pv.enabled_builtins),
        custom_patterns=list(pv.custom_patterns),
        mask=pv.mask,
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
            action="workspace.pii_policy.clear",
            principal=p, target=tenant,
            details={"dry_run": True}, request_id=_rid(request),
        )
        return JSONResponse(dry_run_response(would="clear", tenant_id=tenant))
    removed = clear_policy(tenant)
    record_admin_action(
        action="workspace.pii_policy.clear",
        principal=p, target=tenant,
        details={"removed": bool(removed)}, request_id=_rid(request),
    )
    return _view(tenant)
