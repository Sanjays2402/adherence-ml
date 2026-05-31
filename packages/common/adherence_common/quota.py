"""Per-workspace monthly prediction quotas.

Each workspace (tenant) belongs to a plan tier. Each plan has a monthly
prediction allowance and a max seat count. Usage is counted per UTC
calendar month; counters reset on the first of the month.

Quotas are evaluated *before* an inference is served, so a request that
would push usage over the cap is rejected with HTTP 429 plus standard
``X-RateLimit-*`` headers and ``Retry-After`` pointing at the next
month rollover.

Plans are not stored as a foreign-key catalog table on purpose; they are
defined here so config changes ship with code review. Per-workspace
overrides (custom enterprise contracts) are stored in
``workspace_quota``.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable

from sqlalchemy import Column, DateTime, Integer, String, UniqueConstraint, func, select
from sqlalchemy.exc import IntegrityError

from adherence_common.db import Base, session

# ---------------------------------------------------------------------------
# Plan catalog. Keep tiny and obvious; enterprise overrides live in DB.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Plan:
    name: str
    monthly_predictions: int
    seats: int
    # Human / SSO members allowed in the workspace. Pending invitations
    # count toward this cap until they expire or are revoked, so a
    # workspace cannot oversubscribe by issuing many open invites. API
    # key (service) seats are governed separately by ``seats``.
    member_seats: int = 0


PLANS: dict[str, Plan] = {
    "free": Plan("free", monthly_predictions=1_000, seats=3, member_seats=3),
    "pro": Plan("pro", monthly_predictions=100_000, seats=25, member_seats=25),
    "enterprise": Plan(
        "enterprise", monthly_predictions=2_000_000, seats=500, member_seats=500,
    ),
}
DEFAULT_PLAN = "free"


# ---------------------------------------------------------------------------
# ORM
# ---------------------------------------------------------------------------

class WorkspaceQuota(Base):
    """Per-workspace plan + optional override of the monthly prediction cap.

    ``monthly_predictions_override`` lets a sales-team set a custom cap
    without changing the plan label. ``NULL`` means "use plan default".
    """
    __tablename__ = "workspace_quota"
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), unique=True, nullable=False, index=True)
    plan = Column(String(32), nullable=False, default=DEFAULT_PLAN)
    monthly_predictions_override = Column(Integer, nullable=True)
    seats_override = Column(Integer, nullable=True)
    member_seats_override = Column(Integer, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class WorkspaceUsage(Base):
    """Monthly counters keyed (tenant_id, period). ``period`` is YYYYMM."""
    __tablename__ = "workspace_usage"
    __table_args__ = (UniqueConstraint("tenant_id", "period", name="uq_ws_usage"),)
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False)
    period = Column(String(6), index=True, nullable=False)
    predictions = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _period_for(dt: datetime) -> str:
    return f"{dt.year:04d}{dt.month:02d}"


def _next_period_start(dt: datetime) -> datetime:
    if dt.month == 12:
        return datetime(dt.year + 1, 1, 1, tzinfo=timezone.utc)
    return datetime(dt.year, dt.month + 1, 1, tzinfo=timezone.utc)


def get_plan(tenant_id: str) -> tuple[Plan, int, int]:
    """Return (Plan, effective_cap, seats_cap) for a workspace.

    Effective cap honors a per-workspace override.
    """
    with session() as db:
        row = db.scalar(select(WorkspaceQuota).where(WorkspaceQuota.tenant_id == tenant_id))
    if row is None:
        plan = PLANS[DEFAULT_PLAN]
        return plan, plan.monthly_predictions, plan.seats
    plan = PLANS.get(row.plan or DEFAULT_PLAN, PLANS[DEFAULT_PLAN])
    cap = row.monthly_predictions_override or plan.monthly_predictions
    seats = row.seats_override or plan.seats
    return plan, int(cap), int(seats)


def member_seat_limit(tenant_id: str) -> tuple[int, str]:
    """Return ``(effective_member_seat_cap, plan_name)`` for a workspace.

    Honors a per-workspace ``member_seats_override``.  Workspaces with
    no quota row default to the free plan's member cap so the gate is
    never silently disabled by row absence.
    """
    tid = (tenant_id or "default").strip() or "default"
    with session() as db:
        row = db.scalar(select(WorkspaceQuota).where(WorkspaceQuota.tenant_id == tid))
    if row is None:
        plan = PLANS[DEFAULT_PLAN]
        return plan.member_seats, plan.name
    plan = PLANS.get(row.plan or DEFAULT_PLAN, PLANS[DEFAULT_PLAN])
    cap = row.member_seats_override or plan.member_seats
    return int(cap), plan.name


def set_plan(
    tenant_id: str,
    *,
    plan: str | None = None,
    monthly_predictions_override: int | None = None,
    seats_override: int | None = None,
    member_seats_override: int | None = None,
) -> WorkspaceQuota:
    if plan is not None and plan not in PLANS:
        raise ValueError(f"unknown plan: {plan}")
    with session() as db:
        row = db.scalar(select(WorkspaceQuota).where(WorkspaceQuota.tenant_id == tenant_id))
        if row is None:
            row = WorkspaceQuota(
                tenant_id=tenant_id,
                plan=plan or DEFAULT_PLAN,
                monthly_predictions_override=monthly_predictions_override,
                seats_override=seats_override,
                member_seats_override=member_seats_override,
            )
            db.add(row)
        else:
            if plan is not None:
                row.plan = plan
            if monthly_predictions_override is not None:
                row.monthly_predictions_override = monthly_predictions_override or None
            if seats_override is not None:
                row.seats_override = seats_override or None
            if member_seats_override is not None:
                row.member_seats_override = member_seats_override or None
            row.updated_at = _now().replace(tzinfo=None)
        db.commit()
        db.refresh(row)
        return row


def current_usage(tenant_id: str, *, when: datetime | None = None) -> int:
    when = when or _now()
    period = _period_for(when)
    with session() as db:
        row = db.scalar(
            select(WorkspaceUsage).where(
                WorkspaceUsage.tenant_id == tenant_id,
                WorkspaceUsage.period == period,
            )
        )
        return int(row.predictions) if row else 0


@dataclass(frozen=True)
class QuotaDecision:
    allowed: bool
    limit: int
    remaining: int
    used: int
    reset_at: datetime
    retry_after: int  # seconds until reset; 0 if allowed
    plan: str


def check_and_consume(
    tenant_id: str,
    *,
    cost: int = 1,
    when: datetime | None = None,
) -> QuotaDecision:
    """Atomically check the monthly cap and increment usage by ``cost``.

    On rejection, usage is NOT incremented. Reset is the first of next
    UTC month.
    """
    when = when or _now()
    period = _period_for(when)
    reset_at = _next_period_start(when)
    plan, cap, _seats = get_plan(tenant_id)

    with session() as db:
        row = db.scalar(
            select(WorkspaceUsage).where(
                WorkspaceUsage.tenant_id == tenant_id,
                WorkspaceUsage.period == period,
            )
        )
        if row is None:
            row = WorkspaceUsage(tenant_id=tenant_id, period=period, predictions=0)
            db.add(row)
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                row = db.scalar(
                    select(WorkspaceUsage).where(
                        WorkspaceUsage.tenant_id == tenant_id,
                        WorkspaceUsage.period == period,
                    )
                )
            db.refresh(row)

        used = int(row.predictions)
        if used + cost > cap:
            return QuotaDecision(
                allowed=False, limit=cap, remaining=max(0, cap - used),
                used=used, reset_at=reset_at,
                retry_after=max(1, int((reset_at - when).total_seconds())),
                plan=plan.name,
            )
        row.predictions = used + cost
        row.updated_at = _now().replace(tzinfo=None)
        db.commit()
        return QuotaDecision(
            allowed=True, limit=cap, remaining=cap - (used + cost),
            used=used + cost, reset_at=reset_at, retry_after=0, plan=plan.name,
        )


def seat_usage(tenant_id: str) -> int:
    """Return the number of seats currently consumed by ``tenant_id``.

    A seat is one active API key (not revoked, not expired) scoped to the
    tenant. Static env-bootstrap keys do not count; only keys persisted in
    ``api_key_records`` are governed by the seat cap.

    Kept here (instead of in ``api_keys``) so the quota subsystem owns the
    full plan picture and seat enforcement does not import upward.
    """
    # Late import to avoid a cycle: api_keys imports settings, which is
    # safe, but quota loads early during db.init_db().
    from adherence_common.api_keys import APIKeyRecord  # noqa: WPS433

    now = _now().replace(tzinfo=None)
    with session() as db:
        rows = db.execute(
            select(APIKeyRecord).where(
                APIKeyRecord.tenant_id == (tenant_id or "default"),
                APIKeyRecord.revoked_at.is_(None),
            )
        ).scalars().all()
    return sum(
        1 for r in rows
        if r.expires_at is None or r.expires_at > now
    )


class SeatLimitExceeded(Exception):
    """Raised when issuing another API key would exceed the workspace's
    seat cap. Carries the current usage and limit so callers can surface
    a precise structured error.
    """

    def __init__(self, tenant_id: str, used: int, limit: int, plan: str) -> None:
        self.tenant_id = tenant_id
        self.used = used
        self.limit = limit
        self.plan = plan
        super().__init__(
            f"seat limit reached for workspace {tenant_id!r}: "
            f"{used}/{limit} on plan {plan!r}"
        )


def enforce_seat_capacity(tenant_id: str) -> tuple[int, int, str]:
    """Raise ``SeatLimitExceeded`` if issuing one more key would exceed
    the workspace seat cap. Returns ``(used_after, limit, plan_name)``
    on success so callers can surface it back to the user.
    """
    tid = (tenant_id or "default").strip() or "default"
    plan, _cap, seats = get_plan(tid)
    used = seat_usage(tid)
    if used >= seats:
        raise SeatLimitExceeded(tid, used=used, limit=seats, plan=plan.name)
    return used + 1, seats, plan.name


def member_seat_usage(tenant_id: str) -> tuple[int, int, int]:
    """Return ``(total, members, pending_invitations)`` for ``tenant_id``.

    A workspace member seat is consumed by:

    * every row in ``workspace_members`` for that tenant, and
    * every *pending* invitation (not accepted, not revoked, not
      expired) for that tenant.

    Pending invitations count so a workspace cannot quietly oversubscribe
    by sitting on a stack of open invites and accepting them later.  The
    counter falls back to zero when the memberships tables are not
    present (older deployments before the memberships migration ran).
    """
    tid = (tenant_id or "default").strip() or "default"
    try:
        from adherence_common.memberships import (  # noqa: WPS433
            WorkspaceInvitation,
            WorkspaceMember,
        )
    except Exception:
        return 0, 0, 0
    now = _now().replace(tzinfo=None)
    with session() as db:
        try:
            members = int(
                db.scalar(
                    select(func.count(WorkspaceMember.id)).where(
                        WorkspaceMember.tenant_id == tid,
                    )
                )
                or 0
            )
            pending = int(
                db.scalar(
                    select(func.count(WorkspaceInvitation.id)).where(
                        WorkspaceInvitation.tenant_id == tid,
                        WorkspaceInvitation.accepted_at.is_(None),
                        WorkspaceInvitation.revoked_at.is_(None),
                        WorkspaceInvitation.expires_at > now,
                    )
                )
                or 0
            )
        except Exception:
            # Tables not migrated yet: fail-open with zeroes so existing
            # workspaces are not bricked by the new gate.
            return 0, 0, 0
    return members + pending, members, pending


class MemberSeatLimitExceeded(Exception):
    """Raised when inviting or adding another member would exceed the
    workspace's member-seat cap. Carries the current usage, limit, and
    plan name so callers can surface a precise structured error.
    """

    def __init__(
        self,
        tenant_id: str,
        *,
        used: int,
        limit: int,
        plan: str,
        members: int,
        pending: int,
    ) -> None:
        self.tenant_id = tenant_id
        self.used = used
        self.limit = limit
        self.plan = plan
        self.members = members
        self.pending = pending
        super().__init__(
            f"member seat limit reached for workspace {tenant_id!r}: "
            f"{used}/{limit} on plan {plan!r} "
            f"({members} members, {pending} pending invitations)"
        )


def enforce_member_seat_capacity(
    tenant_id: str, *, extra: int = 1,
) -> tuple[int, int, str]:
    """Raise :class:`MemberSeatLimitExceeded` if adding ``extra`` member
    seats would exceed the workspace member-seat cap. Returns
    ``(used_after, limit, plan_name)`` on success.
    """
    tid = (tenant_id or "default").strip() or "default"
    limit, plan_name = member_seat_limit(tid)
    used, members, pending = member_seat_usage(tid)
    if extra < 0:
        extra = 0
    if limit > 0 and used + extra > limit:
        raise MemberSeatLimitExceeded(
            tid, used=used, limit=limit, plan=plan_name,
            members=members, pending=pending,
        )
    return used + extra, limit, plan_name


def snapshot(tenant_ids: Iterable[str] | None = None) -> list[dict]:
    """Return usage rows for the current period, optionally filtered."""
    when = _now()
    period = _period_for(when)
    out: list[dict] = []
    with session() as db:
        if tenant_ids:
            ids = list(tenant_ids)
            rows = db.execute(
                select(WorkspaceUsage).where(
                    WorkspaceUsage.tenant_id.in_(ids),
                    WorkspaceUsage.period == period,
                )
            ).scalars().all()
        else:
            rows = db.execute(
                select(WorkspaceUsage).where(WorkspaceUsage.period == period)
            ).scalars().all()
    for r in rows:
        plan, cap, seats = get_plan(r.tenant_id)
        seats_used = seat_usage(r.tenant_id)
        out.append({
            "tenant_id": r.tenant_id,
            "plan": plan.name,
            "limit": cap,
            "seats": seats,
            "seats_used": seats_used,
            "seats_remaining": max(0, seats - seats_used),
            "used": int(r.predictions),
            "remaining": max(0, cap - int(r.predictions)),
            "period": period,
        })
    return out
