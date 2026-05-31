"""Workspace quota administration + self-serve usage.

GET  /v1/quota/me              -> current workspace usage + plan (viewer)
GET  /v1/admin/quota           -> all workspaces, current period (admin)
GET  /v1/admin/quota/{tid}     -> single workspace (admin)
PUT  /v1/admin/quota/{tid}     -> set plan / overrides (admin)

Every admin mutation is recorded in the admin audit log.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Request, status
from pydantic import BaseModel, ConfigDict, Field

from adherence_api.deps import require_admin, require_viewer
from adherence_common.admin_audit import record_admin_action
from adherence_common.quota import (
    DEFAULT_PLAN,
    PLANS,
    current_usage,
    get_plan,
    set_plan,
    snapshot,
)

router = APIRouter(prefix="/v1", tags=["quota"])


class PlanInfo(BaseModel):
    name: str
    monthly_predictions: int
    seats: int


class QuotaView(BaseModel):
    tenant_id: str
    plan: str
    monthly_predictions_limit: int
    monthly_predictions_used: int
    monthly_predictions_remaining: int
    seats_limit: int
    plans: list[PlanInfo]


class UpdateQuota(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan: Optional[str] = Field(None, description=f"One of: {sorted(PLANS)}")
    monthly_predictions_override: Optional[int] = Field(
        None, ge=0, description="Custom monthly cap. 0 clears the override.",
    )
    seats_override: Optional[int] = Field(None, ge=0)


def _view(tenant_id: str) -> QuotaView:
    plan, cap, seats = get_plan(tenant_id)
    used = current_usage(tenant_id)
    return QuotaView(
        tenant_id=tenant_id,
        plan=plan.name,
        monthly_predictions_limit=cap,
        monthly_predictions_used=used,
        monthly_predictions_remaining=max(0, cap - used),
        seats_limit=seats,
        plans=[PlanInfo(**p.__dict__) for p in PLANS.values()],
    )


@router.get("/quota/me", response_model=QuotaView)
def my_quota(p=Depends(require_viewer)) -> QuotaView:
    return _view(p.get("tenant", "default"))


@router.get("/admin/quota")
def list_quotas(p=Depends(require_admin)) -> dict:
    rows = snapshot()
    return {"period_rows": rows, "plans": [p.__dict__ for p in PLANS.values()]}


@router.get("/admin/quota/{tenant_id}", response_model=QuotaView)
def admin_get_quota(tenant_id: str, p=Depends(require_admin)) -> QuotaView:
    return _view(tenant_id)


@router.put("/admin/quota/{tenant_id}", response_model=QuotaView,
            status_code=status.HTTP_200_OK)
def admin_set_quota(
    tenant_id: str,
    body: UpdateQuota,
    request: Request,
    p=Depends(require_admin),
) -> QuotaView:
    before_plan, before_cap, before_seats = get_plan(tenant_id)
    if body.plan is not None and body.plan not in PLANS:
        # mirror pydantic-style structured error
        from fastapi import HTTPException
        raise HTTPException(400, detail=f"unknown plan: {body.plan}")
    set_plan(
        tenant_id,
        plan=body.plan,
        monthly_predictions_override=body.monthly_predictions_override,
        seats_override=body.seats_override,
    )
    after = _view(tenant_id)
    record_admin_action(
        action="quota.update",
        principal=p,
        target=f"workspace:{tenant_id}",
        details={
            "before": {
                "plan": before_plan.name,
                "limit": before_cap,
                "seats": before_seats,
            },
            "after": {
                "plan": after.plan,
                "limit": after.monthly_predictions_limit,
                "seats": after.seats_limit,
            },
            "ip": (request.client.host if request.client else None),
        },
        request_id=getattr(request.state, "request_id", None),
        tenant_id=tenant_id,
    )
    return after
