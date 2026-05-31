"""/v1/policies/risk: per-user/per-class risk tier overrides (admin)."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from adherence_api.deps import require_admin
from adherence_api.dry_run import dry_run_response
from adherence_common import risk_policy

router = APIRouter(prefix="/v1/policies/risk", tags=["policies"])


class RiskPolicyIn(BaseModel):
    scope_type: Literal["user", "dose_class"]
    scope_id: str = Field(..., min_length=1, max_length=64)
    low_max: float = Field(..., gt=0.0, lt=1.0,
                           description="miss_probability below this is 'low'")
    medium_max: float = Field(..., gt=0.0, lt=1.0,
                              description="below this (and >=low_max) is 'medium'; else 'high'")
    note: str | None = Field(None, max_length=512)


class RiskPolicyOut(BaseModel):
    id: int
    scope_type: str
    scope_id: str
    low_max: float
    medium_max: float
    note: str | None
    updated_by: str | None
    updated_at: str


@router.get("", response_model=list[RiskPolicyOut])
def list_(p=Depends(require_admin)):
    return risk_policy.list_policies()


@router.put("", response_model=RiskPolicyOut)
def upsert(body: RiskPolicyIn, p=Depends(require_admin)):
    try:
        return risk_policy.upsert(
            scope_type=body.scope_type, scope_id=body.scope_id,
            low_max=body.low_max, medium_max=body.medium_max,
            note=body.note, updated_by=str(p.get("sub", "admin")),
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc))


@router.delete("")
def delete_(scope_type: Literal["user", "dose_class"], scope_id: str,
            dry_run: bool = Query(
                False,
                description="Preview without deleting. Returns 404 if policy is missing.",
            ),
            p=Depends(require_admin)):
    if dry_run:
        found = any(
            r["scope_type"] == scope_type and r["scope_id"] == scope_id
            for r in risk_policy.list_policies()
        )
        if not found:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="policy not found")
        return dry_run_response(
            would="delete", scope_type=scope_type, scope_id=scope_id,
        )
    deleted = risk_policy.delete_policy(scope_type, scope_id)
    if not deleted:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="policy not found")
    return {"deleted": True, "scope_type": scope_type, "scope_id": scope_id}
