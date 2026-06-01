"""Vendor security questionnaire (CAIQ Lite) endpoints.

Procurement reviewers receive a machine-readable answer set without
authenticating, and workspace admins can pin per-tenant overrides
(eg a contractual region lock or BAA reference) without forking the
canonical document.

Routes
~~~~~~
Public read (no auth required):

* ``GET /v1/caiq``                              canonical CAIQ Lite manifest

Workspace read (viewer+):

* ``GET    /v1/caiq/overrides``                 list this workspace's overrides
* ``GET    /v1/caiq/resolved``                  canonical + overrides merged

Workspace write (admin):

* ``PUT    /v1/caiq/overrides/{question_id}``   create or replace one override
* ``DELETE /v1/caiq/overrides/{question_id}``   remove one override

Every write logs to the hash-chained admin_audit log with caller, IP,
user-agent, request id, and the before/after answer pair.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from adherence_common import caiq
from adherence_common.admin_audit import record_admin_action

from adherence_api.deps import (
    current_principal,
    current_tenant,
    require_admin,
    require_viewer,
)

router = APIRouter(prefix="/v1/caiq", tags=["caiq"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class QuestionOut(BaseModel):
    id: str
    domain: str
    question: str
    answer: str
    note: str
    evidence: str


class CanonicalManifestOut(BaseModel):
    schema_version: str
    framework: str
    question_count: int
    questions: list[QuestionOut]


class OverrideOut(BaseModel):
    tenant_id: str
    question_id: str
    answer: str
    note: Optional[str] = None
    updated_at: str
    updated_by: Optional[str] = None


class OverrideListResponse(BaseModel):
    tenant_id: str
    count: int
    overrides: list[OverrideOut]


class ResolvedEntry(BaseModel):
    id: str
    domain: str
    question: str
    answer: str
    note: str
    evidence: str
    override: Optional[dict] = None


class ResolvedManifestOut(BaseModel):
    schema_version: str
    framework: str
    question_count: int
    tenant_id: str
    override_count: int
    questions: list[ResolvedEntry]


class OverrideRequest(BaseModel):
    answer: str = Field(..., description="one of yes, no, na, partial")
    note: Optional[str] = Field(None, max_length=4096)


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


def _ov_out(v: caiq.OverrideView) -> OverrideOut:
    return OverrideOut(
        tenant_id=v.tenant_id,
        question_id=v.question_id,
        answer=v.answer,
        note=v.note,
        updated_at=v.updated_at.isoformat(),
        updated_by=v.updated_by,
    )


# ---------------------------------------------------------------------------
# Public canonical manifest
# ---------------------------------------------------------------------------


@router.get(
    "",
    response_model=CanonicalManifestOut,
    summary="Canonical CAIQ Lite answers (public)",
)
def canonical() -> CanonicalManifestOut:
    """Unauthenticated. Same content for every caller."""
    return CanonicalManifestOut(**caiq.canonical_manifest())


# ---------------------------------------------------------------------------
# Workspace-scoped reads
# ---------------------------------------------------------------------------


@router.get("/overrides", response_model=OverrideListResponse)
def list_overrides(
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> OverrideListResponse:
    rows = caiq.list_overrides(tenant)
    return OverrideListResponse(
        tenant_id=tenant,
        count=len(rows),
        overrides=[_ov_out(r) for r in rows],
    )


@router.get("/resolved", response_model=ResolvedManifestOut)
def resolved(
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> ResolvedManifestOut:
    payload = caiq.resolved_manifest(tenant)
    return ResolvedManifestOut(**payload)


# ---------------------------------------------------------------------------
# Workspace writes (admin)
# ---------------------------------------------------------------------------


@router.put(
    "/overrides/{question_id}",
    response_model=OverrideOut,
    status_code=status.HTTP_200_OK,
)
def upsert_override(
    question_id: str,
    body: OverrideRequest,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
) -> OverrideOut:
    subject = str(p.get("sub") or p.get("key_name") or "")
    # Snapshot the previous state for the audit details (before/after).
    before: Optional[caiq.OverrideView] = None
    for ov in caiq.list_overrides(tenant):
        if ov.question_id == question_id:
            before = ov
            break
    try:
        view = caiq.set_override(
            tenant_id=tenant,
            question_id=question_id,
            answer=body.answer,
            note=body.note,
            updated_by=subject,
        )
    except caiq.UnknownQuestion as exc:
        record_admin_action(
            action="caiq.override.upsert", principal=p,
            target=f"question:{question_id}",
            details={"question_id": question_id},
            ok=False, error=f"unknown question: {exc}",
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"unknown question: {question_id}")
    except ValueError as exc:
        record_admin_action(
            action="caiq.override.upsert", principal=p,
            target=f"question:{question_id}",
            details={"answer": body.answer},
            ok=False, error=str(exc),
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    record_admin_action(
        action="caiq.override.upsert", principal=p,
        target=f"question:{question_id}",
        details={
            "question_id": question_id,
            "before": (
                {"answer": before.answer, "note": before.note} if before else None
            ),
            "after": {"answer": view.answer, "note": view.note},
        },
        ok=True, request_id=_rid(request), tenant_id=tenant,
    )
    return _ov_out(view)


@router.delete(
    "/overrides/{question_id}",
    status_code=status.HTTP_200_OK,
)
def delete_override(
    question_id: str,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
) -> dict:
    before: Optional[caiq.OverrideView] = None
    for ov in caiq.list_overrides(tenant):
        if ov.question_id == question_id:
            before = ov
            break
    removed = caiq.clear_override(tenant_id=tenant, question_id=question_id)
    record_admin_action(
        action="caiq.override.delete", principal=p,
        target=f"question:{question_id}",
        details={
            "question_id": question_id,
            "before": (
                {"answer": before.answer, "note": before.note} if before else None
            ),
            "removed": removed,
        },
        ok=True, request_id=_rid(request), tenant_id=tenant,
    )
    return {"removed": removed, "question_id": question_id}
