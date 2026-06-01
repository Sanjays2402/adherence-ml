"""Per-workspace customer-managed encryption key (CMEK / BYOK) endpoints.

Lets a workspace owner declare and lifecycle-manage the customer-supplied
KMS key reference used for tenant-scoped envelope encryption. Procurement
teams in regulated verticals require an inspectable record of which key
is in force, when it was last rotated, and who signed it off; this is
the surface that answers those questions.

Endpoints (viewer read; admin-only mutations, MFA-gated, audit-logged,
dry-run aware):

* ``GET    /v1/workspace/cmek``           view current registration
* ``PUT    /v1/workspace/cmek``           declare or update the registration
* ``POST   /v1/workspace/cmek/rotate``    stamp a rotation event
* ``DELETE /v1/workspace/cmek``           clear the registration
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
from adherence_common.cmek_registry import (
    ALLOWED_PROVIDERS,
    ALLOWED_STATES,
    MAX_CONTACT_LEN,
    MAX_DESCRIPTION_LEN,
    MAX_KEY_REF_LEN,
    MAX_NOTE_LEN,
    MAX_ROTATION_DAYS,
    MIN_ROTATION_DAYS,
    clear_registration,
    get_registration,
    record_rotation,
    set_registration,
)

router = APIRouter(prefix="/v1/workspace/cmek", tags=["workspace"])


def _rid(request: Request) -> Optional[str]:
    return getattr(request.state, "request_id", None)


class RegistrationOut(BaseModel):
    tenant_id: str
    declared: bool = Field(
        ...,
        description=(
            "True when this workspace has a CMEK / BYOK registration on "
            "file. When false the workspace runs under the platform-"
            "managed default KMS keys documented in the trust manifest."
        ),
    )
    provider: Optional[str] = None
    key_reference: Optional[str] = None
    rotation_period_days: Optional[int] = None
    state: Optional[str] = None
    description: Optional[str] = None
    contact: Optional[str] = None
    registered_at: Optional[int] = None
    registered_by: Optional[str] = None
    last_rotated_at: Optional[int] = None
    last_rotated_by: Optional[str] = None
    rotation_count: int = 0
    updated_at: Optional[int] = None
    updated_by: Optional[str] = None
    rotation_due_at: Optional[int] = None
    rotation_overdue: bool = False
    allowed_providers: list[str] = list(ALLOWED_PROVIDERS)
    allowed_states: list[str] = list(ALLOWED_STATES)
    min_rotation_days: int = MIN_ROTATION_DAYS
    max_rotation_days: int = MAX_ROTATION_DAYS


class RegistrationIn(BaseModel):
    provider: str = Field(
        ...,
        description=(
            "Cloud KMS that hosts the customer-supplied key. Must be one "
            f"of {', '.join(ALLOWED_PROVIDERS)}."
        ),
    )
    key_reference: str = Field(
        ...,
        min_length=1,
        max_length=MAX_KEY_REF_LEN,
        description=(
            "Resource identifier for the key: AWS KMS ARN, GCP KMS "
            "resource name, Azure Key Vault key URI, or vendor-supplied "
            "alias. Single line only; never paste raw key material."
        ),
    )
    rotation_period_days: int = Field(
        ...,
        ge=MIN_ROTATION_DAYS,
        le=MAX_ROTATION_DAYS,
        description=(
            "Contractual rotation cadence in days. The registry uses this "
            "to compute ``rotation_due_at`` and flag overdue keys; the "
            "operator does not auto-rotate customer keys."
        ),
    )
    state: str = Field(
        "pending",
        description=(
            "Lifecycle state. ``pending`` while paperwork is in flight, "
            "``active`` once the grant is accepted, ``retired`` to keep "
            "history without enforcement."
        ),
    )
    description: Optional[str] = Field(
        None,
        max_length=MAX_DESCRIPTION_LEN,
        description="Optional free-text note shown in the admin console.",
    )
    contact: Optional[str] = Field(
        None,
        max_length=MAX_CONTACT_LEN,
        description="Optional point of contact (email or distribution list).",
    )


class RotationIn(BaseModel):
    new_key_reference: Optional[str] = Field(
        None,
        max_length=MAX_KEY_REF_LEN,
        description=(
            "Optional new resource identifier when the rotation produced "
            "a fresh key id. Omit to record a rotation that kept the "
            "same alias / ARN."
        ),
    )
    note: Optional[str] = Field(
        None,
        max_length=MAX_NOTE_LEN,
        description="Optional audit-only note (ticket number, change id, ...).",
    )


def _view(tenant_id: str) -> RegistrationOut:
    rv = get_registration(tenant_id)
    if rv is None:
        return RegistrationOut(tenant_id=tenant_id, declared=False)
    return RegistrationOut(
        tenant_id=rv.tenant_id,
        declared=True,
        provider=rv.provider,
        key_reference=rv.key_reference,
        rotation_period_days=rv.rotation_period_days,
        state=rv.state,
        description=rv.description,
        contact=rv.contact,
        registered_at=rv.registered_at,
        registered_by=rv.registered_by,
        last_rotated_at=rv.last_rotated_at,
        last_rotated_by=rv.last_rotated_by,
        rotation_count=rv.rotation_count,
        updated_at=rv.updated_at,
        updated_by=rv.updated_by,
        rotation_due_at=rv.rotation_due_at,
        rotation_overdue=rv.rotation_overdue,
    )


@router.get("", response_model=RegistrationOut)
def read_registration(
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> RegistrationOut:
    return _view(tenant)


@router.put("", response_model=RegistrationOut)
def write_registration(
    body: RegistrationIn,
    request: Request,
    dry_run: bool = False,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
) -> RegistrationOut:
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    payload = {
        "provider": body.provider,
        "key_reference": body.key_reference,
        "rotation_period_days": body.rotation_period_days,
        "state": body.state,
        "description": body.description,
        "contact": body.contact,
    }
    if dry_run:
        record_admin_action(
            action="workspace.cmek.set",
            principal=p,
            target=tenant,
            details={**payload, "dry_run": True},
            request_id=_rid(request),
        )
        return JSONResponse(  # type: ignore[return-value]
            dry_run_response(would="set", tenant_id=tenant, **payload)
        )
    try:
        rv = set_registration(
            tenant,
            provider=body.provider,
            key_reference=body.key_reference,
            rotation_period_days=body.rotation_period_days,
            state=body.state,
            description=body.description,
            contact=body.contact,
            updated_by=caller,
        )
    except ValueError as exc:
        record_admin_action(
            action="workspace.cmek.set",
            principal=p,
            target=tenant,
            details=payload,
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.cmek.set",
        principal=p,
        target=tenant,
        details={
            "provider": rv.provider,
            "key_reference": rv.key_reference,
            "rotation_period_days": rv.rotation_period_days,
            "state": rv.state,
        },
        request_id=_rid(request),
    )
    return _view(tenant)


@router.post("/rotate", response_model=RegistrationOut)
def rotate(
    body: RotationIn,
    request: Request,
    dry_run: bool = False,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
) -> RegistrationOut:
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    payload = {
        "new_key_reference": body.new_key_reference,
        "note": body.note,
    }
    if dry_run:
        record_admin_action(
            action="workspace.cmek.rotate",
            principal=p,
            target=tenant,
            details={**payload, "dry_run": True},
            request_id=_rid(request),
        )
        return JSONResponse(  # type: ignore[return-value]
            dry_run_response(would="rotate", tenant_id=tenant, **payload)
        )
    try:
        record_rotation(
            tenant,
            new_key_reference=body.new_key_reference,
            note=body.note,
            updated_by=caller,
        )
    except LookupError as exc:
        record_admin_action(
            action="workspace.cmek.rotate",
            principal=p,
            target=tenant,
            details=payload,
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)
        ) from exc
    except ValueError as exc:
        record_admin_action(
            action="workspace.cmek.rotate",
            principal=p,
            target=tenant,
            details=payload,
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.cmek.rotate",
        principal=p,
        target=tenant,
        details={"note_present": bool(body.note)},
        request_id=_rid(request),
    )
    return _view(tenant)


@router.delete("", response_model=RegistrationOut)
def delete_registration(
    request: Request,
    dry_run: bool = False,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
) -> RegistrationOut:
    if dry_run:
        record_admin_action(
            action="workspace.cmek.clear",
            principal=p,
            target=tenant,
            details={"dry_run": True},
            request_id=_rid(request),
        )
        return JSONResponse(  # type: ignore[return-value]
            dry_run_response(would="clear", tenant_id=tenant)
        )
    removed = clear_registration(tenant)
    record_admin_action(
        action="workspace.cmek.clear",
        principal=p,
        target=tenant,
        details={"removed": bool(removed)},
        request_id=_rid(request),
    )
    return _view(tenant)
