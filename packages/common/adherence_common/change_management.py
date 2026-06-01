"""Per-tenant Change Management register.

Every enterprise procurement review and every SOC 2 / ISO 27001
audit asks the vendor to demonstrate a controlled change management
process: every production change is captured in a register, risk
assessed, approved by an authorised party, implemented with a
rollback plan, and reviewed afterwards. This is SOC 2 CC8.1
(authorised, designed, tested, approved, documented changes), ISO
27001 Annex A.12.1.2 and A.14.2.2, ITIL Change Advisory Board, and
NIST SP 800-53 CM-3.

This module is the per-workspace register of change requests. It
sits next to the BCDR register, the GDPR Art. 30 RoPA, the Art. 35
DPIA, the pentest log, and the incidents log so a workspace owner
can hand a regulator or procurement team a complete evidence pack
without leaving the product.

Semantics
---------

* A workspace has zero or more change requests. Each entry declares
  one production change: a short title, change type (standard,
  normal, emergency), risk class (low, medium, high, critical), the
  affected service, a rollback plan, the planned window, the actual
  implementation window, the requester, the approver, the post
  implementation review, and free-text notes.
* Workflow: ``planned`` -> ``approved`` -> ``in_progress`` ->
  ``completed`` or ``rolled_back`` or ``cancelled``. Transitions are
  one-way except cancellation, which is allowed from ``planned`` or
  ``approved``.
* High and critical risk changes require an approver_email distinct
  from the requester_email (four-eyes). Emergency changes may skip
  the planned window but still require an approver and a rollback
  plan.
* Every change bumps a monotonic ``version`` and the route layer
  writes an admin audit row.
* Entries can be archived rather than deleted, preserving the
  historical record for the auditor.
* Every read and write is strictly scoped to the caller's tenant.
  There is no cross-tenant code path: ``tenant_id`` is part of every
  query.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import Column, DateTime, Integer, String, Text, UniqueConstraint, select

from adherence_common.db import Base, session


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

MIN_TITLE_LEN = 4
MAX_TITLE_LEN = 200
MAX_SERVICE_LEN = 128
MAX_EMAIL_LEN = 254
MAX_ROLLBACK_LEN = 4096
MAX_NOTES_LEN = 4096
MAX_REVIEW_LEN = 4096
MAX_REF_LEN = 128

CHANGE_TYPES = ("standard", "normal", "emergency")
RISK_CLASSES = ("low", "medium", "high", "critical")
_RISK_RANK = {s: i for i, s in enumerate(RISK_CLASSES)}
STATUSES = (
    "planned",
    "approved",
    "in_progress",
    "completed",
    "rolled_back",
    "cancelled",
)
TERMINAL_STATUSES = ("completed", "rolled_back", "cancelled")

# Allowed forward transitions. Cancellation is special-cased below.
_TRANSITIONS = {
    "planned": ("approved", "cancelled"),
    "approved": ("in_progress", "cancelled"),
    "in_progress": ("completed", "rolled_back"),
    "completed": (),
    "rolled_back": (),
    "cancelled": (),
}

HIGH_RISK = ("high", "critical")


class ChangeError(ValueError):
    """Raised when a change request input is invalid."""


def _clean(s: Optional[str], *, max_len: int) -> Optional[str]:
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    if len(t) > max_len:
        raise ChangeError(f"value too long (max {max_len})")
    return t


def _required(s: str, *, field: str, min_len: int, max_len: int) -> str:
    if s is None:
        raise ChangeError(f"{field} is required")
    t = str(s).strip()
    if len(t) < min_len:
        raise ChangeError(f"{field} must be at least {min_len} characters")
    if len(t) > max_len:
        raise ChangeError(f"{field} must be at most {max_len} characters")
    return t


def _email(s: Optional[str], *, field: str, required: bool = False) -> Optional[str]:
    t = _clean(s, max_len=MAX_EMAIL_LEN)
    if t is None:
        if required:
            raise ChangeError(f"{field} is required")
        return None
    if "@" not in t or t.startswith("@") or t.endswith("@") or " " in t:
        raise ChangeError(f"{field} must be a valid email address")
    return t.lower()


def _change_type(v: str) -> str:
    t = (v or "").strip().lower()
    if t not in CHANGE_TYPES:
        raise ChangeError(
            f"change_type must be one of: {', '.join(CHANGE_TYPES)}"
        )
    return t


def _risk_class(v: str) -> str:
    t = (v or "").strip().lower()
    if t not in RISK_CLASSES:
        raise ChangeError(
            f"risk_class must be one of: {', '.join(RISK_CLASSES)}"
        )
    return t


def _status(v: str) -> str:
    t = (v or "").strip().lower()
    if t not in STATUSES:
        raise ChangeError(f"status must be one of: {', '.join(STATUSES)}")
    return t


def _check_transition(current: str, target: str) -> None:
    cur = _status(current)
    tgt = _status(target)
    if cur == tgt:
        raise ChangeError(f"change is already in status {cur!r}")
    allowed = _TRANSITIONS.get(cur, ())
    if tgt not in allowed:
        raise ChangeError(
            f"cannot transition from {cur!r} to {tgt!r}; allowed: {', '.join(allowed) or 'none'}"
        )


# ---------------------------------------------------------------------------
# ORM
# ---------------------------------------------------------------------------


class ChangeRequest(Base):
    """One production change request, scoped to a tenant.

    ``(tenant_id, reference)`` is unique among active rows when a
    reference is provided.
    """

    __tablename__ = "change_requests"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "reference", name="uq_change_tenant_ref"
        ),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    reference = Column(String(MAX_REF_LEN), nullable=True)
    title = Column(String(MAX_TITLE_LEN), nullable=False)
    change_type = Column(String(16), nullable=False, default="normal")
    risk_class = Column(String(16), nullable=False, default="low")
    affected_service = Column(String(MAX_SERVICE_LEN), nullable=False)
    rollback_plan = Column(Text, nullable=False)
    notes = Column(Text, nullable=True)
    review_summary = Column(Text, nullable=True)
    requester_email = Column(String(MAX_EMAIL_LEN), nullable=False)
    approver_email = Column(String(MAX_EMAIL_LEN), nullable=True)
    status = Column(String(16), nullable=False, default="planned", index=True)
    planned_start_at = Column(DateTime, nullable=True)
    planned_end_at = Column(DateTime, nullable=True)
    actual_start_at = Column(DateTime, nullable=True)
    actual_end_at = Column(DateTime, nullable=True)
    approved_at = Column(DateTime, nullable=True)
    approved_by = Column(String(128), nullable=True)
    version = Column(Integer, default=1, nullable=False)
    created_by = Column(String(128), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_by = Column(String(128), nullable=True)
    updated_at = Column(DateTime, nullable=True)
    archived_by = Column(String(128), nullable=True)
    archived_at = Column(DateTime, nullable=True, index=True)


@dataclass(frozen=True)
class ChangeView:
    id: int
    tenant_id: str
    reference: Optional[str]
    title: str
    change_type: str
    risk_class: str
    affected_service: str
    rollback_plan: str
    notes: Optional[str]
    review_summary: Optional[str]
    requester_email: str
    approver_email: Optional[str]
    status: str
    planned_start_at: Optional[str]
    planned_end_at: Optional[str]
    actual_start_at: Optional[str]
    actual_end_at: Optional[str]
    approved_at: Optional[str]
    approved_by: Optional[str]
    is_terminal: bool
    is_overdue: bool
    requires_approver: bool
    has_review: bool
    version: int
    created_by: str
    created_at: str
    updated_by: Optional[str]
    updated_at: Optional[str]
    archived_by: Optional[str]
    archived_at: Optional[str]
    active: bool


def _iso(d: Optional[datetime]) -> Optional[str]:
    return d.isoformat() if d else None


def _is_overdue(row: ChangeRequest, *, now: datetime) -> bool:
    if row.archived_at is not None:
        return False
    if row.status in TERMINAL_STATUSES:
        return False
    if row.planned_end_at is None:
        return False
    return row.planned_end_at < now


def _to_view(row: ChangeRequest, *, now: Optional[datetime] = None) -> ChangeView:
    n = now or datetime.utcnow()
    requires = (row.risk_class or "low") in HIGH_RISK or (
        row.change_type or "normal"
    ) == "emergency"
    return ChangeView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        reference=(str(row.reference) if row.reference else None),
        title=str(row.title),
        change_type=str(row.change_type or "normal"),
        risk_class=str(row.risk_class or "low"),
        affected_service=str(row.affected_service or ""),
        rollback_plan=str(row.rollback_plan or ""),
        notes=(str(row.notes) if row.notes else None),
        review_summary=(str(row.review_summary) if row.review_summary else None),
        requester_email=str(row.requester_email),
        approver_email=(str(row.approver_email) if row.approver_email else None),
        status=str(row.status or "planned"),
        planned_start_at=_iso(row.planned_start_at),
        planned_end_at=_iso(row.planned_end_at),
        actual_start_at=_iso(row.actual_start_at),
        actual_end_at=_iso(row.actual_end_at),
        approved_at=_iso(row.approved_at),
        approved_by=(str(row.approved_by) if row.approved_by else None),
        is_terminal=str(row.status or "planned") in TERMINAL_STATUSES,
        is_overdue=_is_overdue(row, now=n),
        requires_approver=requires,
        has_review=bool(row.review_summary),
        version=int(row.version or 1),
        created_by=str(row.created_by),
        created_at=row.created_at.isoformat() if row.created_at else "",
        updated_by=(str(row.updated_by) if row.updated_by else None),
        updated_at=_iso(row.updated_at),
        archived_by=(str(row.archived_by) if row.archived_by else None),
        archived_at=_iso(row.archived_at),
        active=(row.archived_at is None),
    )


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------


def create_change(
    *,
    tenant_id: str,
    title: str,
    change_type: str,
    risk_class: str,
    affected_service: str,
    rollback_plan: str,
    requester_email: str,
    created_by: str,
    approver_email: Optional[str] = None,
    notes: Optional[str] = None,
    reference: Optional[str] = None,
    planned_start_at: Optional[datetime] = None,
    planned_end_at: Optional[datetime] = None,
) -> ChangeView:
    tid = (tenant_id or "default")[:64]
    ctitle = _required(
        title, field="title", min_len=MIN_TITLE_LEN, max_len=MAX_TITLE_LEN
    )
    ctype = _change_type(change_type)
    crisk = _risk_class(risk_class)
    csvc = _required(
        affected_service,
        field="affected_service",
        min_len=2,
        max_len=MAX_SERVICE_LEN,
    )
    crollback = _required(
        rollback_plan,
        field="rollback_plan",
        min_len=4,
        max_len=MAX_ROLLBACK_LEN,
    )
    creq = _email(requester_email, field="requester_email", required=True)
    capprover = _email(approver_email, field="approver_email")
    cnotes = _clean(notes, max_len=MAX_NOTES_LEN)
    cref = _clean(reference, max_len=MAX_REF_LEN)

    # Four-eyes: high/critical risk or emergency change requires a
    # distinct approver up front. Approval still has to be recorded
    # via transition, but we refuse to even file the request without
    # naming the approver.
    if (crisk in HIGH_RISK) or (ctype == "emergency"):
        if not capprover:
            raise ChangeError(
                "approver_email is required for high or critical risk and "
                "for emergency changes"
            )
        if capprover == creq:
            raise ChangeError(
                "approver_email must differ from requester_email "
                "(four-eyes control)"
            )

    if planned_start_at is not None and not isinstance(planned_start_at, datetime):
        raise ChangeError("planned_start_at must be a datetime")
    if planned_end_at is not None and not isinstance(planned_end_at, datetime):
        raise ChangeError("planned_end_at must be a datetime")
    if (
        planned_start_at is not None
        and planned_end_at is not None
        and planned_end_at <= planned_start_at
    ):
        raise ChangeError("planned_end_at must be after planned_start_at")

    actor = (created_by or "unknown")[:128]
    with session() as s:
        if cref:
            existing = s.execute(
                select(ChangeRequest).where(
                    ChangeRequest.tenant_id == tid,
                    ChangeRequest.reference == cref,
                    ChangeRequest.archived_at.is_(None),
                )
            ).scalar_one_or_none()
            if existing is not None:
                raise ChangeError(
                    f"a change with reference {cref!r} already exists for this workspace"
                )
        row = ChangeRequest(
            tenant_id=tid,
            reference=cref,
            title=ctitle,
            change_type=ctype,
            risk_class=crisk,
            affected_service=csvc,
            rollback_plan=crollback,
            notes=cnotes,
            requester_email=creq,
            approver_email=capprover,
            status="planned",
            planned_start_at=planned_start_at,
            planned_end_at=planned_end_at,
            version=1,
            created_by=actor,
            created_at=datetime.utcnow(),
        )
        s.add(row)
        s.commit()
        s.refresh(row)
        return _to_view(row)


def update_change(
    *,
    tenant_id: str,
    change_id: int,
    updated_by: str,
    title: Optional[str] = None,
    change_type: Optional[str] = None,
    risk_class: Optional[str] = None,
    affected_service: Optional[str] = None,
    rollback_plan: Optional[str] = None,
    approver_email: Optional[str] = None,
    notes: Optional[str] = None,
    planned_start_at: Optional[datetime] = None,
    planned_end_at: Optional[datetime] = None,
) -> Optional[ChangeView]:
    """Update one change request, strictly scoped to ``tenant_id``.

    Only allowed while the change is not in a terminal status. The
    requester email and reference are immutable once filed.
    """
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(ChangeRequest).where(
                ChangeRequest.tenant_id == tid,
                ChangeRequest.id == int(change_id),
                ChangeRequest.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        if row.status in TERMINAL_STATUSES:
            raise ChangeError(
                f"cannot edit a change in status {row.status!r}"
            )
        if title is not None:
            row.title = _required(
                title,
                field="title",
                min_len=MIN_TITLE_LEN,
                max_len=MAX_TITLE_LEN,
            )
        if change_type is not None:
            row.change_type = _change_type(change_type)
        if risk_class is not None:
            row.risk_class = _risk_class(risk_class)
        if affected_service is not None:
            row.affected_service = _required(
                affected_service,
                field="affected_service",
                min_len=2,
                max_len=MAX_SERVICE_LEN,
            )
        if rollback_plan is not None:
            row.rollback_plan = _required(
                rollback_plan,
                field="rollback_plan",
                min_len=4,
                max_len=MAX_ROLLBACK_LEN,
            )
        if approver_email is not None:
            row.approver_email = (
                _email(approver_email, field="approver_email")
                if approver_email
                else None
            )
        if notes is not None:
            row.notes = _clean(notes, max_len=MAX_NOTES_LEN)
        if planned_start_at is not None:
            if not isinstance(planned_start_at, datetime):
                raise ChangeError("planned_start_at must be a datetime")
            row.planned_start_at = planned_start_at
        if planned_end_at is not None:
            if not isinstance(planned_end_at, datetime):
                raise ChangeError("planned_end_at must be a datetime")
            row.planned_end_at = planned_end_at
        # Recheck four-eyes after any edit.
        if (row.risk_class in HIGH_RISK) or (row.change_type == "emergency"):
            if not row.approver_email:
                raise ChangeError(
                    "approver_email is required for high or critical risk "
                    "and for emergency changes"
                )
            if row.approver_email == row.requester_email:
                raise ChangeError(
                    "approver_email must differ from requester_email "
                    "(four-eyes control)"
                )
        if (
            row.planned_start_at is not None
            and row.planned_end_at is not None
            and row.planned_end_at <= row.planned_start_at
        ):
            raise ChangeError("planned_end_at must be after planned_start_at")
        row.version = int(row.version or 1) + 1
        row.updated_by = (updated_by or "unknown")[:128]
        row.updated_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return _to_view(row)


def transition_change(
    *,
    tenant_id: str,
    change_id: int,
    target_status: str,
    actor_email: str,
    actor: str,
    review_summary: Optional[str] = None,
    occurred_at: Optional[datetime] = None,
) -> Optional[ChangeView]:
    """Move a change to a new status, enforcing the workflow.

    * ``approved`` requires an approver_email distinct from the
      requester_email and records ``approved_by`` / ``approved_at``.
    * ``in_progress`` records ``actual_start_at``.
    * ``completed`` and ``rolled_back`` record ``actual_end_at`` and
      require a non-empty ``review_summary`` (post implementation
      review).
    """
    tid = (tenant_id or "default")[:64]
    tgt = _status(target_status)
    cactor_email = _email(actor_email, field="actor_email", required=True)
    when = occurred_at or datetime.utcnow()
    with session() as s:
        row = s.execute(
            select(ChangeRequest).where(
                ChangeRequest.tenant_id == tid,
                ChangeRequest.id == int(change_id),
                ChangeRequest.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        _check_transition(row.status or "planned", tgt)

        if tgt == "approved":
            if not row.approver_email:
                raise ChangeError(
                    "approver_email must be set before approval"
                )
            if cactor_email != row.approver_email:
                raise ChangeError(
                    "only the named approver can mark a change as approved"
                )
            if cactor_email == row.requester_email:
                raise ChangeError(
                    "the requester cannot approve their own change "
                    "(four-eyes control)"
                )
            row.approved_at = when
            row.approved_by = (actor or cactor_email)[:128]
        elif tgt == "in_progress":
            row.actual_start_at = when
        elif tgt in ("completed", "rolled_back"):
            rs = _clean(review_summary, max_len=MAX_REVIEW_LEN)
            if rs is None:
                raise ChangeError(
                    "review_summary is required to close a change "
                    "(post implementation review)"
                )
            row.review_summary = rs
            row.actual_end_at = when
            if row.actual_start_at is None:
                row.actual_start_at = when
        # cancelled has no extra fields.

        row.status = tgt
        row.version = int(row.version or 1) + 1
        row.updated_by = (actor or cactor_email)[:128]
        row.updated_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return _to_view(row)


def archive_change(
    *,
    tenant_id: str,
    change_id: int,
    archived_by: str,
) -> Optional[ChangeView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(ChangeRequest).where(
                ChangeRequest.tenant_id == tid,
                ChangeRequest.id == int(change_id),
                ChangeRequest.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        row.archived_by = (archived_by or "unknown")[:128]
        row.archived_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return _to_view(row)


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def list_changes(
    *,
    tenant_id: str,
    include_archived: bool = False,
    status: Optional[str] = None,
    limit: int = 200,
    offset: int = 0,
) -> list[ChangeView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        q = select(ChangeRequest).where(ChangeRequest.tenant_id == tid)
        if not include_archived:
            q = q.where(ChangeRequest.archived_at.is_(None))
        if status:
            cs = _status(status)
            q = q.where(ChangeRequest.status == cs)
        q = (
            q.order_by(ChangeRequest.id.desc())
            .offset(int(offset))
            .limit(int(limit))
        )
        return [_to_view(r) for r in s.execute(q).scalars().all()]


def get_change(*, tenant_id: str, change_id: int) -> Optional[ChangeView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(ChangeRequest).where(
                ChangeRequest.tenant_id == tid,
                ChangeRequest.id == int(change_id),
            )
        ).scalar_one_or_none()
        return _to_view(row) if row is not None else None


def active_count(tenant_id: str) -> int:
    tid = (tenant_id or "default")[:64]
    try:
        with session() as s:
            return len(
                s.execute(
                    select(ChangeRequest).where(
                        ChangeRequest.tenant_id == tid,
                        ChangeRequest.archived_at.is_(None),
                    )
                ).all()
            )
    except Exception:
        return 0


def open_count(tenant_id: str) -> int:
    """Count of non-terminal, non-archived changes."""
    tid = (tenant_id or "default")[:64]
    try:
        with session() as s:
            rows = (
                s.execute(
                    select(ChangeRequest).where(
                        ChangeRequest.tenant_id == tid,
                        ChangeRequest.archived_at.is_(None),
                    )
                )
                .scalars()
                .all()
            )
    except Exception:
        return 0
    return sum(1 for r in rows if (r.status or "planned") not in TERMINAL_STATUSES)


def overdue_count(tenant_id: str) -> int:
    tid = (tenant_id or "default")[:64]
    try:
        with session() as s:
            rows = (
                s.execute(
                    select(ChangeRequest).where(
                        ChangeRequest.tenant_id == tid,
                        ChangeRequest.archived_at.is_(None),
                    )
                )
                .scalars()
                .all()
            )
    except Exception:
        return 0
    now = datetime.utcnow()
    return sum(1 for r in rows if _is_overdue(r, now=now))


def highest_open_risk(tenant_id: str) -> str:
    tid = (tenant_id or "default")[:64]
    try:
        with session() as s:
            rows = (
                s.execute(
                    select(ChangeRequest).where(
                        ChangeRequest.tenant_id == tid,
                        ChangeRequest.archived_at.is_(None),
                    )
                )
                .scalars()
                .all()
            )
    except Exception:
        return "low"
    worst = "low"
    any_open = False
    for r in rows:
        if (r.status or "planned") in TERMINAL_STATUSES:
            continue
        any_open = True
        rc = (r.risk_class or "low")
        if _RISK_RANK.get(rc, 0) > _RISK_RANK.get(worst, 0):
            worst = rc
    return worst if any_open else "low"


__all__ = [
    "CHANGE_TYPES",
    "RISK_CLASSES",
    "STATUSES",
    "TERMINAL_STATUSES",
    "MIN_TITLE_LEN",
    "MAX_TITLE_LEN",
    "MAX_SERVICE_LEN",
    "MAX_EMAIL_LEN",
    "MAX_ROLLBACK_LEN",
    "MAX_NOTES_LEN",
    "MAX_REVIEW_LEN",
    "MAX_REF_LEN",
    "ChangeError",
    "ChangeRequest",
    "ChangeView",
    "create_change",
    "update_change",
    "transition_change",
    "archive_change",
    "list_changes",
    "get_change",
    "active_count",
    "open_count",
    "overdue_count",
    "highest_open_risk",
]
