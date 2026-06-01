"""/v1/admin/origin-allowlist: list, add, remove tenant browser Origin entries.

Admin-only and tenant-scoped: every operation is bound to the caller's
own tenant. There is no cross-tenant read or write surface. Each
mutation is recorded in the admin audit log so SOC2 reviewers can see
who narrowed the browser surface and when.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import require_admin
from adherence_api.dry_run import dry_run_response
from adherence_common import origin_allowlist as oa
from adherence_common.admin_audit import record_admin_action

router = APIRouter(prefix="/v1/admin/origin-allowlist", tags=["admin"])


class OriginEntryOut(BaseModel):
    id: int
    tenant_id: str
    origin: str
    label: str | None
    created_by: str | None
    created_at: str


class OriginEntryIn(BaseModel):
    origin: str = Field(..., min_length=1, max_length=255)
    label: str | None = Field(None, max_length=128)


class OriginListOut(BaseModel):
    tenant_id: str
    enforced: bool
    entries: list[OriginEntryOut]


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _entry_to_out(e: oa.OriginEntry) -> OriginEntryOut:
    return OriginEntryOut(
        id=e.id,
        tenant_id=e.tenant_id,
        origin=e.origin,
        label=e.label,
        created_by=e.created_by,
        created_at=e.created_at,
    )


@router.get("", response_model=OriginListOut)
def list_origins(p=Depends(require_admin)) -> OriginListOut:
    tid = str(p.get("tenant") or "default")
    entries = oa.list_entries(tid)
    return OriginListOut(
        tenant_id=tid,
        enforced=bool(entries),
        entries=[_entry_to_out(e) for e in entries],
    )


@router.post("", response_model=OriginEntryOut, status_code=201)
def add_origin(
    body: OriginEntryIn,
    request: Request,
    p=Depends(require_admin),
) -> OriginEntryOut:
    tid = str(p.get("tenant") or "default")
    try:
        entry = oa.add_entry(
            tenant_id=tid,
            origin=body.origin,
            label=body.label,
            created_by=str(p.get("sub") or "unknown"),
        )
    except oa.OriginAllowlistError as exc:
        record_admin_action(
            action="origin_allowlist.add", principal=p, target=body.origin,
            details={"label": body.label},
            ok=False, error=str(exc), request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    record_admin_action(
        action="origin_allowlist.add", principal=p, target=entry.origin,
        details={"id": entry.id, "label": entry.label},
        request_id=_rid(request),
    )
    return _entry_to_out(entry)


@router.delete("/{entry_id}")
def remove_origin(
    entry_id: int,
    request: Request,
    dry_run: bool = Query(
        False,
        description="Preview without removing. Returns 404 if entry is missing.",
    ),
    p=Depends(require_admin),
) -> dict:
    tid = str(p.get("tenant") or "default")
    if dry_run:
        entries = oa.list_entries(tid)
        match = next((e for e in entries if e.id == entry_id), None)
        if match is None:
            record_admin_action(
                action="origin_allowlist.remove", principal=p, target=str(entry_id),
                details={"dry_run": True},
                ok=False, error="entry not found", request_id=_rid(request),
            )
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="entry not found")
        record_admin_action(
            action="origin_allowlist.remove", principal=p, target=str(entry_id),
            details={"dry_run": True, "origin": match.origin, "label": match.label},
            request_id=_rid(request),
        )
        return dry_run_response(would="remove", id=entry_id, origin=match.origin)
    ok = oa.remove_entry(tenant_id=tid, entry_id=entry_id)
    if not ok:
        record_admin_action(
            action="origin_allowlist.remove", principal=p, target=str(entry_id),
            ok=False, error="entry not found", request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="entry not found")
    record_admin_action(
        action="origin_allowlist.remove", principal=p, target=str(entry_id),
        request_id=_rid(request),
    )
    return {"removed": True, "id": entry_id}
