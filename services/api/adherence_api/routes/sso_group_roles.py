"""Per-tenant OIDC group claim to role mapping admin endpoints.

Lets a workspace owner declare that members of an IdP group (e.g.
``okta:adherence-admins``) get a specific internal role inside their
tenant when they sign in over SSO. The mappings are consulted by
:func:`adherence_common.oidc.map_identity_to_principal` BEFORE the
deployment-wide email-domain map, so group membership always wins.

All endpoints are admin-only, scoped to the caller's tenant (admins
cannot edit another tenant's rows from here), MFA-gated for mutations,
and written to the admin audit log.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import current_tenant, require_admin
from adherence_api.routes.admin_mfa import require_admin_mfa
from adherence_common.admin_audit import record_admin_action
from adherence_common.oidc_group_map import (
    MAX_GROUP_LEN,
    MAX_NOTE_LEN,
    VALID_ROLES,
    add_mapping,
    delete_mapping,
    list_mappings,
)

router = APIRouter(
    prefix="/v1/admin/sso/group-roles",
    tags=["admin"],
)


def _rid(request: Request | None) -> Optional[str]:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


class MappingOut(BaseModel):
    id: int
    tenant_id: str
    group_claim: str
    role: str
    priority: int
    note: Optional[str] = None
    created_by: Optional[str] = None
    created_at: Optional[str] = None


class MappingsResponse(BaseModel):
    tenant_id: str
    items: list[MappingOut]
    max_group_len: int = MAX_GROUP_LEN
    max_note_len: int = MAX_NOTE_LEN
    valid_roles: list[str] = Field(default_factory=lambda: sorted(VALID_ROLES))


class MappingCreate(BaseModel):
    group_claim: str = Field(min_length=1, max_length=MAX_GROUP_LEN)
    role: str = Field(min_length=1, max_length=16)
    priority: int = Field(default=100, ge=0, le=10_000)
    note: Optional[str] = Field(default=None, max_length=MAX_NOTE_LEN)


def _to_out(m) -> MappingOut:
    return MappingOut(
        id=m.id,
        tenant_id=m.tenant_id,
        group_claim=m.group_claim,
        role=m.role,
        priority=m.priority,
        note=m.note,
        created_by=m.created_by,
        created_at=(m.created_at.isoformat() if m.created_at else None),
    )


@router.get("", response_model=MappingsResponse)
def list_group_mappings(
    tenant: str = Depends(current_tenant),
    _p=Depends(require_admin),
) -> MappingsResponse:
    items = [_to_out(m) for m in list_mappings(tenant)]
    return MappingsResponse(tenant_id=tenant, items=items)


@router.post("", response_model=MappingOut, status_code=status.HTTP_201_CREATED)
def create_group_mapping(
    body: MappingCreate,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
) -> MappingOut:
    try:
        row = add_mapping(
            tenant_id=tenant,
            group_claim=body.group_claim,
            role=body.role,
            priority=body.priority,
            note=body.note,
            created_by=str(p.get("sub") or p.get("name") or "unknown"),
        )
    except ValueError as exc:
        record_admin_action(
            action="sso.group_role.create",
            principal=p,
            target=body.group_claim,
            details={
                "tenant_id": tenant,
                "role": body.role,
                "priority": body.priority,
            },
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    record_admin_action(
        action="sso.group_role.create",
        principal=p,
        target=body.group_claim,
        details={
            "tenant_id": tenant,
            "role": body.role,
            "priority": body.priority,
            "mapping_id": row.id,
        },
        request_id=_rid(request),
    )
    return _to_out(row)


@router.delete("/{mapping_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_group_mapping(
    mapping_id: int,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
) -> None:
    if mapping_id <= 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid mapping_id")
    ok = delete_mapping(mapping_id, tenant)
    record_admin_action(
        action="sso.group_role.delete",
        principal=p,
        target=str(mapping_id),
        details={"tenant_id": tenant, "removed": ok},
        ok=ok,
        error=None if ok else "not_found",
        request_id=_rid(request),
    )
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mapping not found")
    return None
