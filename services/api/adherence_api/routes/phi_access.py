"""/v1/admin/phi-access: workspace owner view onto the PHI access log.

Read-only, tenant-scoped, admin-only. Every row written by
:mod:`adherence_api.purpose_of_use_middleware` is queryable here so a
HIPAA covered entity buyer can satisfy "show me who touched what PHI
under what purpose" in one place. There is no edit or delete surface;
the table is append-only by design.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from adherence_api.deps import require_admin
from adherence_common import purpose_of_use as pou

router = APIRouter(prefix="/v1/admin/phi-access", tags=["admin"])


class PHIAccessOut(BaseModel):
    id: int
    tenant_id: str
    created_at: str
    request_id: str | None
    route: str
    method: str
    purpose: str
    actor: str
    actor_role: str
    key_name: str | None
    client_ip: str | None
    status_code: int
    latency_ms: float | None
    user_id: str | None
    note: str | None


class PHIAccessListOut(BaseModel):
    tenant_id: str
    total: int
    n: int
    events: list[PHIAccessOut]


def _to_out(v: pou.AccessLogView) -> PHIAccessOut:
    return PHIAccessOut(
        id=v.id,
        tenant_id=v.tenant_id,
        created_at=v.created_at,
        request_id=v.request_id,
        route=v.route,
        method=v.method,
        purpose=v.purpose,
        actor=v.actor,
        actor_role=v.actor_role,
        key_name=v.key_name,
        client_ip=v.client_ip,
        status_code=v.status_code,
        latency_ms=v.latency_ms,
        user_id=v.user_id,
        note=v.note,
    )


@router.get("", response_model=PHIAccessListOut)
def list_phi_access(
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    purpose: str | None = Query(
        None,
        description="Filter to one HL7 PurposeOfUse code (case-insensitive).",
        max_length=32,
    ),
    actor: str | None = Query(
        None,
        description="Filter by actor (API key name or subject).",
        max_length=128,
    ),
    user_id: str | None = Query(
        None,
        description="Filter by patient user id touched by the request.",
        max_length=128,
    ),
    p=Depends(require_admin),
) -> PHIAccessListOut:
    tid = str(p.get("tenant") or "default")
    rows = pou.list_access(
        tenant_id=tid, limit=limit, offset=offset,
        purpose=purpose, actor=actor, user_id=user_id,
    )
    total = pou.count_access(
        tenant_id=tid, purpose=purpose, actor=actor, user_id=user_id,
    )
    return PHIAccessListOut(
        tenant_id=tid,
        total=total,
        n=len(rows),
        events=[_to_out(r) for r in rows],
    )
