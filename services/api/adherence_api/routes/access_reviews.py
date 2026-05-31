"""/v1/admin/access-reviews: per-tenant periodic access review.

SOC2 CC6.3 and ISO 27001 A.9.2.5 require evidence that customer
workspace owners periodically re-certify who has access. This router
exposes that ceremony as REST:

* ``POST   /v1/admin/access-reviews`` opens a review and snapshots
  every current workspace member as a pending item.
* ``GET    /v1/admin/access-reviews`` lists reviews for the caller's
  workspace.
* ``GET    /v1/admin/access-reviews/{id}`` returns one review.
* ``GET    /v1/admin/access-reviews/{id}/items`` lists items.
* ``POST   /v1/admin/access-reviews/{id}/items/{item_id}/decide``
  records a keep / change / revoke decision.
* ``POST   /v1/admin/access-reviews/{id}/close`` closes the review
  and applies every decided change to the membership table.
* ``POST   /v1/admin/access-reviews/{id}/cancel`` aborts an open
  review without touching memberships.

Mutations require admin role *and* an active MFA challenge, mirroring
the legal hold and retention policy patterns. Every mutation writes
an admin audit row. All queries are strictly tenant-scoped.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import current_tenant, require_admin, require_viewer
from adherence_api.dry_run import dry_run_response
from adherence_api.routes.admin_mfa import require_admin_mfa
from adherence_common import access_reviews as ar_mod
from adherence_common.admin_audit import record_admin_action
from adherence_common.logging import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/v1/admin/access-reviews", tags=["access-reviews"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ReviewOut(BaseModel):
    id: int
    tenant_id: str
    label: str | None
    reason: str
    opened_by: str
    opened_at: str
    closed_by: str | None
    closed_at: str | None
    close_summary: str | None
    state: str
    item_count: int
    decided_count: int
    pending_count: int


class ItemOut(BaseModel):
    id: int
    review_id: int
    tenant_id: str
    subject: str
    current_role: str
    decision: str | None
    new_role: str | None
    note: str | None
    decided_by: str | None
    decided_at: str | None
    state: str
    applied: bool


class ReviewListOut(BaseModel):
    tenant_id: str
    reviews: list[ReviewOut]


class ItemListOut(BaseModel):
    tenant_id: str
    review_id: int
    items: list[ItemOut]


class OpenReviewIn(BaseModel):
    reason: str = Field(
        ...,
        min_length=ar_mod.MIN_REASON_LEN,
        max_length=ar_mod.MAX_REASON_LEN,
        description="Why this review is being run (audit, quarterly, off-boarding).",
    )
    label: str | None = Field(None, max_length=ar_mod.MAX_LABEL_LEN)


class DecideIn(BaseModel):
    decision: str = Field(
        ..., description="One of: keep, change, revoke."
    )
    new_role: str | None = Field(
        None, description="Required when decision='change'."
    )
    note: str | None = Field(None, max_length=ar_mod.MAX_NOTE_LEN)


class CloseIn(BaseModel):
    summary: str | None = Field(None, max_length=ar_mod.MAX_REASON_LEN)


class CancelIn(BaseModel):
    reason: str | None = Field(None, max_length=ar_mod.MAX_REASON_LEN)


class CloseResultOut(BaseModel):
    review: ReviewOut
    applied: list[dict]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _to_review_out(v: ar_mod.AccessReviewView) -> ReviewOut:
    return ReviewOut(**v.__dict__)


def _to_item_out(v: ar_mod.AccessReviewItemView) -> ItemOut:
    return ItemOut(**v.__dict__)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=ReviewListOut)
def list_reviews(
    state: str | None = Query(None, description="Filter: open|closed|cancelled."),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> ReviewListOut:
    try:
        rows = ar_mod.list_reviews(
            tenant_id=tenant, state=state, limit=limit, offset=offset
        )
    except ar_mod.AccessReviewError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ReviewListOut(tenant_id=tenant, reviews=[_to_review_out(r) for r in rows])


@router.get("/{review_id}", response_model=ReviewOut)
def get_review(
    review_id: int,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> ReviewOut:
    view = ar_mod.get_review(tenant_id=tenant, review_id=review_id)
    if view is None:
        raise HTTPException(status_code=404, detail="review not found")
    return _to_review_out(view)


@router.get("/{review_id}/items", response_model=ItemListOut)
def list_items(
    review_id: int,
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> ItemListOut:
    # Verify the review exists in this tenant first so cross-tenant
    # probes get 404 instead of an empty list.
    view = ar_mod.get_review(tenant_id=tenant, review_id=review_id)
    if view is None:
        raise HTTPException(status_code=404, detail="review not found")
    items = ar_mod.list_items(tenant_id=tenant, review_id=review_id)
    return ItemListOut(
        tenant_id=tenant,
        review_id=review_id,
        items=[_to_item_out(i) for i in items],
    )


@router.post("", response_model=ReviewOut, status_code=201)
def open_review(
    body: OpenReviewIn,
    request: Request,
    dry_run: bool = Query(False, description="Preview without persisting."),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="workspace.access_review.open",
            principal=p,
            target=tenant,
            details={"label": body.label, "dry_run": True},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="open_access_review",
            tenant_id=tenant,
            label=body.label,
        )
    try:
        view = ar_mod.open_review(
            tenant_id=tenant,
            reason=body.reason,
            opened_by=caller,
            label=body.label,
        )
    except ar_mod.AccessReviewError as exc:
        record_admin_action(
            action="workspace.access_review.open",
            principal=p,
            target=tenant,
            details={"label": body.label},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    record_admin_action(
        action="workspace.access_review.open",
        principal=p,
        target=tenant,
        details={
            "id": view.id,
            "label": view.label,
            "item_count": view.item_count,
        },
        request_id=_rid(request),
    )
    log.info(
        "access_review_opened",
        tenant=tenant,
        review_id=view.id,
        caller=caller,
        items=view.item_count,
        request_id=_rid(request),
    )
    return _to_review_out(view)


@router.post(
    "/{review_id}/items/{item_id}/decide", response_model=ItemOut
)
def decide_item(
    review_id: int,
    item_id: int,
    body: DecideIn,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    try:
        view = ar_mod.decide_item(
            tenant_id=tenant,
            review_id=review_id,
            item_id=item_id,
            decision=body.decision,
            decided_by=caller,
            new_role=body.new_role,
            note=body.note,
        )
    except ar_mod.AccessReviewError as exc:
        msg = str(exc)
        record_admin_action(
            action="workspace.access_review.decide",
            principal=p,
            target=f"{review_id}/{item_id}",
            details={"decision": body.decision, "new_role": body.new_role},
            ok=False,
            error=msg,
            request_id=_rid(request),
        )
        status_code = 404 if "not found" in msg else 400
        raise HTTPException(status_code=status_code, detail=msg) from exc
    record_admin_action(
        action="workspace.access_review.decide",
        principal=p,
        target=f"{review_id}/{item_id}",
        details={
            "subject": view.subject,
            "decision": view.decision,
            "new_role": view.new_role,
        },
        request_id=_rid(request),
    )
    return _to_item_out(view)


@router.post("/{review_id}/close")
def close_review(
    review_id: int,
    body: CloseIn,
    request: Request,
    dry_run: bool = Query(
        False, description="Preview applied changes without persisting."
    ),
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        # Surface what would be applied if we closed now, by reading items.
        view = ar_mod.get_review(tenant_id=tenant, review_id=review_id)
        if view is None:
            raise HTTPException(status_code=404, detail="review not found")
        items = ar_mod.list_items(tenant_id=tenant, review_id=review_id)
        record_admin_action(
            action="workspace.access_review.close",
            principal=p,
            target=str(review_id),
            details={"dry_run": True},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="close_access_review",
            tenant_id=tenant,
            review_id=review_id,
            pending=[i.subject for i in items if i.state != "decided"],
            would_apply=[
                {
                    "subject": i.subject,
                    "decision": i.decision,
                    "new_role": i.new_role,
                }
                for i in items
                if i.decision in ("change", "revoke")
            ],
        )
    try:
        result = ar_mod.close_review(
            tenant_id=tenant,
            review_id=review_id,
            closed_by=caller,
            summary=body.summary,
        )
    except ar_mod.AccessReviewError as exc:
        msg = str(exc)
        record_admin_action(
            action="workspace.access_review.close",
            principal=p,
            target=str(review_id),
            details={"summary": body.summary},
            ok=False,
            error=msg,
            request_id=_rid(request),
        )
        status_code = 404 if "not found" in msg else 400
        raise HTTPException(status_code=status_code, detail=msg) from exc
    # Per-decision admin audit so each membership change is independently
    # traceable in the audit log, not just the close event itself.
    for subject, decision, detail in result.applied:
        if decision == "keep":
            continue
        record_admin_action(
            action=f"workspace.access_review.apply.{decision}",
            principal=p,
            target=f"{review_id}:{subject}",
            details={"detail": detail},
            request_id=_rid(request),
        )
    record_admin_action(
        action="workspace.access_review.close",
        principal=p,
        target=str(review_id),
        details={
            "applied": len([1 for _, d, _ in result.applied if d != "keep"]),
            "summary": body.summary,
        },
        request_id=_rid(request),
    )
    log.warning(
        "access_review_closed",
        tenant=tenant,
        review_id=review_id,
        caller=caller,
        request_id=_rid(request),
    )
    return CloseResultOut(
        review=_to_review_out(result.review),
        applied=[
            {"subject": s, "decision": d, "detail": x}
            for (s, d, x) in result.applied
        ],
    )


@router.post("/{review_id}/cancel", response_model=ReviewOut)
def cancel_review(
    review_id: int,
    body: CancelIn,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
):
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    try:
        view = ar_mod.cancel_review(
            tenant_id=tenant,
            review_id=review_id,
            cancelled_by=caller,
            reason=body.reason,
        )
    except ar_mod.AccessReviewError as exc:
        msg = str(exc)
        record_admin_action(
            action="workspace.access_review.cancel",
            principal=p,
            target=str(review_id),
            details={"reason": body.reason},
            ok=False,
            error=msg,
            request_id=_rid(request),
        )
        status_code = 404 if "not found" in msg else 400
        raise HTTPException(status_code=status_code, detail=msg) from exc
    record_admin_action(
        action="workspace.access_review.cancel",
        principal=p,
        target=str(review_id),
        details={"reason": body.reason},
        request_id=_rid(request),
    )
    return _to_review_out(view)
