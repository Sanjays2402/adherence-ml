"""Per-tenant periodic access reviews (SOC2 / ISO 27001 CC6.3).

Enterprise procurement and security questionnaires almost always ask:
"how do you periodically certify that members of a customer workspace
still need their access?" This module is the answer.

Semantics
---------

* An :class:`AccessReview` row is opened by an admin (with active MFA).
  At creation we snapshot every current member of the workspace as a
  :class:`AccessReviewItem` in ``state='pending'``.
* The admin then certifies each item one of:
    - ``keep``    — member stays at current role.
    - ``change``  — member's role is updated to ``new_role`` on close.
    - ``revoke``  — member is removed from the workspace on close.
* Closing the review requires every item to be decided. On close we
  apply ``change`` and ``revoke`` decisions to the live membership
  table, write one admin audit row per applied decision, and freeze
  the review (``state='closed'``). Closed reviews are append-only.
* Tenant scoping is strict: reviews and items both carry
  ``tenant_id``; every query filters on the caller's tenant.

The model is registered with :mod:`adherence_common.db` via the
``init_db`` import block, mirroring the legal_hold pattern.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    select,
)

from adherence_common.db import Base, session
from adherence_common.memberships import (
    ROLES as MEMBER_ROLES,
    list_members,
    remove_member,
    upsert_member,
)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

MIN_REASON_LEN = 5
MAX_REASON_LEN = 4096
MAX_LABEL_LEN = 128
MAX_NOTE_LEN = 1024

VALID_DECISIONS: frozenset[str] = frozenset({"keep", "change", "revoke"})
ITEM_STATES: frozenset[str] = frozenset({"pending", "decided"})
REVIEW_STATES: frozenset[str] = frozenset({"open", "closed", "cancelled"})


class AccessReviewError(ValueError):
    """Raised when an access review input is invalid."""


# ---------------------------------------------------------------------------
# Tables
# ---------------------------------------------------------------------------


class AccessReview(Base):
    __tablename__ = "access_reviews"

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    label = Column(String(MAX_LABEL_LEN), nullable=True)
    reason = Column(Text, nullable=False)
    opened_by = Column(String(128), nullable=False)
    opened_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    closed_by = Column(String(128), nullable=True)
    closed_at = Column(DateTime, nullable=True)
    close_summary = Column(Text, nullable=True)
    state = Column(String(16), nullable=False, default="open")


class AccessReviewItem(Base):
    __tablename__ = "access_review_items"
    __table_args__ = (
        UniqueConstraint(
            "review_id", "subject_lower", name="uq_review_subject"
        ),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    review_id = Column(
        Integer, ForeignKey("access_reviews.id"), index=True, nullable=False
    )
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    subject = Column(String(256), nullable=False)
    subject_lower = Column(String(256), index=True, nullable=False)
    current_role = Column(String(16), nullable=False)
    decision = Column(String(16), nullable=True)
    new_role = Column(String(16), nullable=True)
    note = Column(Text, nullable=True)
    decided_by = Column(String(128), nullable=True)
    decided_at = Column(DateTime, nullable=True)
    applied = Column(Integer, nullable=False, default=0)  # 0/1
    state = Column(String(16), nullable=False, default="pending")


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AccessReviewItemView:
    id: int
    review_id: int
    tenant_id: str
    subject: str
    current_role: str
    decision: Optional[str]
    new_role: Optional[str]
    note: Optional[str]
    decided_by: Optional[str]
    decided_at: Optional[str]
    state: str
    applied: bool


@dataclass(frozen=True)
class AccessReviewView:
    id: int
    tenant_id: str
    label: Optional[str]
    reason: str
    opened_by: str
    opened_at: str
    closed_by: Optional[str]
    closed_at: Optional[str]
    close_summary: Optional[str]
    state: str
    item_count: int
    decided_count: int
    pending_count: int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    return dt.isoformat()


def _norm_subject(s: str) -> str:
    return (s or "").strip().lower()


def _clean(s: Optional[str], *, max_len: int) -> Optional[str]:
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    if len(t) > max_len:
        raise AccessReviewError(f"value too long (max {max_len})")
    return t


def _validate_reason(raw: Optional[str]) -> str:
    if raw is None:
        raise AccessReviewError("reason is required")
    s = str(raw).strip()
    if len(s) < MIN_REASON_LEN:
        raise AccessReviewError(
            f"reason must be at least {MIN_REASON_LEN} characters"
        )
    if len(s) > MAX_REASON_LEN:
        raise AccessReviewError(
            f"reason must be at most {MAX_REASON_LEN} characters"
        )
    return s


def _to_review_view(
    row: AccessReview,
    item_count: int,
    decided_count: int,
) -> AccessReviewView:
    return AccessReviewView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        label=row.label,
        reason=str(row.reason),
        opened_by=str(row.opened_by),
        opened_at=_iso(row.opened_at) or "",
        closed_by=row.closed_by,
        closed_at=_iso(row.closed_at),
        close_summary=row.close_summary,
        state=str(row.state),
        item_count=item_count,
        decided_count=decided_count,
        pending_count=max(0, item_count - decided_count),
    )


def _to_item_view(row: AccessReviewItem) -> AccessReviewItemView:
    return AccessReviewItemView(
        id=int(row.id),
        review_id=int(row.review_id),
        tenant_id=str(row.tenant_id),
        subject=str(row.subject),
        current_role=str(row.current_role),
        decision=row.decision,
        new_role=row.new_role,
        note=row.note,
        decided_by=row.decided_by,
        decided_at=_iso(row.decided_at),
        state=str(row.state),
        applied=bool(row.applied),
    )


# ---------------------------------------------------------------------------
# Core API
# ---------------------------------------------------------------------------


def open_review(
    *,
    tenant_id: str,
    reason: str,
    opened_by: str,
    label: Optional[str] = None,
) -> AccessReviewView:
    """Create a new open review and snapshot current workspace members."""
    tid = (tenant_id or "default").strip() or "default"
    cleaned_reason = _validate_reason(reason)
    cleaned_label = _clean(label, max_len=MAX_LABEL_LEN)
    actor = (opened_by or "").strip() or "unknown"

    members = list_members(tid)
    if not members:
        raise AccessReviewError(
            "workspace has no members to review; invite members first"
        )

    with session() as db:
        review = AccessReview(
            tenant_id=tid,
            label=cleaned_label,
            reason=cleaned_reason,
            opened_by=actor,
            state="open",
        )
        db.add(review)
        db.flush()
        for m in members:
            db.add(
                AccessReviewItem(
                    review_id=review.id,
                    tenant_id=tid,
                    subject=m.subject,
                    subject_lower=_norm_subject(m.subject),
                    current_role=m.role,
                    state="pending",
                )
            )
        db.commit()
        db.refresh(review)
        item_count = len(members)
        return _to_review_view(review, item_count=item_count, decided_count=0)


def _counts(db, review_id: int) -> tuple[int, int]:
    items = db.execute(
        select(AccessReviewItem).where(AccessReviewItem.review_id == review_id)
    ).scalars().all()
    return len(items), sum(1 for i in items if i.state == "decided")


def list_reviews(
    *,
    tenant_id: str,
    state: Optional[str] = None,
    limit: int = 200,
    offset: int = 0,
) -> list[AccessReviewView]:
    tid = (tenant_id or "default").strip() or "default"
    if state is not None and state not in REVIEW_STATES:
        raise AccessReviewError(f"invalid state filter: {state}")
    with session() as db:
        q = select(AccessReview).where(AccessReview.tenant_id == tid)
        if state is not None:
            q = q.where(AccessReview.state == state)
        q = q.order_by(AccessReview.opened_at.desc()).limit(limit).offset(offset)
        rows = db.execute(q).scalars().all()
        out: list[AccessReviewView] = []
        for r in rows:
            n, d = _counts(db, int(r.id))
            out.append(_to_review_view(r, item_count=n, decided_count=d))
        return out


def get_review(*, tenant_id: str, review_id: int) -> Optional[AccessReviewView]:
    tid = (tenant_id or "default").strip() or "default"
    with session() as db:
        row = db.execute(
            select(AccessReview).where(
                AccessReview.tenant_id == tid,
                AccessReview.id == review_id,
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        n, d = _counts(db, int(row.id))
        return _to_review_view(row, item_count=n, decided_count=d)


def list_items(
    *, tenant_id: str, review_id: int
) -> list[AccessReviewItemView]:
    tid = (tenant_id or "default").strip() or "default"
    with session() as db:
        # Ensure the review belongs to this tenant before returning items.
        review = db.execute(
            select(AccessReview).where(
                AccessReview.tenant_id == tid,
                AccessReview.id == review_id,
            )
        ).scalar_one_or_none()
        if review is None:
            return []
        rows = db.execute(
            select(AccessReviewItem)
            .where(
                AccessReviewItem.review_id == review_id,
                AccessReviewItem.tenant_id == tid,
            )
            .order_by(AccessReviewItem.subject_lower.asc())
        ).scalars().all()
        return [_to_item_view(r) for r in rows]


def decide_item(
    *,
    tenant_id: str,
    review_id: int,
    item_id: int,
    decision: str,
    decided_by: str,
    new_role: Optional[str] = None,
    note: Optional[str] = None,
) -> AccessReviewItemView:
    tid = (tenant_id or "default").strip() or "default"
    d = (decision or "").strip().lower()
    if d not in VALID_DECISIONS:
        raise AccessReviewError(
            f"invalid decision: {decision!r} (allowed: keep|change|revoke)"
        )
    nr = None
    if d == "change":
        if not new_role:
            raise AccessReviewError("new_role is required when decision='change'")
        nr = new_role.strip().lower()
        if nr not in MEMBER_ROLES:
            raise AccessReviewError(
                f"invalid new_role: {new_role!r} (allowed: {sorted(MEMBER_ROLES)})"
            )
    cleaned_note = _clean(note, max_len=MAX_NOTE_LEN)
    actor = (decided_by or "").strip() or "unknown"

    with session() as db:
        review = db.execute(
            select(AccessReview).where(
                AccessReview.tenant_id == tid, AccessReview.id == review_id
            )
        ).scalar_one_or_none()
        if review is None:
            raise AccessReviewError("review not found")
        if review.state != "open":
            raise AccessReviewError(
                f"review is {review.state!r}; only open reviews accept decisions"
            )
        item = db.execute(
            select(AccessReviewItem).where(
                AccessReviewItem.review_id == review_id,
                AccessReviewItem.tenant_id == tid,
                AccessReviewItem.id == item_id,
            )
        ).scalar_one_or_none()
        if item is None:
            raise AccessReviewError("item not found")
        item.decision = d
        item.new_role = nr
        item.note = cleaned_note
        item.decided_by = actor
        item.decided_at = datetime.utcnow()
        item.state = "decided"
        db.commit()
        db.refresh(item)
        return _to_item_view(item)


@dataclass(frozen=True)
class CloseResult:
    review: AccessReviewView
    applied: list[tuple[str, str, str]]  # (subject, decision, detail)


def close_review(
    *,
    tenant_id: str,
    review_id: int,
    closed_by: str,
    summary: Optional[str] = None,
) -> CloseResult:
    """Close a review, applying every decided 'change' and 'revoke'.

    Refuses to close if any item is still pending. Marks the review
    ``closed`` and records ``applied=1`` on each item whose decision
    resulted in a membership change.
    """
    tid = (tenant_id or "default").strip() or "default"
    cleaned_summary = _clean(summary, max_len=MAX_REASON_LEN)
    actor = (closed_by or "").strip() or "unknown"
    applied: list[tuple[str, str, str]] = []

    with session() as db:
        review = db.execute(
            select(AccessReview).where(
                AccessReview.tenant_id == tid, AccessReview.id == review_id
            )
        ).scalar_one_or_none()
        if review is None:
            raise AccessReviewError("review not found")
        if review.state != "open":
            raise AccessReviewError(
                f"review is {review.state!r}; cannot close again"
            )
        items = db.execute(
            select(AccessReviewItem).where(
                AccessReviewItem.review_id == review_id,
                AccessReviewItem.tenant_id == tid,
            )
        ).scalars().all()
        pending = [i for i in items if i.state != "decided"]
        if pending:
            raise AccessReviewError(
                f"cannot close: {len(pending)} item(s) still pending decision"
            )

        # Apply decisions. Do this inside the same transaction so failures
        # leave the review open and the items unchanged.
        for it in items:
            if it.decision == "revoke":
                removed = remove_member(tid, it.subject)
                if removed is not None:
                    it.applied = 1
                    applied.append((it.subject, "revoke", "removed"))
                else:
                    it.applied = 0
                    applied.append((it.subject, "revoke", "not_present"))
            elif it.decision == "change":
                upsert_member(
                    tenant_id=tid,
                    subject=it.subject,
                    role=str(it.new_role),
                    added_by=actor,
                )
                it.applied = 1
                applied.append(
                    (it.subject, "change", f"role:{it.new_role}")
                )
            else:
                it.applied = 0  # keep -> nothing to apply
                applied.append((it.subject, "keep", "no_change"))
        review.state = "closed"
        review.closed_by = actor
        review.closed_at = datetime.utcnow()
        review.close_summary = cleaned_summary
        db.commit()
        db.refresh(review)
        n, d = _counts(db, int(review.id))
        view = _to_review_view(review, item_count=n, decided_count=d)
        return CloseResult(review=view, applied=applied)


def cancel_review(
    *,
    tenant_id: str,
    review_id: int,
    cancelled_by: str,
    reason: Optional[str] = None,
) -> AccessReviewView:
    tid = (tenant_id or "default").strip() or "default"
    cleaned = _clean(reason, max_len=MAX_REASON_LEN)
    actor = (cancelled_by or "").strip() or "unknown"
    with session() as db:
        review = db.execute(
            select(AccessReview).where(
                AccessReview.tenant_id == tid, AccessReview.id == review_id
            )
        ).scalar_one_or_none()
        if review is None:
            raise AccessReviewError("review not found")
        if review.state != "open":
            raise AccessReviewError(
                f"review is {review.state!r}; cannot cancel"
            )
        review.state = "cancelled"
        review.closed_by = actor
        review.closed_at = datetime.utcnow()
        review.close_summary = cleaned
        db.commit()
        db.refresh(review)
        n, d = _counts(db, int(review.id))
        return _to_review_view(review, item_count=n, decided_count=d)
