"""/v1/admin/outbound-host-allowlist: per-tenant allowlist of permitted
outbound webhook destination hostnames.

Admin-only and tenant-scoped: every operation is bound to the caller's
own tenant. There is no cross-tenant read or write surface. Each
mutation is recorded in the admin audit log so SOC2 reviewers can see
who narrowed (or widened) the egress policy and when.

The allowlist is consulted by :mod:`adherence_common.outbound_policy`
at both subscription create time and on every dispatch.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import require_admin
from adherence_api.dry_run import dry_run_response
from adherence_common import outbound_host_allowlist as tha
from adherence_common.admin_audit import record_admin_action

router = APIRouter(
    prefix="/v1/admin/outbound-host-allowlist", tags=["admin"]
)


class HostEntryOut(BaseModel):
    id: int
    tenant_id: str
    host: str
    label: str | None
    created_by: str | None
    created_at: str


class HostEntryIn(BaseModel):
    host: str = Field(..., min_length=1, max_length=253)
    label: str | None = Field(None, max_length=128)


class HostListOut(BaseModel):
    tenant_id: str
    enforced: bool
    entries: list[HostEntryOut]


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _to_out(e: tha.HostAllowlistEntry) -> HostEntryOut:
    return HostEntryOut(
        id=e.id,
        tenant_id=e.tenant_id,
        host=e.host,
        label=e.label,
        created_by=e.created_by,
        created_at=e.created_at,
    )


@router.get("", response_model=HostListOut)
def list_hosts(p=Depends(require_admin)) -> HostListOut:
    tid = str(p.get("tenant") or "default")
    entries = tha.list_entries(tid)
    return HostListOut(
        tenant_id=tid,
        enforced=bool(entries),
        entries=[_to_out(e) for e in entries],
    )


@router.post("", response_model=HostEntryOut, status_code=201)
def add_host(
    body: HostEntryIn,
    request: Request,
    p=Depends(require_admin),
) -> HostEntryOut:
    tid = str(p.get("tenant") or "default")
    try:
        entry = tha.add_entry(
            tenant_id=tid,
            host=body.host,
            label=body.label,
            created_by=str(p.get("sub") or "unknown"),
        )
    except tha.HostAllowlistError as exc:
        record_admin_action(
            action="outbound_host_allowlist.add",
            principal=p,
            target=body.host,
            details={"label": body.label},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    record_admin_action(
        action="outbound_host_allowlist.add",
        principal=p,
        target=entry.host,
        details={"id": entry.id, "label": entry.label},
        request_id=_rid(request),
    )
    return _to_out(entry)


@router.delete("/{entry_id}")
def remove_host(
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
        entries = tha.list_entries(tid)
        match = next((e for e in entries if e.id == entry_id), None)
        if match is None:
            record_admin_action(
                action="outbound_host_allowlist.remove",
                principal=p,
                target=str(entry_id),
                details={"dry_run": True},
                ok=False,
                error="entry not found",
                request_id=_rid(request),
            )
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="entry not found")
        record_admin_action(
            action="outbound_host_allowlist.remove",
            principal=p,
            target=str(entry_id),
            details={"dry_run": True, "host": match.host, "label": match.label},
            request_id=_rid(request),
        )
        return dry_run_response(would="remove", id=entry_id, host=match.host)
    ok = tha.remove_entry(tenant_id=tid, entry_id=entry_id)
    if not ok:
        record_admin_action(
            action="outbound_host_allowlist.remove",
            principal=p,
            target=str(entry_id),
            ok=False,
            error="entry not found",
            request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="entry not found")
    record_admin_action(
        action="outbound_host_allowlist.remove",
        principal=p,
        target=str(entry_id),
        request_id=_rid(request),
    )
    return {"removed": True, "id": entry_id}
