"""/v1/admin/purpose-of-use: read and write the workspace HIPAA POU policy.

Admin-only and tenant-scoped. Every mutation is recorded in the admin
audit log so SOC2 / HITRUST reviewers can answer "who narrowed PHI
access for this tenant and when". The route never crosses tenants:
the policy is always the caller's own.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import require_admin
from adherence_common import purpose_of_use as pou
from adherence_common.admin_audit import record_admin_action

router = APIRouter(prefix="/v1/admin/purpose-of-use", tags=["admin"])


class PolicyOut(BaseModel):
    tenant_id: str
    allowed: list[str]
    enforce: bool
    default_purpose: str | None
    updated_at: int
    updated_by: str | None
    known_codes: list[str]


class PolicyIn(BaseModel):
    allowed: list[str] = Field(
        default_factory=list,
        description=(
            "HL7 PurposeOfUse codes this workspace will accept. "
            "Subset of: TREATMENT, PAYMENT, OPERATIONS, EMERGENCY, "
            "RESEARCH, COVERAGE, PUBLICHEALTH."
        ),
        max_length=16,
    )
    enforce: bool = Field(
        False,
        description=(
            "When true, every PHI request must declare an "
            "X-Purpose-Of-Use header drawn from the allowed list, "
            "else the request is rejected with HTTP 412."
        ),
    )
    default_purpose: str | None = Field(
        None,
        description=(
            "Purpose stamped on PHI requests that do not send the "
            "header while enforce=false. Must be in allowed when set."
        ),
        max_length=32,
    )


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _view_to_out(v: pou.PolicyView) -> PolicyOut:
    return PolicyOut(
        tenant_id=v.tenant_id,
        allowed=list(v.allowed),
        enforce=v.enforce,
        default_purpose=v.default_purpose,
        updated_at=v.updated_at,
        updated_by=v.updated_by,
        known_codes=list(pou.KNOWN_POU_CODES),
    )


@router.get("", response_model=PolicyOut)
def get_policy(p=Depends(require_admin)) -> PolicyOut:
    tid = str(p.get("tenant") or "default")
    return _view_to_out(pou.get_policy(tid))


@router.put("", response_model=PolicyOut)
def put_policy(
    body: PolicyIn,
    request: Request,
    p=Depends(require_admin),
) -> PolicyOut:
    tid = str(p.get("tenant") or "default")
    try:
        view = pou.set_policy(
            tenant_id=tid,
            allowed=body.allowed,
            enforce=body.enforce,
            default_purpose=body.default_purpose,
            updated_by=str(p.get("sub") or "unknown"),
        )
    except ValueError as exc:
        record_admin_action(
            action="purpose_of_use.set", principal=p, target=tid,
            details={
                "allowed": body.allowed,
                "enforce": body.enforce,
                "default_purpose": body.default_purpose,
            },
            ok=False, error=str(exc), request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    record_admin_action(
        action="purpose_of_use.set", principal=p, target=tid,
        details={
            "allowed": list(view.allowed),
            "enforce": view.enforce,
            "default_purpose": view.default_purpose,
        },
        request_id=_rid(request),
    )
    return _view_to_out(view)


@router.delete("")
def delete_policy(
    request: Request,
    p=Depends(require_admin),
) -> dict:
    tid = str(p.get("tenant") or "default")
    removed = pou.clear_policy(tenant_id=tid)
    record_admin_action(
        action="purpose_of_use.clear", principal=p, target=tid,
        details={"removed": removed},
        request_id=_rid(request),
    )
    return {"removed": removed, "tenant_id": tid}
