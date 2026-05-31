"""Workspace verified email domains.

Owner-managed claim list that powers SSO auto-join. Strictly tenant
scoped via :func:`current_tenant`; admins of one workspace cannot read
or mutate another workspace's claims.

Endpoints:

* ``GET    /v1/workspace/verified-domains``         list claims (viewer)
* ``POST   /v1/workspace/verified-domains``         add claim (admin)
* ``PATCH  /v1/workspace/verified-domains/{domain}`` toggle / change role (admin)
* ``DELETE /v1/workspace/verified-domains/{domain}`` remove claim (admin)

Every mutation is audit-logged with the caller principal and tenant_id.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from adherence_common.admin_audit import record_admin_action
from adherence_common import verified_domains as vd

from adherence_api.deps import (
    current_tenant,
    require_admin,
    require_viewer,
)

router = APIRouter(prefix="/v1/workspace/verified-domains", tags=["workspace"])


class VerifiedDomainResponse(BaseModel):
    id: int
    tenant_id: str
    domain: str
    default_role: str
    auto_join_enabled: bool
    added_by: Optional[str] = None
    added_at: str
    updated_at: str


class VerifiedDomainListResponse(BaseModel):
    tenant_id: str
    count: int
    domains: list[VerifiedDomainResponse]


class CreateVerifiedDomainRequest(BaseModel):
    domain: str = Field(..., min_length=3, max_length=253)
    default_role: str = Field("viewer", description="One of admin | service | viewer")
    auto_join_enabled: bool = Field(True)


class UpdateVerifiedDomainRequest(BaseModel):
    default_role: Optional[str] = Field(None)
    auto_join_enabled: Optional[bool] = Field(None)


def _to_resp(view: vd.VerifiedDomainView) -> VerifiedDomainResponse:
    return VerifiedDomainResponse(
        id=view.id,
        tenant_id=view.tenant_id,
        domain=view.domain,
        default_role=view.default_role,
        auto_join_enabled=view.auto_join_enabled,
        added_by=view.added_by,
        added_at=view.added_at.isoformat(),
        updated_at=view.updated_at.isoformat(),
    )


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


@router.get("", response_model=VerifiedDomainListResponse)
def list_domains(
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> VerifiedDomainListResponse:
    rows = vd.list_domains(tenant)
    return VerifiedDomainListResponse(
        tenant_id=tenant,
        count=len(rows),
        domains=[_to_resp(r) for r in rows],
    )


@router.post("", response_model=VerifiedDomainResponse, status_code=status.HTTP_201_CREATED)
def add_domain(
    body: CreateVerifiedDomainRequest,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
) -> VerifiedDomainResponse:
    try:
        domain = vd.normalise_domain(body.domain)
        role = vd.normalise_role(body.default_role)
    except ValueError as exc:
        record_admin_action(
            action="workspace.verified_domain.add", principal=p,
            target=str(body.domain),
            details={"role": body.default_role}, ok=False, error=str(exc),
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))

    try:
        view = vd.add_domain(
            tenant, domain,
            default_role=role,
            auto_join_enabled=body.auto_join_enabled,
            added_by=str(p.get("sub") or p.get("key_name") or ""),
        )
    except vd.DuplicateDomain as exc:
        record_admin_action(
            action="workspace.verified_domain.add", principal=p, target=domain,
            details={"role": role}, ok=False, error=str(exc),
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc))

    record_admin_action(
        action="workspace.verified_domain.add", principal=p, target=domain,
        details={"role": role, "auto_join_enabled": body.auto_join_enabled},
        ok=True, request_id=_rid(request), tenant_id=tenant,
    )
    return _to_resp(view)


@router.patch("/{domain}", response_model=VerifiedDomainResponse)
def update_domain(
    domain: str,
    body: UpdateVerifiedDomainRequest,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
) -> VerifiedDomainResponse:
    try:
        d = vd.normalise_domain(domain)
        role = vd.normalise_role(body.default_role) if body.default_role is not None else None
    except ValueError as exc:
        record_admin_action(
            action="workspace.verified_domain.update", principal=p, target=domain,
            details={"role": body.default_role}, ok=False, error=str(exc),
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))

    previous = vd.get_domain(tenant, d)
    if previous is None:
        record_admin_action(
            action="workspace.verified_domain.update", principal=p, target=d,
            details=None, ok=False, error="not found",
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "verified domain not found")

    view = vd.update_domain(
        tenant, d,
        default_role=role,
        auto_join_enabled=body.auto_join_enabled,
    )
    assert view is not None
    record_admin_action(
        action="workspace.verified_domain.update", principal=p, target=d,
        details={
            "default_role": view.default_role,
            "auto_join_enabled": view.auto_join_enabled,
            "previous_role": previous.default_role,
            "previous_auto_join_enabled": previous.auto_join_enabled,
        },
        ok=True, request_id=_rid(request), tenant_id=tenant,
    )
    return _to_resp(view)


@router.delete("/{domain}", response_model=VerifiedDomainResponse)
def delete_domain(
    domain: str,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
) -> VerifiedDomainResponse:
    try:
        d = vd.normalise_domain(domain)
    except ValueError as exc:
        record_admin_action(
            action="workspace.verified_domain.remove", principal=p, target=domain,
            details=None, ok=False, error=str(exc),
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))

    view = vd.remove_domain(tenant, d)
    if view is None:
        record_admin_action(
            action="workspace.verified_domain.remove", principal=p, target=d,
            details=None, ok=False, error="not found",
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "verified domain not found")
    record_admin_action(
        action="workspace.verified_domain.remove", principal=p, target=d,
        details={"role": view.default_role}, ok=True,
        request_id=_rid(request), tenant_id=tenant,
    )
    return _to_resp(view)
