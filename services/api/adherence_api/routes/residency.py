"""Per-workspace data residency endpoints.

Lets a workspace admin pin their tenant to one of the supported
regions (``us``, ``eu``) so storage and worker fleets, plus the
``X-Data-Residency`` response header, all agree on where the
workspace's data lives. The choice is contractually binding under the
subprocessors policy.

Endpoints (admin-only, MFA-gated, audit-logged, dry-run aware):

* ``GET    /v1/workspace/residency`` view current pin
* ``PUT    /v1/workspace/residency`` set the pin
* ``DELETE /v1/workspace/residency`` clear the pin (fall back to default)
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
from adherence_common.residency import (
    ALLOWED_REGIONS,
    DEFAULT_REGION,
    clear_region,
    get_residency,
    set_region,
)

router = APIRouter(prefix="/v1/workspace/residency", tags=["workspace"])


def _rid(request: Request) -> Optional[str]:
    return getattr(request.state, "request_id", None)


_ALLOWED_SORTED = sorted(ALLOWED_REGIONS)


class ResidencyOut(BaseModel):
    tenant_id: str
    region: str = Field(
        ...,
        description=(
            "Active region for this tenant. Falls back to the deployment "
            "default when no explicit pin is set."
        ),
    )
    pinned: bool = Field(
        ...,
        description="True when the workspace has explicitly set a region.",
    )
    updated_at: Optional[int] = None
    updated_by: Optional[str] = None
    default_region: str = DEFAULT_REGION
    allowed_regions: list[str] = Field(default_factory=lambda: list(_ALLOWED_SORTED))


class ResidencyIn(BaseModel):
    region: str = Field(
        ...,
        description=(
            f"Region code. Allowed values: {', '.join(_ALLOWED_SORTED)}."
        ),
    )


def _view(tenant_id: str) -> ResidencyOut:
    rv = get_residency(tenant_id)
    if rv is None:
        return ResidencyOut(
            tenant_id=tenant_id,
            region=DEFAULT_REGION,
            pinned=False,
        )
    return ResidencyOut(
        tenant_id=rv.tenant_id,
        region=rv.region,
        pinned=True,
        updated_at=rv.updated_at,
        updated_by=rv.updated_by,
    )


@router.get("", response_model=ResidencyOut)
def read_residency(
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> ResidencyOut:
    return _view(tenant)


@router.put("", response_model=ResidencyOut)
def write_residency(
    body: ResidencyIn,
    request: Request,
    dry_run: bool = False,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
) -> ResidencyOut:
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.residency.set",
            principal=p,
            target=tenant,
            details={"region": body.region, "dry_run": True},
            request_id=_rid(request),
        )
        return JSONResponse(  # type: ignore[return-value]
            dry_run_response(
                would="set",
                tenant_id=tenant,
                region=body.region,
            )
        )
    try:
        rv = set_region(tenant, region=body.region, updated_by=caller)
    except ValueError as exc:
        record_admin_action(
            action="workspace.residency.set",
            principal=p,
            target=tenant,
            details={"region": body.region},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.residency.set",
        principal=p,
        target=tenant,
        details={"region": rv.region},
        request_id=_rid(request),
    )
    return ResidencyOut(
        tenant_id=rv.tenant_id,
        region=rv.region,
        pinned=True,
        updated_at=rv.updated_at,
        updated_by=rv.updated_by,
    )


@router.delete("", response_model=ResidencyOut)
def delete_residency(
    request: Request,
    dry_run: bool = False,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
) -> ResidencyOut:
    if dry_run:
        record_admin_action(
            action="workspace.residency.clear",
            principal=p,
            target=tenant,
            details={"dry_run": True},
            request_id=_rid(request),
        )
        return JSONResponse(  # type: ignore[return-value]
            dry_run_response(would="clear", tenant_id=tenant)
        )
    removed = clear_region(tenant)
    record_admin_action(
        action="workspace.residency.clear",
        principal=p,
        target=tenant,
        details={"removed": bool(removed)},
        request_id=_rid(request),
    )
    return _view(tenant)
