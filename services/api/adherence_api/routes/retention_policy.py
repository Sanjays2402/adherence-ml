"""Per-workspace data retention policy endpoints.

Lets a workspace admin declare how long each tenant-scoped retention
target table should hold rows for this workspace, independent of the
deployment-wide default. Procurement teams asking for HIPAA / GDPR /
SOC2 attestation routinely require this as a deal-blocker so they can
prove their own data minimization story instead of inheriting the
vendor default.

Endpoints (admin-only, MFA-gated, audit-logged, dry-run aware):

* ``GET    /v1/workspace/retention-policy`` view current tenant policy
* ``PUT    /v1/workspace/retention-policy`` set or update overrides
* ``DELETE /v1/workspace/retention-policy`` clear all overrides
* ``POST   /v1/workspace/retention-policy/sweep`` run a tenant-scoped
  sweep using the saved policy (or an ad-hoc override) and report per
  table candidate / deleted counts. ``dry_run=true`` reports without
  deleting.

Every sweep is scoped by ``tenant_id`` in the SQL WHERE clause; one
workspace cannot affect another's rows even if an admin sends a
hand-crafted payload.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from adherence_api.deps import current_tenant, require_admin, require_viewer
from adherence_api.dry_run import dry_run_response
from adherence_api.routes.admin_mfa import require_admin_mfa
from adherence_common import legal_hold as legal_hold_mod
from adherence_common.admin_audit import record_admin_action
from adherence_common.retention_policy import (
    ALLOWED_TABLES,
    MAX_TTL_DAYS,
    MIN_TTL_DAYS,
    clear_policy,
    get_policy,
    set_policy,
    sweep_for_tenant,
)

router = APIRouter(prefix="/v1/workspace/retention-policy", tags=["workspace"])


def _rid(request: Request) -> Optional[str]:
    return getattr(request.state, "request_id", None)


class PolicyOut(BaseModel):
    tenant_id: str
    ttls_days: dict[str, int] = Field(
        default_factory=dict,
        description=(
            "Mapping of table name to retention TTL in days for this "
            "workspace. Tables not present inherit the deployment "
            "default. Empty object means no per-tenant overrides."
        ),
    )
    updated_at: Optional[int] = None
    updated_by: Optional[str] = None
    allowed_tables: list[str] = Field(
        default_factory=lambda: list(ALLOWED_TABLES),
        description="Tables eligible for per-tenant retention overrides.",
    )
    min_ttl_days: int = MIN_TTL_DAYS
    max_ttl_days: int = MAX_TTL_DAYS


class PolicyIn(BaseModel):
    ttls_days: dict[str, int] = Field(
        ...,
        description=(
            f"Map of table -> ttl in days. Allowed table keys: "
            f"{list(ALLOWED_TABLES)}. Each value must be in "
            f"[{MIN_TTL_DAYS}, {MAX_TTL_DAYS}]."
        ),
    )

    @field_validator("ttls_days")
    @classmethod
    def _non_empty(cls, v: dict[str, int]) -> dict[str, int]:
        if not v:
            raise ValueError(
                "ttls_days must contain at least one entry; "
                "DELETE the policy to clear it"
            )
        return v


class SweepIn(BaseModel):
    ttls_days: Optional[dict[str, int]] = Field(
        None,
        description=(
            "Optional ad-hoc TTL override map. When omitted the saved "
            "tenant policy is used. When supplied the saved policy is "
            "ignored for this call only (it is not persisted)."
        ),
    )
    tables: Optional[list[str]] = Field(
        None,
        description="Restrict the sweep to this subset of tables.",
    )
    dry_run: bool = Field(
        False,
        description="Count candidates without deleting.",
    )


class SweepRow(BaseModel):
    table: str
    cutoff: str
    candidates: int
    deleted: int


class SweepOut(BaseModel):
    tenant_id: str
    dry_run: bool
    results: list[SweepRow]


def _view(tenant_id: str) -> PolicyOut:
    pv = get_policy(tenant_id)
    if pv is None:
        return PolicyOut(tenant_id=tenant_id)
    return PolicyOut(
        tenant_id=pv.tenant_id,
        ttls_days=pv.ttls_days,
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
    if dry_run:
        record_admin_action(
            action="workspace.retention_policy.set",
            principal=p,
            target=tenant,
            details={"ttls_days": body.ttls_days, "dry_run": True},
            request_id=_rid(request),
        )
        return JSONResponse(  # type: ignore[return-value]
            dry_run_response(
                would="set",
                tenant_id=tenant,
                ttls_days=body.ttls_days,
            )
        )
    try:
        pv = set_policy(
            tenant, ttls_days=body.ttls_days, updated_by=caller
        )
    except ValueError as exc:
        record_admin_action(
            action="workspace.retention_policy.set",
            principal=p,
            target=tenant,
            details={"ttls_days": body.ttls_days},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.retention_policy.set",
        principal=p,
        target=tenant,
        details={"ttls_days": pv.ttls_days},
        request_id=_rid(request),
    )
    return PolicyOut(
        tenant_id=pv.tenant_id,
        ttls_days=pv.ttls_days,
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
            action="workspace.retention_policy.clear",
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
        action="workspace.retention_policy.clear",
        principal=p,
        target=tenant,
        details={"removed": bool(removed)},
        request_id=_rid(request),
    )
    return _view(tenant)


@router.post("/sweep", response_model=SweepOut)
def run_sweep(
    body: SweepIn,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
) -> SweepOut:
    """Tenant-scoped retention sweep. Deletes only rows belonging to
    the caller's workspace; cannot leak across tenants.
    """
    if not body.dry_run and legal_hold_mod.is_on_hold(tenant):
        hold = legal_hold_mod.active_hold_summary(tenant)
        record_admin_action(
            action="workspace.retention_policy.sweep",
            principal=p,
            target=tenant,
            details={
                "ttls_days": body.ttls_days,
                "tables": body.tables,
                "dry_run": body.dry_run,
                "blocked_by": "legal_hold",
                "hold_id": (hold.id if hold else None),
            },
            ok=False,
            error="legal_hold_active",
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_423_LOCKED,
            detail={
                "code": "legal_hold_active",
                "message": (
                    "this workspace is under an active legal hold; "
                    "retention sweep is blocked. release the hold or "
                    "use dry_run=true to preview without deleting."
                ),
                "hold_id": (hold.id if hold else None),
                "placed_at": (hold.placed_at if hold else None),
                "placed_by": (hold.placed_by if hold else None),
                "ticket_ref": (hold.ticket_ref if hold else None),
            },
        )
    try:
        rows = sweep_for_tenant(
            tenant,
            ttls_days=body.ttls_days,
            tables=body.tables,
            dry_run=body.dry_run,
        )
    except ValueError as exc:
        record_admin_action(
            action="workspace.retention_policy.sweep",
            principal=p,
            target=tenant,
            details={
                "ttls_days": body.ttls_days,
                "tables": body.tables,
                "dry_run": body.dry_run,
            },
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.retention_policy.sweep",
        principal=p,
        target=tenant,
        details={
            "ttls_days": body.ttls_days,
            "tables": body.tables,
            "dry_run": body.dry_run,
            "results": [
                {"table": r.table, "candidates": r.candidates, "deleted": r.deleted}
                for r in rows
            ],
        },
        request_id=_rid(request),
    )
    return SweepOut(
        tenant_id=tenant,
        dry_run=body.dry_run,
        results=[
            SweepRow(
                table=r.table,
                cutoff=r.cutoff.isoformat(),
                candidates=r.candidates,
                deleted=r.deleted,
            )
            for r in rows
        ],
    )
