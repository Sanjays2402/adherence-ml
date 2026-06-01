"""``/v1/admin/api-deprecations``: deployment-wide API lifecycle registry.

Read endpoints are open to any authenticated principal so SDK
maintainers and integrations engineers can see what is going away.
Write endpoints are admin-only and audit-logged. Mutations support
``?dry_run=true`` for change-management workflows.

Per-tenant usage of deprecated routes is exposed at
``/v1/admin/api-deprecations/usage`` and is strictly scoped to the
caller's own workspace.

A public, unauthenticated ``/.well-known/api-deprecations`` companion
endpoint lives in :mod:`adherence_api.routes.well_known_deprecations`
so external scanners and SDKs can pull the registry without an API
key.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import current_principal, require_admin
from adherence_api.dry_run import dry_run_response
from adherence_common import api_deprecations as dep
from adherence_common.admin_audit import record_admin_action

router = APIRouter(prefix="/v1/admin/api-deprecations", tags=["admin"])


class DeprecationOut(BaseModel):
    id: int
    method: str
    path_prefix: str
    deprecated_at: str
    sunset_at: str
    successor_link: str | None
    reason: str | None
    created_by: str | None
    created_at: str


class DeprecationIn(BaseModel):
    method: str = Field("*", min_length=1, max_length=8)
    path_prefix: str = Field(..., min_length=1, max_length=255)
    deprecated_at: str = Field(..., description="ISO 8601 datetime")
    sunset_at: str = Field(..., description="ISO 8601 datetime, strictly after deprecated_at")
    successor_link: str | None = Field(None, max_length=500)
    reason: str | None = Field(None, max_length=2000)


class DeprecationListOut(BaseModel):
    entries: list[DeprecationOut]


class UsageRowOut(BaseModel):
    deprecation_id: int
    method: str
    path_prefix: str
    sunset_at: str
    hits: int
    last_seen_at: str | None


class UsageListOut(BaseModel):
    tenant_id: str
    entries: list[UsageRowOut]


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _to_out(d: dep.DeprecationOut) -> DeprecationOut:
    return DeprecationOut(
        id=d.id,
        method=d.method,
        path_prefix=d.path_prefix,
        deprecated_at=d.deprecated_at,
        sunset_at=d.sunset_at,
        successor_link=d.successor_link,
        reason=d.reason,
        created_by=d.created_by,
        created_at=d.created_at,
    )


@router.get("", response_model=DeprecationListOut)
def list_deprecations(_p=Depends(current_principal)) -> DeprecationListOut:
    """Any authenticated principal may read the registry."""
    return DeprecationListOut(entries=[_to_out(e) for e in dep.list_entries()])


@router.post("", response_model=DeprecationOut, status_code=201)
def add_deprecation(
    body: DeprecationIn,
    request: Request,
    dry_run: bool = Query(False),
    p=Depends(require_admin),
) -> DeprecationOut:
    if dry_run:
        record_admin_action(
            action="api_deprecation.add", principal=p,
            target=f"{body.method} {body.path_prefix}",
            details={"dry_run": True, "sunset_at": body.sunset_at},
            request_id=_rid(request),
        )
        return DeprecationOut(
            id=0,
            method=body.method.upper(),
            path_prefix=body.path_prefix,
            deprecated_at=body.deprecated_at,
            sunset_at=body.sunset_at,
            successor_link=body.successor_link,
            reason=body.reason,
            created_by=str(p.get("sub") or "unknown"),
            created_at="",
        )
    try:
        entry = dep.add_entry(
            method=body.method,
            path_prefix=body.path_prefix,
            deprecated_at=body.deprecated_at,
            sunset_at=body.sunset_at,
            successor_link=body.successor_link,
            reason=body.reason,
            created_by=str(p.get("sub") or "unknown"),
        )
    except dep.DeprecationError as exc:
        record_admin_action(
            action="api_deprecation.add", principal=p,
            target=f"{body.method} {body.path_prefix}",
            details={"sunset_at": body.sunset_at},
            ok=False, error=str(exc), request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    record_admin_action(
        action="api_deprecation.add", principal=p,
        target=f"{entry.method} {entry.path_prefix}",
        details={
            "id": entry.id,
            "sunset_at": entry.sunset_at,
            "successor_link": entry.successor_link,
        },
        request_id=_rid(request),
    )
    return _to_out(entry)


@router.delete("/{entry_id}")
def remove_deprecation(
    entry_id: int,
    request: Request,
    dry_run: bool = Query(False),
    p=Depends(require_admin),
):
    existing = dep.get_entry(entry_id)
    if existing is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not_found")
    if dry_run:
        record_admin_action(
            action="api_deprecation.remove", principal=p,
            target=f"{existing.method} {existing.path_prefix}",
            details={"id": entry_id, "dry_run": True},
            request_id=_rid(request),
        )
        return dry_run_response(would="delete", id=entry_id)
    ok = dep.remove_entry(entry_id)
    record_admin_action(
        action="api_deprecation.remove", principal=p,
        target=f"{existing.method} {existing.path_prefix}",
        details={"id": entry_id},
        ok=ok, request_id=_rid(request),
    )
    return {"removed": True, "id": entry_id}


@router.get("/usage", response_model=UsageListOut)
def list_usage(p=Depends(require_admin)) -> UsageListOut:
    """Per-tenant deprecated-route usage. Strict tenant scoping."""
    tid = str(p.get("tenant") or "default")
    rows = dep.list_usage_for_tenant(tid)
    return UsageListOut(
        tenant_id=tid,
        entries=[
            UsageRowOut(
                deprecation_id=r.deprecation_id,
                method=r.method,
                path_prefix=r.path_prefix,
                sunset_at=r.sunset_at,
                hits=r.hits,
                last_seen_at=r.last_seen_at,
            )
            for r in rows
        ],
    )
