"""Legal document publication and per-workspace acceptance.

Operator-published Terms of Service / Data Processing Agreement /
Privacy Policy versions live in ``legal_documents``. Per-workspace
acceptance events live in ``legal_acceptances``. Mutating traffic is
gated by :class:`LegalAcceptanceMiddleware` until the workspace has
accepted the current gating documents (TOS + DPA).

Routes
~~~~~~
Public, scope-exempt (so a stuck tenant can read what to accept):

* ``GET  /v1/legal/documents``         list published versions
* ``GET  /v1/legal/documents/{kind}/{version}``  fetch one version with body
* ``GET  /v1/legal/outstanding``       what this workspace still owes
* ``GET  /v1/legal/acceptances``       this workspace's acceptance log (viewer+)
* ``POST /v1/legal/accept``            record acceptance (admin only)

Operator-only (publishing a new version):

* ``POST /v1/legal/documents``         publish (admin only, currently
                                       operator-equivalent in the
                                       deployment-default tenant)

Every acceptance is mirrored into the admin audit log with caller, IP,
user-agent, and request id. Acceptances are append-only via the unique
constraint on ``(tenant_id, kind, version, subject)``; a repeated click
returns the original row instead of erroring.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from adherence_common import legal_acceptance as la
from adherence_common.admin_audit import record_admin_action

from adherence_api.deps import current_principal, current_tenant, require_admin, require_viewer

router = APIRouter(prefix="/v1/legal", tags=["legal"])


# ---------------------------------------------------------------------------
# Response / request schemas
# ---------------------------------------------------------------------------


class DocumentSummary(BaseModel):
    id: int
    kind: str
    version: str
    title: str
    sha256: str
    effective_at: str
    created_at: str
    created_by: Optional[str] = None


class DocumentDetail(DocumentSummary):
    body: str


class DocumentListResponse(BaseModel):
    count: int
    documents: list[DocumentSummary]


class PublishDocumentRequest(BaseModel):
    kind: str = Field(..., description="One of tos | dpa | privacy")
    version: str = Field(..., min_length=1, max_length=32)
    title: str = Field(..., min_length=1, max_length=255)
    body: str = Field(..., min_length=1)
    effective_at: Optional[str] = Field(
        None,
        description="ISO-8601 UTC timestamp; defaults to publication time",
    )


class AcceptanceResponse(BaseModel):
    id: int
    tenant_id: str
    kind: str
    version: str
    sha256: str
    subject: str
    subject_role: str
    accepted_at: str
    ip: Optional[str] = None
    user_agent: Optional[str] = None
    request_id: Optional[str] = None


class AcceptanceListResponse(BaseModel):
    tenant_id: str
    count: int
    acceptances: list[AcceptanceResponse]


class AcceptRequest(BaseModel):
    kind: str = Field(..., description="One of tos | dpa | privacy")
    version: str = Field(..., min_length=1, max_length=32)
    sha256: Optional[str] = Field(
        None,
        description=(
            "Optional sha256 of the document body the caller saw. "
            "If supplied it must match the stored version, proving the "
            "body has not silently changed under the same version label."
        ),
    )


class OutstandingItem(BaseModel):
    kind: str
    version: str
    title: str
    sha256: str
    effective_at: str


class OutstandingResponse(BaseModel):
    tenant_id: str
    blocked: bool
    outstanding: list[OutstandingItem]


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


def _doc_to_summary(view: la.DocumentView) -> DocumentSummary:
    return DocumentSummary(
        id=view.id,
        kind=view.kind,
        version=view.version,
        title=view.title,
        sha256=view.sha256,
        effective_at=view.effective_at.isoformat(),
        created_at=view.created_at.isoformat(),
        created_by=view.created_by,
    )


def _doc_to_detail(view: la.DocumentView) -> DocumentDetail:
    return DocumentDetail(
        id=view.id,
        kind=view.kind,
        version=view.version,
        title=view.title,
        sha256=view.sha256,
        effective_at=view.effective_at.isoformat(),
        created_at=view.created_at.isoformat(),
        created_by=view.created_by,
        body=(view.body or ""),
    )


def _acc_to_resp(view: la.AcceptanceView) -> AcceptanceResponse:
    return AcceptanceResponse(
        id=view.id,
        tenant_id=view.tenant_id,
        kind=view.kind,
        version=view.version,
        sha256=view.sha256,
        subject=view.subject,
        subject_role=view.subject_role,
        accepted_at=view.accepted_at.isoformat(),
        ip=view.ip,
        user_agent=view.user_agent,
        request_id=view.request_id,
    )


# ---------------------------------------------------------------------------
# Document endpoints
# ---------------------------------------------------------------------------


@router.get("/documents", response_model=DocumentListResponse)
def list_documents(
    kind: Optional[str] = None,
    _p=Depends(require_viewer),
) -> DocumentListResponse:
    try:
        rows = la.list_documents(kind=kind, include_body=False)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    return DocumentListResponse(
        count=len(rows), documents=[_doc_to_summary(r) for r in rows]
    )


@router.get("/documents/{kind}/{version}", response_model=DocumentDetail)
def get_document(
    kind: str,
    version: str,
    _p=Depends(require_viewer),
) -> DocumentDetail:
    try:
        view = la.get_document(kind, version)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    if view is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "legal document not found")
    return _doc_to_detail(view)


@router.post(
    "/documents",
    response_model=DocumentDetail,
    status_code=status.HTTP_201_CREATED,
)
def publish_document(
    body: PublishDocumentRequest,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
) -> DocumentDetail:
    eff = None
    if body.effective_at:
        from datetime import datetime
        try:
            eff = datetime.fromisoformat(body.effective_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"invalid effective_at: {exc}",
            )
    try:
        view = la.publish_document(
            kind=body.kind,
            version=body.version,
            title=body.title,
            body=body.body,
            effective_at=eff,
            created_by=str(p.get("sub") or p.get("key_name") or ""),
        )
    except la.DuplicateDocument as exc:
        record_admin_action(
            action="legal.document.publish", principal=p,
            target=f"{body.kind}:{body.version}",
            details={"title": body.title}, ok=False, error=str(exc),
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc))
    except ValueError as exc:
        record_admin_action(
            action="legal.document.publish", principal=p,
            target=f"{body.kind}:{body.version}",
            details=None, ok=False, error=str(exc),
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))

    record_admin_action(
        action="legal.document.publish", principal=p,
        target=f"{view.kind}:{view.version}",
        details={
            "title": view.title,
            "sha256": view.sha256,
            "effective_at": view.effective_at.isoformat(),
        },
        ok=True, request_id=_rid(request), tenant_id=tenant,
    )
    return _doc_to_detail(view)


# ---------------------------------------------------------------------------
# Acceptance endpoints
# ---------------------------------------------------------------------------


@router.get("/outstanding", response_model=OutstandingResponse)
def outstanding(
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> OutstandingResponse:
    items = la.outstanding_kinds(tenant)
    return OutstandingResponse(
        tenant_id=tenant,
        blocked=bool(items),
        outstanding=[OutstandingItem(**it) for it in items],
    )


@router.get("/acceptances", response_model=AcceptanceListResponse)
def list_acceptances(
    kind: Optional[str] = None,
    limit: int = 200,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> AcceptanceListResponse:
    try:
        rows = la.list_acceptances(tenant, kind=kind, limit=limit)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    return AcceptanceListResponse(
        tenant_id=tenant, count=len(rows),
        acceptances=[_acc_to_resp(r) for r in rows],
    )


@router.post(
    "/accept",
    response_model=AcceptanceResponse,
    status_code=status.HTTP_201_CREATED,
)
def accept(
    body: AcceptRequest,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
) -> AcceptanceResponse:
    subject = str(p.get("sub") or p.get("key_name") or "")
    role = str(p.get("role") or "viewer")
    ip = _client_ip(request)
    ua = request.headers.get("user-agent", "")
    rid = _rid(request)

    try:
        view = la.record_acceptance(
            tenant_id=tenant,
            kind=body.kind,
            version=body.version,
            subject=subject,
            subject_role=role,
            sha256=body.sha256,
            ip=ip,
            user_agent=ua,
            request_id=rid,
        )
    except la.UnknownDocument as exc:
        record_admin_action(
            action="legal.accept", principal=p,
            target=f"{body.kind}:{body.version}",
            details={"sha256_supplied": body.sha256},
            ok=False, error=str(exc),
            request_id=rid, tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc))
    except la.DocumentMismatch as exc:
        record_admin_action(
            action="legal.accept", principal=p,
            target=f"{body.kind}:{body.version}",
            details={"sha256_supplied": body.sha256},
            ok=False, error=str(exc),
            request_id=rid, tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc))
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))

    record_admin_action(
        action="legal.accept", principal=p,
        target=f"{view.kind}:{view.version}",
        details={
            "sha256": view.sha256,
            "subject": view.subject,
            "subject_role": view.subject_role,
        },
        ok=True, request_id=rid, tenant_id=tenant,
    )
    return _acc_to_resp(view)
