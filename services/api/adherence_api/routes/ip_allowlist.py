"""/v1/admin/ip-allowlist: list, add, remove tenant IP allowlist entries.

Admin-only and tenant-scoped: every operation is bound to the caller's
own tenant. There is no cross-tenant read or write surface. Each mutation
is recorded in the admin audit log so SOC2 reviewers can see who
narrowed the network exposure and when.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import require_admin
from adherence_common import ip_allowlist as ipa
from adherence_common.admin_audit import record_admin_action

router = APIRouter(prefix="/v1/admin/ip-allowlist", tags=["admin"])


class AllowlistEntryOut(BaseModel):
    id: int
    tenant_id: str
    cidr: str
    label: str | None
    created_by: str | None
    created_at: str


class AllowlistEntryIn(BaseModel):
    cidr: str = Field(..., min_length=1, max_length=64)
    label: str | None = Field(None, max_length=128)


class AllowlistListOut(BaseModel):
    tenant_id: str
    enforced: bool
    entries: list[AllowlistEntryOut]


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _entry_to_out(e: ipa.AllowlistEntry) -> AllowlistEntryOut:
    return AllowlistEntryOut(
        id=e.id,
        tenant_id=e.tenant_id,
        cidr=e.cidr,
        label=e.label,
        created_by=e.created_by,
        created_at=e.created_at,
    )


@router.get("", response_model=AllowlistListOut)
def list_allowlist(p=Depends(require_admin)) -> AllowlistListOut:
    tid = str(p.get("tenant") or "default")
    entries = ipa.list_entries(tid)
    return AllowlistListOut(
        tenant_id=tid,
        enforced=bool(entries),
        entries=[_entry_to_out(e) for e in entries],
    )


@router.post("", response_model=AllowlistEntryOut, status_code=201)
def add_allowlist(
    body: AllowlistEntryIn,
    request: Request,
    p=Depends(require_admin),
) -> AllowlistEntryOut:
    tid = str(p.get("tenant") or "default")
    try:
        entry = ipa.add_entry(
            tenant_id=tid,
            cidr=body.cidr,
            label=body.label,
            created_by=str(p.get("sub") or "unknown"),
        )
    except ipa.IpAllowlistError as exc:
        record_admin_action(
            action="ip_allowlist.add", principal=p, target=body.cidr,
            details={"label": body.label},
            ok=False, error=str(exc), request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    record_admin_action(
        action="ip_allowlist.add", principal=p, target=entry.cidr,
        details={"id": entry.id, "label": entry.label},
        request_id=_rid(request),
    )
    return _entry_to_out(entry)


@router.delete("/{entry_id}")
def remove_allowlist(
    entry_id: int,
    request: Request,
    p=Depends(require_admin),
) -> dict:
    tid = str(p.get("tenant") or "default")
    ok = ipa.remove_entry(tenant_id=tid, entry_id=entry_id)
    if not ok:
        record_admin_action(
            action="ip_allowlist.remove", principal=p, target=str(entry_id),
            ok=False, error="entry not found", request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="entry not found")
    record_admin_action(
        action="ip_allowlist.remove", principal=p, target=str(entry_id),
        request_id=_rid(request),
    )
    return {"removed": True, "id": entry_id}
