"""Sub-processor registry, change notifications, and per-workspace
acknowledgments.

The registry itself is operator-managed and globally readable: every
prospective customer needs to be able to see the current list at
``/v1/subprocessors`` and the change log at ``/v1/subprocessors/changes``
without authenticating. Acknowledgments are strictly tenant-scoped and
require viewer (read) or admin (write) inside the workspace.

Routes
~~~~~~
Public read (no auth required, used by the trust center):

* ``GET  /v1/subprocessors``                 active sub-processors
* ``GET  /v1/subprocessors/changes``         announced changes, newest first

Workspace read (viewer+):

* ``GET  /v1/subprocessors/outstanding``     changes this workspace owes
* ``GET  /v1/subprocessors/acknowledgments`` this workspace's ack log

Workspace write (admin):

* ``POST /v1/subprocessors/acknowledge``     record acknowledgment of a change

Operator write (admin in the deployment-default tenant; same trust
boundary as ``/v1/legal/documents``):

* ``POST   /v1/subprocessors``               register a new sub-processor
* ``PATCH  /v1/subprocessors/{name}``        update an existing one
* ``DELETE /v1/subprocessors/{name}``        mark removed (soft delete)

Every operator mutation and every workspace acknowledgment writes to
the admin audit log with caller, IP, user-agent, and request id.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from adherence_common import subprocessors as sp
from adherence_common.admin_audit import record_admin_action

from adherence_api.deps import current_principal, current_tenant, require_admin, require_viewer

router = APIRouter(prefix="/v1/subprocessors", tags=["subprocessors"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class SubprocessorOut(BaseModel):
    id: int
    name: str
    purpose: str
    data_categories: str
    region: str
    url: Optional[str] = None
    status: str
    created_at: str
    updated_at: str
    created_by: Optional[str] = None


class SubprocessorListResponse(BaseModel):
    count: int
    subprocessors: list[SubprocessorOut]


class ChangeOut(BaseModel):
    id: int
    subprocessor_id: int
    name: str
    change_type: str
    summary: str
    announced_at: str
    effective_at: str
    created_by: Optional[str] = None


class ChangeListResponse(BaseModel):
    count: int
    changes: list[ChangeOut]


class OutstandingResponse(BaseModel):
    tenant_id: str
    count: int
    changes: list[ChangeOut]


class AckOut(BaseModel):
    id: int
    tenant_id: str
    change_id: int
    subject: str
    subject_role: str
    acknowledged_at: str
    ip: Optional[str] = None
    user_agent: Optional[str] = None
    request_id: Optional[str] = None


class AckListResponse(BaseModel):
    tenant_id: str
    count: int
    acknowledgments: list[AckOut]


class RegisterRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    purpose: str = Field(..., min_length=1, max_length=512)
    data_categories: str = Field(..., min_length=1, max_length=512)
    region: str = Field(..., min_length=1, max_length=128)
    url: Optional[str] = Field(None, max_length=512)
    summary: Optional[str] = Field(None, max_length=2048)
    effective_at: Optional[str] = Field(
        None,
        description="ISO-8601 UTC timestamp; defaults to now + 30 days",
    )


class UpdateRequest(BaseModel):
    purpose: Optional[str] = Field(None, min_length=1, max_length=512)
    data_categories: Optional[str] = Field(None, min_length=1, max_length=512)
    region: Optional[str] = Field(None, min_length=1, max_length=128)
    url: Optional[str] = Field(None, max_length=512)
    summary: Optional[str] = Field(None, max_length=2048)
    effective_at: Optional[str] = None


class RemoveRequest(BaseModel):
    summary: Optional[str] = Field(None, max_length=2048)
    effective_at: Optional[str] = None


class AckRequest(BaseModel):
    change_id: int = Field(..., ge=1)


class RegisterResponse(BaseModel):
    subprocessor: SubprocessorOut
    change: ChangeOut


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    real = request.headers.get("x-real-ip", "")
    if real:
        return real.strip()
    return request.client.host if request.client else ""


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"invalid effective_at: {exc}"
        )


def _sp_out(v: sp.SubprocessorView) -> SubprocessorOut:
    return SubprocessorOut(
        id=v.id, name=v.name, purpose=v.purpose,
        data_categories=v.data_categories, region=v.region, url=v.url,
        status=v.status,
        created_at=v.created_at.isoformat(),
        updated_at=v.updated_at.isoformat(),
        created_by=v.created_by,
    )


def _ch_out(v: sp.ChangeView) -> ChangeOut:
    return ChangeOut(
        id=v.id, subprocessor_id=v.subprocessor_id, name=v.name,
        change_type=v.change_type, summary=v.summary,
        announced_at=v.announced_at.isoformat(),
        effective_at=v.effective_at.isoformat(),
        created_by=v.created_by,
    )


def _ack_out(v: sp.AckView) -> AckOut:
    return AckOut(
        id=v.id, tenant_id=v.tenant_id, change_id=v.change_id,
        subject=v.subject, subject_role=v.subject_role,
        acknowledged_at=v.acknowledged_at.isoformat(),
        ip=v.ip, user_agent=v.user_agent, request_id=v.request_id,
    )


# ---------------------------------------------------------------------------
# Public registry read paths
# ---------------------------------------------------------------------------


@router.get("", response_model=SubprocessorListResponse)
def list_active(include_removed: bool = False) -> SubprocessorListResponse:
    """Public list of current sub-processors. No auth required."""
    rows = sp.list_subprocessors(include_removed=include_removed)
    return SubprocessorListResponse(
        count=len(rows), subprocessors=[_sp_out(r) for r in rows]
    )


@router.get("/changes", response_model=ChangeListResponse)
def list_changes(limit: int = 200) -> ChangeListResponse:
    """Public change log. No auth required so prospective customers
    can see the notice history from the trust center."""
    rows = sp.list_changes(limit=limit)
    return ChangeListResponse(
        count=len(rows), changes=[_ch_out(r) for r in rows]
    )


# ---------------------------------------------------------------------------
# Workspace-scoped read paths
# ---------------------------------------------------------------------------


@router.get("/outstanding", response_model=OutstandingResponse)
def outstanding(
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> OutstandingResponse:
    rows = sp.outstanding_changes(tenant)
    return OutstandingResponse(
        tenant_id=tenant, count=len(rows),
        changes=[_ch_out(r) for r in rows],
    )


@router.get("/acknowledgments", response_model=AckListResponse)
def list_acks(
    change_id: Optional[int] = None,
    limit: int = 200,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> AckListResponse:
    rows = sp.list_acknowledgments(tenant, change_id=change_id, limit=limit)
    return AckListResponse(
        tenant_id=tenant, count=len(rows),
        acknowledgments=[_ack_out(r) for r in rows],
    )


# ---------------------------------------------------------------------------
# Workspace acknowledgment (admin)
# ---------------------------------------------------------------------------


@router.post(
    "/acknowledge",
    response_model=AckOut,
    status_code=status.HTTP_201_CREATED,
)
def acknowledge(
    body: AckRequest,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
) -> AckOut:
    subject = str(p.get("sub") or p.get("key_name") or "")
    role = str(p.get("role") or "viewer")
    ip = _client_ip(request)
    ua = request.headers.get("user-agent", "")
    rid = _rid(request)
    try:
        view = sp.record_acknowledgment(
            tenant_id=tenant, change_id=body.change_id,
            subject=subject, subject_role=role,
            ip=ip, user_agent=ua, request_id=rid,
        )
    except sp.UnknownChange as exc:
        record_admin_action(
            action="subprocessor.acknowledge", principal=p,
            target=f"change:{body.change_id}",
            details={"change_id": body.change_id}, ok=False, error=str(exc),
            request_id=rid, tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc))
    except ValueError as exc:
        record_admin_action(
            action="subprocessor.acknowledge", principal=p,
            target=f"change:{body.change_id}",
            details=None, ok=False, error=str(exc),
            request_id=rid, tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    record_admin_action(
        action="subprocessor.acknowledge", principal=p,
        target=f"change:{view.change_id}",
        details={"change_id": view.change_id, "subject": view.subject},
        ok=True, request_id=rid, tenant_id=tenant,
    )
    return _ack_out(view)


# ---------------------------------------------------------------------------
# Operator registry mutations (admin)
# ---------------------------------------------------------------------------


@router.post(
    "",
    response_model=RegisterResponse,
    status_code=status.HTTP_201_CREATED,
)
def register(
    body: RegisterRequest,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
) -> RegisterResponse:
    eff = _parse_iso(body.effective_at)
    try:
        view, change = sp.register_subprocessor(
            name=body.name, purpose=body.purpose,
            data_categories=body.data_categories, region=body.region,
            url=body.url, summary=body.summary, effective_at=eff,
            created_by=str(p.get("sub") or p.get("key_name") or ""),
        )
    except sp.DuplicateSubprocessor as exc:
        record_admin_action(
            action="subprocessor.register", principal=p,
            target=body.name, details={"name": body.name},
            ok=False, error=str(exc),
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc))
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    record_admin_action(
        action="subprocessor.register", principal=p,
        target=view.name,
        details={
            "name": view.name, "purpose": view.purpose,
            "data_categories": view.data_categories,
            "region": view.region, "url": view.url,
            "effective_at": change.effective_at.isoformat(),
        },
        ok=True, request_id=_rid(request), tenant_id=tenant,
    )
    return RegisterResponse(subprocessor=_sp_out(view), change=_ch_out(change))


@router.patch("/{name}", response_model=RegisterResponse)
def update(
    name: str,
    body: UpdateRequest,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
) -> RegisterResponse:
    eff = _parse_iso(body.effective_at)
    try:
        view, change = sp.update_subprocessor(
            name=name, purpose=body.purpose,
            data_categories=body.data_categories, region=body.region,
            url=body.url, summary=body.summary, effective_at=eff,
            created_by=str(p.get("sub") or p.get("key_name") or ""),
        )
    except sp.UnknownSubprocessor as exc:
        record_admin_action(
            action="subprocessor.update", principal=p, target=name,
            details=None, ok=False, error=str(exc),
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc))
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    record_admin_action(
        action="subprocessor.update", principal=p, target=view.name,
        details={
            "summary": change.summary,
            "effective_at": change.effective_at.isoformat(),
        },
        ok=True, request_id=_rid(request), tenant_id=tenant,
    )
    return RegisterResponse(subprocessor=_sp_out(view), change=_ch_out(change))


@router.delete("/{name}", response_model=RegisterResponse)
def remove(
    name: str,
    request: Request,
    summary: Optional[str] = None,
    effective_at: Optional[str] = None,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
) -> RegisterResponse:
    eff = _parse_iso(effective_at)
    try:
        view, change = sp.remove_subprocessor(
            name=name, summary=summary, effective_at=eff,
            created_by=str(p.get("sub") or p.get("key_name") or ""),
        )
    except sp.UnknownSubprocessor as exc:
        record_admin_action(
            action="subprocessor.remove", principal=p, target=name,
            details=None, ok=False, error=str(exc),
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc))
    record_admin_action(
        action="subprocessor.remove", principal=p, target=view.name,
        details={
            "summary": change.summary,
            "effective_at": change.effective_at.isoformat(),
        },
        ok=True, request_id=_rid(request), tenant_id=tenant,
    )
    return RegisterResponse(subprocessor=_sp_out(view), change=_ch_out(change))
