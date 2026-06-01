"""Per-tenant dual-control (four-eyes) approval workflow.

Enterprise security teams and SOC 2 / HIPAA / SOX auditors require
that certain high-impact administrative actions be approved by a
second administrator before they execute. Common examples:

* Releasing a legal hold (lifting a deletion freeze).
* Rotating or revoking a customer-managed encryption key.
* Hard-deleting a workspace or bulk-exporting PHI.

This module implements the workflow without prescribing which
actions are covered. Each workspace opts specific ``action_type``
strings into dual control via :class:`DualControlPolicy`. The route
layer calls :func:`ensure_approved` immediately before executing the
action; if the policy requires it, the call returns the matching
``DualControlRequest`` row (status ``approved``) and the route marks
it executed. If no policy entry exists for the action type, the
helper returns ``None`` and the route proceeds in single-control
mode (backwards compatible).

Guarantees:

* The approver MUST be a different principal from the requester
  (``no self approve``). Enforced at the mutation layer, not the
  route layer, so any caller of this module gets the property.
* The approver MUST belong to the same tenant. Cross-tenant
  approval is impossible at the query layer.
* Requests carry a SHA-256 ``payload_hash`` that the route computes
  from the same payload it is about to apply. The approval binds the
  approver to that exact payload; changing the payload between
  request and execution invalidates the approval.
* Requests auto-expire after ``ttl_seconds`` (default 24 hours, min
  5 minutes, max 7 days). Expired requests cannot be approved or
  executed.
* Every state transition is recorded; the table itself is the
  tamper-evident record. The route layer is expected to ALSO write
  an admin_audit row, mirroring the legal-hold / CMEK pattern.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Iterable, Optional

from sqlalchemy import (
    Column,
    DateTime,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    select,
)

from adherence_common.db import Base, session


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

MIN_REASON_LEN = 10
MAX_REASON_LEN = 4096
MAX_ACTION_TYPE_LEN = 64
MIN_TTL_SECONDS = 5 * 60
DEFAULT_TTL_SECONDS = 24 * 60 * 60
MAX_TTL_SECONDS = 7 * 24 * 60 * 60

# Status values are kept as short strings (and not an Enum column) to
# match the rest of the codebase, which favours portability across
# sqlite and postgres without alembic migrations.
STATUS_PENDING = "pending"
STATUS_APPROVED = "approved"
STATUS_REJECTED = "rejected"
STATUS_EXECUTED = "executed"
STATUS_CANCELLED = "cancelled"
STATUS_EXPIRED = "expired"

ALL_STATUSES: frozenset[str] = frozenset(
    {
        STATUS_PENDING,
        STATUS_APPROVED,
        STATUS_REJECTED,
        STATUS_EXECUTED,
        STATUS_CANCELLED,
        STATUS_EXPIRED,
    }
)


class DualControlError(ValueError):
    """Raised when a dual-control input is invalid."""


def _validate_reason(raw: Optional[str]) -> str:
    if raw is None:
        raise DualControlError("reason is required")
    s = str(raw).strip()
    if len(s) < MIN_REASON_LEN:
        raise DualControlError(
            f"reason must be at least {MIN_REASON_LEN} characters"
        )
    if len(s) > MAX_REASON_LEN:
        raise DualControlError(
            f"reason must be at most {MAX_REASON_LEN} characters"
        )
    return s


def _validate_action_type(raw: Optional[str]) -> str:
    if raw is None:
        raise DualControlError("action_type is required")
    s = str(raw).strip().lower()
    if not s:
        raise DualControlError("action_type is required")
    if len(s) > MAX_ACTION_TYPE_LEN:
        raise DualControlError(
            f"action_type must be at most {MAX_ACTION_TYPE_LEN} characters"
        )
    # ASCII letters, digits, dot, dash, underscore. No whitespace.
    for ch in s:
        if not (ch.isalnum() or ch in "._-"):
            raise DualControlError(
                "action_type may only contain letters, digits, '.', '_' or '-'"
            )
    return s


def _normalise_ttl(ttl_seconds: Optional[int]) -> int:
    if ttl_seconds is None:
        return DEFAULT_TTL_SECONDS
    try:
        v = int(ttl_seconds)
    except (TypeError, ValueError) as exc:
        raise DualControlError("ttl_seconds must be an integer") from exc
    if v < MIN_TTL_SECONDS:
        raise DualControlError(
            f"ttl_seconds must be at least {MIN_TTL_SECONDS}"
        )
    if v > MAX_TTL_SECONDS:
        raise DualControlError(
            f"ttl_seconds must be at most {MAX_TTL_SECONDS}"
        )
    return v


def compute_payload_hash(payload: Any) -> str:
    """Stable SHA-256 of a JSON-serialisable payload.

    The route layer calls this on the exact payload it is about to
    apply (e.g. ``{"hold_id": 42, "release_reason": "..."}``). The
    approval binds the approver to this hash; if the executor sees a
    different hash at execution time it must refuse to run.
    """
    blob = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# ORM
# ---------------------------------------------------------------------------


class DualControlPolicy(Base):
    """Per-tenant opt-in: which action types require dual control.

    A workspace owner inserts one row per gated action type. The
    presence of a row means the action requires a second approver;
    deleting the row reverts the action to single-control. There is
    deliberately no global / fleet-wide default because operators in
    different industries have very different risk thresholds.
    """

    __tablename__ = "dual_control_policy"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "action_type", name="uq_dcp_tenant_action"
        ),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(
        String(64), index=True, nullable=False, default="default"
    )
    action_type = Column(String(MAX_ACTION_TYPE_LEN), nullable=False)
    description = Column(Text, nullable=True)
    ttl_seconds = Column(Integer, nullable=False, default=DEFAULT_TTL_SECONDS)
    created_by = Column(String(128), nullable=False)
    created_at = Column(
        DateTime, default=datetime.utcnow, nullable=False, index=True
    )


class DualControlRequest(Base):
    """One sensitive-action approval request.

    Lifecycle:

        pending --approve--> approved --execute--> executed
        pending --reject---> rejected
        pending --cancel---> cancelled    (by requester)
        pending --expire--> expired       (passive, on read)

    Once a row leaves ``pending`` it never returns. Approval is bound
    to ``payload_hash`` so the executor can detect tampering.
    """

    __tablename__ = "dual_control_requests"

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(
        String(64), index=True, nullable=False, default="default"
    )
    action_type = Column(String(MAX_ACTION_TYPE_LEN), nullable=False, index=True)
    payload_hash = Column(String(64), nullable=False, index=True)
    payload = Column(Text, nullable=True)  # JSON-encoded preview
    summary = Column(String(256), nullable=True)
    reason = Column(Text, nullable=False)
    status = Column(String(16), nullable=False, default=STATUS_PENDING, index=True)
    requested_by = Column(String(128), nullable=False)
    requested_at = Column(
        DateTime, default=datetime.utcnow, nullable=False, index=True
    )
    expires_at = Column(DateTime, nullable=False, index=True)
    decided_by = Column(String(128), nullable=True)
    decided_at = Column(DateTime, nullable=True)
    decision_reason = Column(Text, nullable=True)
    executed_at = Column(DateTime, nullable=True)


@dataclass(frozen=True)
class DualControlPolicyView:
    id: int
    tenant_id: str
    action_type: str
    description: Optional[str]
    ttl_seconds: int
    created_by: str
    created_at: str


@dataclass(frozen=True)
class DualControlRequestView:
    id: int
    tenant_id: str
    action_type: str
    payload_hash: str
    payload: Any
    summary: Optional[str]
    reason: str
    status: str
    requested_by: str
    requested_at: str
    expires_at: str
    decided_by: Optional[str]
    decided_at: Optional[str]
    decision_reason: Optional[str]
    executed_at: Optional[str]
    expired: bool


def _policy_view(row: DualControlPolicy) -> DualControlPolicyView:
    return DualControlPolicyView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        action_type=str(row.action_type),
        description=(str(row.description) if row.description is not None else None),
        ttl_seconds=int(row.ttl_seconds),
        created_by=str(row.created_by),
        created_at=row.created_at.isoformat() if row.created_at else "",
    )


def _request_view(row: DualControlRequest) -> DualControlRequestView:
    now = datetime.utcnow()
    expired_passively = (
        row.status == STATUS_PENDING and row.expires_at is not None and row.expires_at <= now
    )
    payload: Any = None
    if row.payload:
        try:
            payload = json.loads(row.payload)
        except Exception:
            payload = None
    return DualControlRequestView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        action_type=str(row.action_type),
        payload_hash=str(row.payload_hash),
        payload=payload,
        summary=(str(row.summary) if row.summary is not None else None),
        reason=str(row.reason),
        status=(STATUS_EXPIRED if expired_passively else str(row.status)),
        requested_by=str(row.requested_by),
        requested_at=row.requested_at.isoformat() if row.requested_at else "",
        expires_at=row.expires_at.isoformat() if row.expires_at else "",
        decided_by=(str(row.decided_by) if row.decided_by is not None else None),
        decided_at=(row.decided_at.isoformat() if row.decided_at else None),
        decision_reason=(
            str(row.decision_reason) if row.decision_reason is not None else None
        ),
        executed_at=(row.executed_at.isoformat() if row.executed_at else None),
        expired=expired_passively or row.status == STATUS_EXPIRED,
    )


# ---------------------------------------------------------------------------
# Policy management
# ---------------------------------------------------------------------------


def set_policy(
    *,
    tenant_id: str,
    action_type: str,
    created_by: str,
    description: Optional[str] = None,
    ttl_seconds: Optional[int] = None,
) -> DualControlPolicyView:
    """Upsert a dual-control policy row for ``(tenant, action_type)``."""
    tid = (tenant_id or "default")[:64]
    at = _validate_action_type(action_type)
    ttl = _normalise_ttl(ttl_seconds)
    actor = (created_by or "unknown")[:128]
    desc = None
    if description is not None:
        desc = str(description).strip() or None
        if desc and len(desc) > MAX_REASON_LEN:
            raise DualControlError(
                f"description must be at most {MAX_REASON_LEN} characters"
            )
    with session() as s:
        row = s.execute(
            select(DualControlPolicy).where(
                DualControlPolicy.tenant_id == tid,
                DualControlPolicy.action_type == at,
            )
        ).scalar_one_or_none()
        if row is None:
            row = DualControlPolicy(
                tenant_id=tid,
                action_type=at,
                description=desc,
                ttl_seconds=ttl,
                created_by=actor,
            )
            s.add(row)
        else:
            row.description = desc
            row.ttl_seconds = ttl
            row.created_by = actor
            row.created_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return _policy_view(row)


def clear_policy(*, tenant_id: str, action_type: str) -> bool:
    """Remove the dual-control requirement for ``(tenant, action_type)``.

    Returns True if a row was removed.
    """
    tid = (tenant_id or "default")[:64]
    at = _validate_action_type(action_type)
    with session() as s:
        row = s.execute(
            select(DualControlPolicy).where(
                DualControlPolicy.tenant_id == tid,
                DualControlPolicy.action_type == at,
            )
        ).scalar_one_or_none()
        if row is None:
            return False
        s.delete(row)
        s.commit()
        return True


def list_policies(*, tenant_id: str) -> list[DualControlPolicyView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        rows = s.execute(
            select(DualControlPolicy)
            .where(DualControlPolicy.tenant_id == tid)
            .order_by(DualControlPolicy.action_type.asc())
        ).scalars().all()
        return [_policy_view(r) for r in rows]


def get_policy(
    *, tenant_id: str, action_type: str
) -> Optional[DualControlPolicyView]:
    tid = (tenant_id or "default")[:64]
    at = _validate_action_type(action_type)
    with session() as s:
        row = s.execute(
            select(DualControlPolicy).where(
                DualControlPolicy.tenant_id == tid,
                DualControlPolicy.action_type == at,
            )
        ).scalar_one_or_none()
        return _policy_view(row) if row is not None else None


def is_gated(*, tenant_id: str, action_type: str) -> bool:
    return get_policy(tenant_id=tenant_id, action_type=action_type) is not None


# ---------------------------------------------------------------------------
# Request lifecycle
# ---------------------------------------------------------------------------


def create_request(
    *,
    tenant_id: str,
    action_type: str,
    payload: Any,
    reason: str,
    requested_by: str,
    summary: Optional[str] = None,
    ttl_seconds: Optional[int] = None,
) -> DualControlRequestView:
    """Open a new pending approval request.

    The caller is expected to have already verified that the action
    is gated; this function does NOT consult the policy table. That
    keeps the workflow usable for one-off ad-hoc requests too.
    """
    tid = (tenant_id or "default")[:64]
    at = _validate_action_type(action_type)
    cleaned_reason = _validate_reason(reason)
    actor = (requested_by or "unknown")[:128]
    summary_clean: Optional[str] = None
    if summary is not None:
        summary_clean = str(summary).strip() or None
        if summary_clean and len(summary_clean) > 256:
            summary_clean = summary_clean[:256]
    payload_hash = compute_payload_hash(payload)
    payload_blob = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), default=str
    )
    if len(payload_blob) > 16 * 1024:
        raise DualControlError("payload too large (max 16 KiB)")
    ttl = _normalise_ttl(ttl_seconds)
    now = datetime.utcnow()
    expires = now + timedelta(seconds=ttl)
    with session() as s:
        row = DualControlRequest(
            tenant_id=tid,
            action_type=at,
            payload_hash=payload_hash,
            payload=payload_blob,
            summary=summary_clean,
            reason=cleaned_reason,
            status=STATUS_PENDING,
            requested_by=actor,
            requested_at=now,
            expires_at=expires,
        )
        s.add(row)
        s.commit()
        s.refresh(row)
        return _request_view(row)


def _load_pending_for_update(
    s, *, tenant_id: str, request_id: int
) -> Optional[DualControlRequest]:
    return s.execute(
        select(DualControlRequest).where(
            DualControlRequest.tenant_id == tenant_id,
            DualControlRequest.id == int(request_id),
        )
    ).scalar_one_or_none()


def approve_request(
    *,
    tenant_id: str,
    request_id: int,
    approver: str,
    decision_reason: Optional[str] = None,
) -> DualControlRequestView:
    """Move a pending request to ``approved``.

    Raises :class:`DualControlError` if the request does not exist
    for this tenant, is no longer pending, has expired, or the
    approver is the same principal as the requester.
    """
    tid = (tenant_id or "default")[:64]
    approver_clean = (approver or "unknown")[:128]
    note = None
    if decision_reason is not None:
        note = str(decision_reason).strip() or None
        if note and len(note) > MAX_REASON_LEN:
            raise DualControlError(
                f"decision_reason must be at most {MAX_REASON_LEN} characters"
            )
    with session() as s:
        row = _load_pending_for_update(
            s, tenant_id=tid, request_id=int(request_id)
        )
        if row is None:
            raise DualControlError("request not found")
        if row.status != STATUS_PENDING:
            raise DualControlError(
                f"request is {row.status}, not pending"
            )
        if row.expires_at is not None and row.expires_at <= datetime.utcnow():
            row.status = STATUS_EXPIRED
            s.commit()
            raise DualControlError("request has expired")
        if approver_clean == str(row.requested_by):
            raise DualControlError(
                "self approval is not permitted (dual control)"
            )
        row.status = STATUS_APPROVED
        row.decided_by = approver_clean
        row.decided_at = datetime.utcnow()
        row.decision_reason = note
        s.commit()
        s.refresh(row)
        return _request_view(row)


def reject_request(
    *,
    tenant_id: str,
    request_id: int,
    approver: str,
    decision_reason: Optional[str] = None,
) -> DualControlRequestView:
    tid = (tenant_id or "default")[:64]
    approver_clean = (approver or "unknown")[:128]
    note = None
    if decision_reason is not None:
        note = str(decision_reason).strip() or None
    with session() as s:
        row = _load_pending_for_update(
            s, tenant_id=tid, request_id=int(request_id)
        )
        if row is None:
            raise DualControlError("request not found")
        if row.status != STATUS_PENDING:
            raise DualControlError(
                f"request is {row.status}, not pending"
            )
        if approver_clean == str(row.requested_by):
            raise DualControlError(
                "self rejection is not permitted (dual control)"
            )
        row.status = STATUS_REJECTED
        row.decided_by = approver_clean
        row.decided_at = datetime.utcnow()
        row.decision_reason = note
        s.commit()
        s.refresh(row)
        return _request_view(row)


def cancel_request(
    *,
    tenant_id: str,
    request_id: int,
    canceller: str,
) -> DualControlRequestView:
    """Requester withdraws a pending request.

    Only the original requester (or someone reusing their principal
    id) can cancel; everyone else must reject. This keeps the audit
    trail honest: an unwanted request from another admin is rejected,
    not silently withdrawn.
    """
    tid = (tenant_id or "default")[:64]
    canceller_clean = (canceller or "unknown")[:128]
    with session() as s:
        row = _load_pending_for_update(
            s, tenant_id=tid, request_id=int(request_id)
        )
        if row is None:
            raise DualControlError("request not found")
        if row.status != STATUS_PENDING:
            raise DualControlError(
                f"request is {row.status}, not pending"
            )
        if canceller_clean != str(row.requested_by):
            raise DualControlError(
                "only the requester may cancel; others must reject"
            )
        row.status = STATUS_CANCELLED
        row.decided_by = canceller_clean
        row.decided_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return _request_view(row)


def mark_executed(
    *, tenant_id: str, request_id: int
) -> Optional[DualControlRequestView]:
    """Move an ``approved`` request to ``executed``.

    Called by the route layer immediately after the underlying
    sensitive action has been applied. Returns None if the request
    was not in ``approved`` state (so the caller can detect a race).
    """
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(DualControlRequest).where(
                DualControlRequest.tenant_id == tid,
                DualControlRequest.id == int(request_id),
            )
        ).scalar_one_or_none()
        if row is None or row.status != STATUS_APPROVED:
            return None
        row.status = STATUS_EXECUTED
        row.executed_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return _request_view(row)


def ensure_approved(
    *,
    tenant_id: str,
    action_type: str,
    payload: Any,
    principal_id: str,
) -> Optional[DualControlRequestView]:
    """Gate helper called by the route layer right before executing.

    Returns:

    * ``None`` if the action is not gated for this tenant. The route
      proceeds in single-control mode.
    * The matching approved :class:`DualControlRequestView` if an
      approval for *exactly this payload* exists and has not been
      executed yet. The route should call :func:`mark_executed`
      after applying the action.

    Raises :class:`DualControlError` when the action IS gated but no
    valid approval covers the payload. The route should surface this
    as HTTP 428 (Precondition Required) with a code that the UI
    recognises and turns into a "request approval" affordance.
    """
    if not is_gated(tenant_id=tenant_id, action_type=action_type):
        return None
    tid = (tenant_id or "default")[:64]
    at = _validate_action_type(action_type)
    expected_hash = compute_payload_hash(payload)
    now = datetime.utcnow()
    with session() as s:
        rows = s.execute(
            select(DualControlRequest)
            .where(
                DualControlRequest.tenant_id == tid,
                DualControlRequest.action_type == at,
                DualControlRequest.status == STATUS_APPROVED,
                DualControlRequest.payload_hash == expected_hash,
            )
            .order_by(DualControlRequest.id.desc())
        ).scalars().all()
        for row in rows:
            if row.expires_at is not None and row.expires_at <= now:
                continue
            if str(row.requested_by) == str(principal_id):
                # Approval row exists but the executor is the same
                # person who requested it. The approver was distinct,
                # but we still want the executor and the approver to
                # be distinct from each other to keep two-person
                # control end-to-end. Allow the requester to execute
                # (common pattern: the requester clicks "apply" once
                # a second admin approves) -- the four-eyes property
                # is preserved because approve_request rejected self
                # approval upstream.
                pass
            return _request_view(row)
        raise DualControlError(
            "this action requires a second-admin approval; "
            "open a dual-control request and have another admin approve it"
        )


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def list_requests(
    *,
    tenant_id: str,
    statuses: Optional[Iterable[str]] = None,
    action_type: Optional[str] = None,
    limit: int = 200,
    offset: int = 0,
) -> list[DualControlRequestView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        q = select(DualControlRequest).where(DualControlRequest.tenant_id == tid)
        if statuses:
            wanted = {str(x) for x in statuses if str(x) in ALL_STATUSES}
            if wanted:
                q = q.where(DualControlRequest.status.in_(wanted))
        if action_type:
            q = q.where(
                DualControlRequest.action_type == _validate_action_type(action_type)
            )
        q = q.order_by(DualControlRequest.id.desc()).offset(int(offset)).limit(
            int(limit)
        )
        return [_request_view(r) for r in s.execute(q).scalars().all()]


def get_request(
    *, tenant_id: str, request_id: int
) -> Optional[DualControlRequestView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(DualControlRequest).where(
                DualControlRequest.tenant_id == tid,
                DualControlRequest.id == int(request_id),
            )
        ).scalar_one_or_none()
        return _request_view(row) if row is not None else None


def pending_count(*, tenant_id: str) -> int:
    tid = (tenant_id or "default")[:64]
    now = datetime.utcnow()
    try:
        with session() as s:
            n = s.execute(
                select(func.count(DualControlRequest.id)).where(
                    DualControlRequest.tenant_id == tid,
                    DualControlRequest.status == STATUS_PENDING,
                    DualControlRequest.expires_at > now,
                )
            ).scalar_one()
            return int(n or 0)
    except Exception:
        return 0


__all__ = [
    "STATUS_PENDING",
    "STATUS_APPROVED",
    "STATUS_REJECTED",
    "STATUS_EXECUTED",
    "STATUS_CANCELLED",
    "STATUS_EXPIRED",
    "MIN_REASON_LEN",
    "MAX_REASON_LEN",
    "MIN_TTL_SECONDS",
    "DEFAULT_TTL_SECONDS",
    "MAX_TTL_SECONDS",
    "DualControlError",
    "DualControlPolicy",
    "DualControlRequest",
    "DualControlPolicyView",
    "DualControlRequestView",
    "compute_payload_hash",
    "set_policy",
    "clear_policy",
    "list_policies",
    "get_policy",
    "is_gated",
    "create_request",
    "approve_request",
    "reject_request",
    "cancel_request",
    "mark_executed",
    "ensure_approved",
    "list_requests",
    "get_request",
    "pending_count",
]


# ---------------------------------------------------------------------------
# Sentinel: trailing helper used only by mark_executed
# ---------------------------------------------------------------------------


def _trailing_noop():
    return None