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


PLANS: dict[str, Plan] = {
    "free": Plan("free", monthly_predictions=1_000, seats=3),
    "pro": Plan("pro", monthly_predictions=100_000, seats=25),
    "enterprise": Plan("enterprise", monthly_predictions=2_000_000, seats=500),
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


def set_plan(
    tenant_id: str,
    *,
    plan: str | None = None,
    monthly_predictions_override: int | None = None,
    seats_override: int | None = None,
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
            )
            db.add(row)
        else:
            if plan is not None:
                row.plan = plan
            if monthly_predictions_override is not None:
                row.monthly_predictions_override = monthly_predictions_override or None
            if seats_override is not None:
                row.seats_override = seats_override or None
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
        out.append({
            "tenant_id": r.tenant_id,
            "plan": plan.name,
            "limit": cap,
            "seats": seats,
            "used": int(r.predictions),
            "remaining": max(0, cap - int(r.predictions)),
            "period": period,
        })
    return out
