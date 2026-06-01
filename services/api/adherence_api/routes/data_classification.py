"""Per-workspace data classification endpoints.

Lets a workspace admin pin their tenant to one of the supported
sensitivity tiers (``public``, ``internal``, ``confidential``,
``restricted``) so the API, storage, and egress fleets, plus the
``X-Data-Classification`` response header, all agree on how the
workspace's data must be handled.

Endpoints (admin-only, MFA-gated, audit-logged, dry-run aware):

* ``GET    /v1/workspace/data-classification`` view current label
* ``PUT    /v1/workspace/data-classification`` set the label
* ``DELETE /v1/workspace/data-classification`` clear (fall back to default)
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
from adherence_common.data_classification import (
    ALLOWED_CLASSIFICATIONS,
    DEFAULT_CLASSIFICATION,
    MIN_RETENTION_DAYS,
    clear_classification,
    get_classification,
    set_classification,
)

router = APIRouter(
    prefix="/v1/workspace/data-classification", tags=["workspace"]
)


def _rid(request: Request) -> Optional[str]:
    return getattr(request.state, "request_id", None)


_ALLOWED_SORTED = sorted(ALLOWED_CLASSIFICATIONS)


class ClassificationOut(BaseModel):
    tenant_id: str
    label: str = Field(
        ...,
        description=(
            "Active sensitivity label for this tenant. Falls back to the "
            "deployment default when no explicit label is set."
        ),
    )
    pinned: bool = Field(
        ...,
        description="True when the workspace has explicitly set a label.",
    )
    justification: Optional[str] = None
    updated_at: Optional[int] = None
    updated_by: Optional[str] = None
    default_label: str = DEFAULT_CLASSIFICATION
    allowed_labels: list[str] = Field(
        default_factory=lambda: list(_ALLOWED_SORTED)
    )
    min_retention_days: int = Field(
        ...,
        description=(
            "Minimum retention floor (days) enforced for the active label."
        ),
    )


class ClassificationIn(BaseModel):
    label: str = Field(
        ...,
        description=(
            f"Sensitivity label. Allowed values: {', '.join(_ALLOWED_SORTED)}."
        ),
    )
    justification: Optional[str] = Field(
        default=None,
        max_length=1024,
        description=(
            "Optional rationale (e.g. data inventory ID or DPIA reference). "
            "Captured in the audit chain so reviewers can trace why a "
            "label changed."
        ),
    )


def _view(tenant_id: str) -> ClassificationOut:
    cv = get_classification(tenant_id)
    if cv is None:
        return ClassificationOut(
            tenant_id=tenant_id,
            label=DEFAULT_CLASSIFICATION,
            pinned=False,
            min_retention_days=MIN_RETENTION_DAYS[DEFAULT_CLASSIFICATION],
        )
    return ClassificationOut(
        tenant_id=cv.tenant_id,
        label=cv.label,
        pinned=True,
        justification=cv.justification,
        updated_at=cv.updated_at,
        updated_by=cv.updated_by,
        min_retention_days=MIN_RETENTION_DAYS.get(cv.label, 0),
    )


@router.get("", response_model=ClassificationOut)
def read_classification(
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> ClassificationOut:
    return _view(tenant)


@router.put("", response_model=ClassificationOut)
def write_classification(
    body: ClassificationIn,
    request: Request,
    dry_run: bool = False,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
) -> ClassificationOut:
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    prior = get_classification(tenant)
    prior_label = prior.label if prior else DEFAULT_CLASSIFICATION
    if dry_run:
        record_admin_action(
            action="workspace.data_classification.set",
            principal=p,
            target=tenant,
            details={
                "label": body.label,
                "prior_label": prior_label,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return JSONResponse(  # type: ignore[return-value]
            dry_run_response(
                would="set",
                tenant_id=tenant,
                label=body.label,
                prior_label=prior_label,
            )
        )
    try:
        cv = set_classification(
            tenant,
            label=body.label,
            justification=body.justification,
            updated_by=caller,
        )
    except ValueError as exc:
        record_admin_action(
            action="workspace.data_classification.set",
            principal=p,
            target=tenant,
            details={"label": body.label, "prior_label": prior_label},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.data_classification.set",
        principal=p,
        target=tenant,
        details={
            "label": cv.label,
            "prior_label": prior_label,
            "has_justification": bool(cv.justification),
        },
        request_id=_rid(request),
    )
    return ClassificationOut(
        tenant_id=cv.tenant_id,
        label=cv.label,
        pinned=True,
        justification=cv.justification,
        updated_at=cv.updated_at,
        updated_by=cv.updated_by,
        min_retention_days=MIN_RETENTION_DAYS.get(cv.label, 0),
    )


@router.delete("", response_model=ClassificationOut)
def delete_classification(
    request: Request,
    dry_run: bool = False,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
) -> ClassificationOut:
    prior = get_classification(tenant)
    if dry_run:
        record_admin_action(
            action="workspace.data_classification.clear",
            principal=p,
            target=tenant,
            details={
                "dry_run": True,
                "prior_label": prior.label if prior else None,
            },
            request_id=_rid(request),
        )
        return JSONResponse(  # type: ignore[return-value]
            dry_run_response(would="clear", tenant_id=tenant)
        )
    removed = clear_classification(tenant)
    record_admin_action(
        action="workspace.data_classification.clear",
        principal=p,
        target=tenant,
        details={
            "removed": bool(removed),
            "prior_label": prior.label if prior else None,
        },
        request_id=_rid(request),
    )
    return _view(tenant)
