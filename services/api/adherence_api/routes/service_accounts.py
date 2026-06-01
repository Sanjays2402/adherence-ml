"""/v1/admin/service-accounts: per-tenant Service Account / NHI register.

Enterprise procurement and SOC 2 / ISO 27001 auditors ask for an
inventory of every non-human identity that holds standing credentials
against the system: CI runners, ETL pipelines, third-party
integrations, monitoring probes, headless daemons. Without that
register, named owner per identity, rotation cadence, last-used
timestamp, scopes, vault-managed flag, security review stalls.

Reads require ``viewer`` and above. Mutations require ``admin`` and an
active MFA challenge, mirroring DPIA, RoPA, BCDR, legal hold,
incidents, retention policy, and pentests. Every mutation writes an
admin audit row. All queries are strictly tenant-scoped: there is no
cross-tenant code path on this router. Every mutation supports
``?dry_run=true``.
"""
from __future__ import annotations

import csv
import io
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from adherence_api.deps import current_tenant, require_admin, require_viewer
from adherence_api.dry_run import dry_run_response
from adherence_api.routes.admin_mfa import require_admin_mfa
from adherence_common import service_accounts as sa_mod
from adherence_common.admin_audit import record_admin_action
from adherence_common.logging import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/v1/admin/service-accounts", tags=["service-accounts"])


class ServiceAccountOut(BaseModel):
    id: int
    tenant_id: str
    name: str
    kind: str
    system_of_record: str
    credential_kind: str
    owner_email: str
    scopes: list[str]
    vault_managed: bool
    rotation_cadence_days: int
    review_cadence_days: int
    last_rotated_at: Optional[str] = None
    last_reviewed_at: Optional[str] = None
    last_used_at: Optional[str] = None
    next_rotation_due_at: str
    next_review_due_at: str
    rotation_overdue: bool
    review_overdue: bool
    dormant_days: Optional[int] = None
    status: str
    notes: Optional[str] = None
    version: int
    created_by: str
    created_at: str
    updated_by: Optional[str] = None
    updated_at: Optional[str] = None
    archived_by: Optional[str] = None
    archived_at: Optional[str] = None
    active: bool


class ServiceAccountListOut(BaseModel):
    tenant_id: str
    active_count: int
    archived_count: int
    rotation_overdue_count: int
    review_overdue_count: int
    entries: list[ServiceAccountOut]


class CreateServiceAccountIn(BaseModel):
    name: str = Field(
        ...,
        min_length=sa_mod.MIN_NAME_LEN,
        max_length=sa_mod.MAX_NAME_LEN,
        description=(
            "Stable identifier for the non-human identity. Letters, digits, "
            "'.', '_' or '-'. Unique per workspace among active rows."
        ),
    )
    kind: str = Field(
        ...,
        description="Identity kind. One of: " + ", ".join(sa_mod.KINDS),
    )
    system_of_record: str = Field(
        ..., min_length=2, max_length=sa_mod.MAX_SYSTEM_LEN,
        description="External platform this identity authenticates into.",
    )
    credential_kind: str = Field(
        ...,
        description="Credential kind. One of: " + ", ".join(sa_mod.CREDENTIAL_KINDS),
    )
    owner_email: str = Field(
        ..., max_length=sa_mod.MAX_OWNER_LEN,
        description="Human owner accountable for this identity.",
    )
    scopes: Optional[list[str]] = Field(
        None, description="Granted scopes or roles attached to the credential."
    )
    vault_managed: bool = Field(
        False,
        description="True when the secret is stored in a managed vault.",
    )
    rotation_cadence_days: Optional[int] = Field(
        None,
        ge=sa_mod.MIN_ROTATION_CADENCE_DAYS,
        le=sa_mod.MAX_ROTATION_CADENCE_DAYS,
    )
    review_cadence_days: Optional[int] = Field(
        None,
        ge=sa_mod.MIN_REVIEW_CADENCE_DAYS,
        le=sa_mod.MAX_REVIEW_CADENCE_DAYS,
    )
    last_rotated_at: Optional[str] = None
    last_reviewed_at: Optional[str] = None
    last_used_at: Optional[str] = None
    status: str = Field(
        "active",
        description="Status. One of: " + ", ".join(sa_mod.STATUSES),
    )
    notes: Optional[str] = Field(None, max_length=sa_mod.MAX_NOTES_LEN)


class UpdateServiceAccountIn(BaseModel):
    kind: Optional[str] = None
    system_of_record: Optional[str] = Field(
        None, min_length=2, max_length=sa_mod.MAX_SYSTEM_LEN
    )
    credential_kind: Optional[str] = None
    owner_email: Optional[str] = Field(None, max_length=sa_mod.MAX_OWNER_LEN)
    scopes: Optional[list[str]] = None
    vault_managed: Optional[bool] = None
    rotation_cadence_days: Optional[int] = Field(
        None,
        ge=sa_mod.MIN_ROTATION_CADENCE_DAYS,
        le=sa_mod.MAX_ROTATION_CADENCE_DAYS,
    )
    review_cadence_days: Optional[int] = Field(
        None,
        ge=sa_mod.MIN_REVIEW_CADENCE_DAYS,
        le=sa_mod.MAX_REVIEW_CADENCE_DAYS,
    )
    status: Optional[str] = None
    notes: Optional[str] = Field(None, max_length=sa_mod.MAX_NOTES_LEN)


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _to_out(v: sa_mod.ServiceAccountView) -> ServiceAccountOut:
    return ServiceAccountOut(**v.__dict__)


def _parse_ts(raw: Optional[str], *, field: str) -> Optional[datetime]:
    if raw is None or raw == "":
        return None
    try:
        t = raw.replace("Z", "+00:00")
        dt = datetime.fromisoformat(t)
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field} must be an ISO-8601 timestamp",
        ) from exc
    if dt.tzinfo is not None:
        dt = dt.replace(tzinfo=None)
    return dt


@router.get("", response_model=ServiceAccountListOut)
def list_service_accounts(
    include_archived: bool = Query(False),
    status_filter: Optional[str] = Query(None, alias="status"),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> ServiceAccountListOut:
    try:
        entries = sa_mod.list_entries(
            tenant_id=tenant,
            include_archived=include_archived,
            status_filter=status_filter,
            limit=limit,
            offset=offset,
        )
    except sa_mod.ServiceAccountError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    active = sum(1 for e in entries if e.active)
    archived = sum(1 for e in entries if not e.active)
    return ServiceAccountListOut(
        tenant_id=tenant,
        active_count=active,
        archived_count=archived,
        rotation_overdue_count=sa_mod.rotation_overdue_count(tenant),
        review_overdue_count=sa_mod.review_overdue_count(tenant),
        entries=[_to_out(e) for e in entries],
    )


@router.get("/export.csv")
def export_service_accounts_csv(
    include_archived: bool = Query(False),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
):
    entries = sa_mod.list_entries(
        tenant_id=tenant,
        include_archived=include_archived,
        limit=500,
        offset=0,
    )
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([
        "id", "name", "kind", "system_of_record", "credential_kind",
        "owner_email", "scopes", "vault_managed", "rotation_cadence_days",
        "review_cadence_days", "last_rotated_at", "last_reviewed_at",
        "last_used_at", "next_rotation_due_at", "next_review_due_at",
        "rotation_overdue", "review_overdue", "dormant_days", "status",
        "notes", "version", "created_by", "created_at", "updated_by",
        "updated_at", "archived_by", "archived_at",
    ])
    for e in entries:
        w.writerow([
            e.id, e.name, e.kind, e.system_of_record, e.credential_kind,
            e.owner_email, " ".join(e.scopes),
            "yes" if e.vault_managed else "no",
            e.rotation_cadence_days, e.review_cadence_days,
            e.last_rotated_at or "", e.last_reviewed_at or "",
            e.last_used_at or "", e.next_rotation_due_at,
            e.next_review_due_at,
            "yes" if e.rotation_overdue else "no",
            "yes" if e.review_overdue else "no",
            "" if e.dormant_days is None else e.dormant_days,
            e.status, e.notes or "", e.version, e.created_by, e.created_at,
            e.updated_by or "", e.updated_at or "",
            e.archived_by or "", e.archived_at or "",
        ])
    data = buf.getvalue()
    fname = f"service-accounts-{tenant}.csv"
    return StreamingResponse(
        iter([data]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/{entry_id}", response_model=ServiceAccountOut)
def get_one(
    entry_id: int,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> ServiceAccountOut:
    v = sa_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if v is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    return _to_out(v)


@router.post("", response_model=ServiceAccountOut, status_code=201)
def create(
    body: CreateServiceAccountIn,
    request: Request,
    dry_run: bool = Query(False, description="Preview without persisting."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.service_accounts.create",
            principal=p,
            target=tenant,
            details={
                "name": body.name,
                "kind": body.kind,
                "system_of_record": body.system_of_record,
                "credential_kind": body.credential_kind,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="create_service_account",
            tenant_id=tenant,
            name=body.name,
            kind=body.kind,
            system_of_record=body.system_of_record,
        )
    try:
        view = sa_mod.create_entry(
            tenant_id=tenant,
            name=body.name,
            kind=body.kind,
            system_of_record=body.system_of_record,
            credential_kind=body.credential_kind,
            owner_email=body.owner_email,
            created_by=caller,
            scopes=body.scopes,
            vault_managed=body.vault_managed,
            rotation_cadence_days=body.rotation_cadence_days,
            review_cadence_days=body.review_cadence_days,
            last_rotated_at=_parse_ts(body.last_rotated_at, field="last_rotated_at"),
            last_reviewed_at=_parse_ts(body.last_reviewed_at, field="last_reviewed_at"),
            last_used_at=_parse_ts(body.last_used_at, field="last_used_at"),
            status=body.status,
            notes=body.notes,
        )
    except sa_mod.ServiceAccountError as exc:
        record_admin_action(
            action="workspace.service_accounts.create",
            principal=p,
            target=tenant,
            details={"name": body.name},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    record_admin_action(
        action="workspace.service_accounts.create",
        principal=p,
        target=tenant,
        details={
            "id": view.id,
            "name": view.name,
            "kind": view.kind,
            "system_of_record": view.system_of_record,
            "credential_kind": view.credential_kind,
            "owner_email": view.owner_email,
            "vault_managed": view.vault_managed,
            "scopes_count": len(view.scopes),
        },
        request_id=_rid(request),
    )
    log.info(
        "service_account_created",
        tenant=tenant,
        service_account_id=view.id,
        caller=caller,
    )
    return _to_out(view)


@router.put("/{entry_id}", response_model=ServiceAccountOut)
def update(
    entry_id: int,
    body: UpdateServiceAccountIn,
    request: Request,
    dry_run: bool = Query(False, description="Preview without persisting."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = sa_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if existing is None or not existing.active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    if dry_run:
        record_admin_action(
            action="workspace.service_accounts.update",
            principal=p,
            target=str(entry_id),
            details={
                "dry_run": True,
                "fields": [k for k, v in body.dict().items() if v is not None],
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="update_service_account",
            tenant_id=tenant,
            entry_id=entry_id,
        )
    try:
        view = sa_mod.update_entry(
            tenant_id=tenant,
            entry_id=entry_id,
            updated_by=caller,
            kind=body.kind,
            system_of_record=body.system_of_record,
            credential_kind=body.credential_kind,
            owner_email=body.owner_email,
            scopes=body.scopes,
            vault_managed=body.vault_managed,
            rotation_cadence_days=body.rotation_cadence_days,
            review_cadence_days=body.review_cadence_days,
            status=body.status,
            notes=body.notes,
        )
    except sa_mod.ServiceAccountError as exc:
        record_admin_action(
            action="workspace.service_accounts.update",
            principal=p,
            target=str(entry_id),
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    if view is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    record_admin_action(
        action="workspace.service_accounts.update",
        principal=p,
        target=str(entry_id),
        details={
            "version": view.version,
            "status": view.status,
            "vault_managed": view.vault_managed,
        },
        request_id=_rid(request),
    )
    return _to_out(view)


@router.post("/{entry_id}/rotate", response_model=ServiceAccountOut)
def rotate(
    entry_id: int,
    request: Request,
    dry_run: bool = Query(False, description="Preview without recording."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = sa_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if existing is None or not existing.active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    if dry_run:
        record_admin_action(
            action="workspace.service_accounts.rotate",
            principal=p,
            target=str(entry_id),
            details={"dry_run": True},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="record_service_account_rotation",
            tenant_id=tenant,
            entry_id=entry_id,
        )
    try:
        view = sa_mod.record_rotation(
            tenant_id=tenant, entry_id=entry_id, rotated_by=caller
        )
    except sa_mod.ServiceAccountError as exc:
        record_admin_action(
            action="workspace.service_accounts.rotate",
            principal=p,
            target=str(entry_id),
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    if view is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    record_admin_action(
        action="workspace.service_accounts.rotate",
        principal=p,
        target=str(entry_id),
        details={
            "version": view.version,
            "last_rotated_at": view.last_rotated_at,
            "next_rotation_due_at": view.next_rotation_due_at,
        },
        request_id=_rid(request),
    )
    log.info(
        "service_account_rotated",
        tenant=tenant,
        service_account_id=entry_id,
        caller=caller,
    )
    return _to_out(view)


@router.post("/{entry_id}/review", response_model=ServiceAccountOut)
def review(
    entry_id: int,
    request: Request,
    dry_run: bool = Query(False, description="Preview without recording."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = sa_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if existing is None or not existing.active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    if dry_run:
        record_admin_action(
            action="workspace.service_accounts.review",
            principal=p,
            target=str(entry_id),
            details={"dry_run": True},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="record_service_account_review",
            tenant_id=tenant,
            entry_id=entry_id,
        )
    view = sa_mod.record_review(
        tenant_id=tenant, entry_id=entry_id, reviewed_by=caller
    )
    if view is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    record_admin_action(
        action="workspace.service_accounts.review",
        principal=p,
        target=str(entry_id),
        details={
            "version": view.version,
            "last_reviewed_at": view.last_reviewed_at,
            "next_review_due_at": view.next_review_due_at,
        },
        request_id=_rid(request),
    )
    return _to_out(view)


@router.post("/{entry_id}/archive", response_model=ServiceAccountOut)
def archive(
    entry_id: int,
    request: Request,
    dry_run: bool = Query(False, description="Preview without archiving."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    existing = sa_mod.get_entry(tenant_id=tenant, entry_id=entry_id)
    if existing is None:
        record_admin_action(
            action="workspace.service_accounts.archive",
            principal=p,
            target=str(entry_id),
            details={"dry_run": dry_run},
            ok=False,
            error="not found",
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not found"
        )
    if not existing.active:
        record_admin_action(
            action="workspace.service_accounts.archive",
            principal=p,
            target=str(entry_id),
            details={"dry_run": dry_run},
            ok=False,
            error="already archived",
            request_id=_rid(request),
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="entry already archived",
        )
    if dry_run:
        record_admin_action(
            action="workspace.service_accounts.archive",
            principal=p,
            target=str(entry_id),
            details={"dry_run": True},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="archive_service_account",
            tenant_id=tenant,
            entry_id=entry_id,
        )
    view = sa_mod.archive_entry(
        tenant_id=tenant, entry_id=entry_id, archived_by=caller
    )
    if view is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="entry not found or already archived",
        )
    record_admin_action(
        action="workspace.service_accounts.archive",
        principal=p,        target=str(entry_id),
        request_id=_rid(request),
    )
    log.info(
        "service_account_archived",
        tenant=tenant,
        service_account_id=entry_id,
        caller=caller,
    )
    return _to_out(view)
