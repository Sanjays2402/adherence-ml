"""Sub-processor registry with per-workspace change notification and
acknowledgment (GDPR Art. 28(2), DPA notice obligations).

Enterprise procurement asks: "When you add or change a sub-processor,
how am I notified, and where is my workspace's record that we
acknowledged the change before it took effect?" Posting a static
markdown list does not satisfy that. This module owns the
operator-managed registry, the per-tenant acknowledgment log, and the
public read view used by the trust center.

Design
------
* ``Subprocessor`` rows are the live registry: name, purpose, data
  categories, region, status (``active`` | ``removed``). Operators
  publish, update, or remove rows; every state change emits a
  ``SubprocessorChange`` row.
* ``SubprocessorChange`` rows are the append-only notification log,
  one per add/update/remove with ``effective_at`` and a short
  ``summary``. The trust center surfaces upcoming changes for the
  notice window (default 30 days).
* ``SubprocessorAcknowledgment`` is per-workspace, one row per
  ``(tenant_id, change_id, subject)``. Tenant-scoped: a workspace can
  only see and write its own acks. Re-acknowledging is idempotent.

Helpers compute the set of changes that a given tenant has not yet
acknowledged so the UI can show a banner and so a downstream policy
hook can decide whether to merely warn or to gate traffic.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    desc,
    select,
)
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from adherence_common.db import Base, session
from adherence_common.logging import get_logger

log = get_logger(__name__)

STATUSES: frozenset[str] = frozenset({"active", "removed"})
CHANGE_TYPES: frozenset[str] = frozenset({"added", "updated", "removed"})

# Notice window the trust center advertises. New sub-processors should
# be added with ``effective_at`` at least this far in the future so
# every customer has time to object or migrate.
DEFAULT_NOTICE_DAYS = 30


class Subprocessor(Base):
    """Current registry row, one per third-party processor.

    ``name`` is the unique business identifier. Editing purpose, data
    categories, or region produces an ``updated`` change row; setting
    ``status='removed'`` produces a ``removed`` change row. Identity is
    preserved across edits so the acknowledgment ties back to the same
    processor over time.
    """

    __tablename__ = "subprocessors"
    __table_args__ = (
        UniqueConstraint("name", name="uq_subprocessor_name"),
        Index("ix_subprocessor_status", "status"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(128), nullable=False)
    purpose = Column(String(512), nullable=False)
    data_categories = Column(String(512), nullable=False)
    region = Column(String(128), nullable=False)
    url = Column(String(512), nullable=True)
    status = Column(String(16), nullable=False, default="active")
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    created_by = Column(String(128), nullable=True)


class SubprocessorChange(Base):
    """Append-only notification row.

    One row per add/update/remove. ``effective_at`` is the date the
    change takes effect; the difference between ``announced_at`` and
    ``effective_at`` is the notice window the trust center displays.
    """

    __tablename__ = "subprocessor_changes"
    __table_args__ = (
        Index("ix_subproc_change_effective", "effective_at"),
        Index("ix_subproc_change_subprocessor", "subprocessor_id"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    subprocessor_id = Column(Integer, ForeignKey("subprocessors.id"), nullable=False)
    name_snapshot = Column(String(128), nullable=False)
    change_type = Column(String(16), nullable=False)
    summary = Column(Text, nullable=False)
    announced_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    effective_at = Column(DateTime, nullable=False)
    created_by = Column(String(128), nullable=True)


class SubprocessorAcknowledgment(Base):
    """One acknowledgment by a specific principal in a tenant.

    Strictly tenant-scoped via ``tenant_id``. Unique on
    ``(tenant_id, change_id, subject)`` so re-clicking does not inflate
    the audit count, but different subjects in the same workspace each
    produce their own row.
    """

    __tablename__ = "subprocessor_acknowledgments"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "change_id", "subject",
            name="uq_subproc_ack",
        ),
        Index("ix_subproc_ack_tenant", "tenant_id"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    change_id = Column(Integer, ForeignKey("subprocessor_changes.id"), nullable=False)
    subject = Column(String(128), nullable=False)
    subject_role = Column(String(16), nullable=False)
    acknowledged_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    ip = Column(String(64), nullable=True)
    user_agent = Column(String(512), nullable=True)
    request_id = Column(String(32), nullable=True)


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SubprocessorView:
    id: int
    name: str
    purpose: str
    data_categories: str
    region: str
    url: Optional[str]
    status: str
    created_at: datetime
    updated_at: datetime
    created_by: Optional[str]


@dataclass(frozen=True)
class ChangeView:
    id: int
    subprocessor_id: int
    name: str
    change_type: str
    summary: str
    announced_at: datetime
    effective_at: datetime
    created_by: Optional[str]


@dataclass(frozen=True)
class AckView:
    id: int
    tenant_id: str
    change_id: int
    subject: str
    subject_role: str
    acknowledged_at: datetime
    ip: Optional[str]
    user_agent: Optional[str]
    request_id: Optional[str]


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class DuplicateSubprocessor(Exception):
    """Raised when registering a name that already exists."""


class UnknownSubprocessor(Exception):
    """Raised when updating or removing a name that is not registered."""


class UnknownChange(Exception):
    """Raised when acknowledging a change_id that does not exist."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _norm_name(name: str) -> str:
    n = (name or "").strip()
    if not n or len(n) > 128:
        raise ValueError("name must be a non-empty string up to 128 chars")
    return n


def _norm_status(status: str) -> str:
    s = (status or "").strip().lower()
    if s not in STATUSES:
        raise ValueError(
            f"invalid status {status!r}; expected one of {sorted(STATUSES)}"
        )
    return s


def _norm_effective_at(effective_at: Optional[datetime]) -> datetime:
    if effective_at is None:
        return _now() + timedelta(days=DEFAULT_NOTICE_DAYS)
    eff = effective_at
    if eff.tzinfo is not None:
        eff = eff.astimezone(timezone.utc).replace(tzinfo=None)
    return eff


# ---------------------------------------------------------------------------
# Registry mutations (operator/admin plane; never tenant-scoped)
# ---------------------------------------------------------------------------


def register_subprocessor(
    *,
    name: str,
    purpose: str,
    data_categories: str,
    region: str,
    url: Optional[str] = None,
    summary: Optional[str] = None,
    effective_at: Optional[datetime] = None,
    created_by: Optional[str] = None,
) -> tuple[SubprocessorView, ChangeView]:
    """Register a new sub-processor and emit an ``added`` change row.

    Raises :class:`DuplicateSubprocessor` if ``name`` already exists.
    """
    n = _norm_name(name)
    if not purpose:
        raise ValueError("purpose is required")
    if not data_categories:
        raise ValueError("data_categories is required")
    if not region:
        raise ValueError("region is required")
    eff = _norm_effective_at(effective_at)
    body = summary or f"Added sub-processor {n} ({purpose})."
    try:
        with session() as s:
            row = Subprocessor(
                name=n,
                purpose=purpose[:512],
                data_categories=data_categories[:512],
                region=region[:128],
                url=(url[:512] if url else None),
                status="active",
                created_by=(created_by[:128] if created_by else None),
            )
            s.add(row)
            s.flush()
            change = SubprocessorChange(
                subprocessor_id=int(row.id),
                name_snapshot=n,
                change_type="added",
                summary=body,
                effective_at=eff,
                created_by=(created_by[:128] if created_by else None),
            )
            s.add(change)
            s.commit()
            return _to_view(row), _to_change(change)
    except IntegrityError as exc:
        raise DuplicateSubprocessor(f"{n!r} already registered") from exc


def update_subprocessor(
    *,
    name: str,
    purpose: Optional[str] = None,
    data_categories: Optional[str] = None,
    region: Optional[str] = None,
    url: Optional[str] = None,
    summary: Optional[str] = None,
    effective_at: Optional[datetime] = None,
    created_by: Optional[str] = None,
) -> tuple[SubprocessorView, ChangeView]:
    """Update fields on an existing sub-processor and emit an
    ``updated`` change row that captures a one-line diff in the
    summary. Raises :class:`UnknownSubprocessor` if the name is not
    registered. No-op edits still emit a change row so the audit
    trail records the operator action.
    """
    n = _norm_name(name)
    eff = _norm_effective_at(effective_at)
    with session() as s:
        row = s.execute(
            select(Subprocessor).where(Subprocessor.name == n)
        ).scalar_one_or_none()
        if row is None:
            raise UnknownSubprocessor(f"{n!r} is not registered")
        diffs: list[str] = []
        if purpose is not None and purpose != row.purpose:
            diffs.append(f"purpose: {row.purpose!r} -> {purpose!r}")
            row.purpose = purpose[:512]
        if data_categories is not None and data_categories != row.data_categories:
            diffs.append(
                f"data_categories: {row.data_categories!r} -> {data_categories!r}"
            )
            row.data_categories = data_categories[:512]
        if region is not None and region != row.region:
            diffs.append(f"region: {row.region!r} -> {region!r}")
            row.region = region[:128]
        if url is not None and url != (row.url or ""):
            diffs.append(f"url: {row.url!r} -> {url!r}")
            row.url = url[:512] if url else None
        row.updated_at = _now()
        body = summary or (
            "Updated " + n + ": " + "; ".join(diffs)
            if diffs
            else f"Reviewed {n}; no field changes."
        )
        change = SubprocessorChange(
            subprocessor_id=int(row.id),
            name_snapshot=n,
            change_type="updated",
            summary=body,
            effective_at=eff,
            created_by=(created_by[:128] if created_by else None),
        )
        s.add(change)
        s.commit()
        return _to_view(row), _to_change(change)


def remove_subprocessor(
    *,
    name: str,
    summary: Optional[str] = None,
    effective_at: Optional[datetime] = None,
    created_by: Optional[str] = None,
) -> tuple[SubprocessorView, ChangeView]:
    """Mark a sub-processor as removed and emit a ``removed`` change
    row. The registry row is preserved so historical acknowledgments
    still resolve. Raises :class:`UnknownSubprocessor` if absent.
    """
    n = _norm_name(name)
    eff = _norm_effective_at(effective_at)
    with session() as s:
        row = s.execute(
            select(Subprocessor).where(Subprocessor.name == n)
        ).scalar_one_or_none()
        if row is None:
            raise UnknownSubprocessor(f"{n!r} is not registered")
        row.status = "removed"
        row.updated_at = _now()
        change = SubprocessorChange(
            subprocessor_id=int(row.id),
            name_snapshot=n,
            change_type="removed",
            summary=summary or f"Removed sub-processor {n}.",
            effective_at=eff,
            created_by=(created_by[:128] if created_by else None),
        )
        s.add(change)
        s.commit()
        return _to_view(row), _to_change(change)


# ---------------------------------------------------------------------------
# Read paths (public for the registry; tenant-scoped for acks)
# ---------------------------------------------------------------------------


def list_subprocessors(*, include_removed: bool = False) -> list[SubprocessorView]:
    stmt = select(Subprocessor).order_by(Subprocessor.name.asc())
    if not include_removed:
        stmt = stmt.where(Subprocessor.status == "active")
    with session() as s:
        return [_to_view(r) for r in s.execute(stmt).scalars().all()]


def list_changes(*, limit: int = 200) -> list[ChangeView]:
    stmt = (
        select(SubprocessorChange)
        .order_by(desc(SubprocessorChange.announced_at), desc(SubprocessorChange.id))
        .limit(max(1, min(int(limit), 1000)))
    )
    with session() as s:
        return [_to_change(r) for r in s.execute(stmt).scalars().all()]


def get_change(change_id: int) -> Optional[ChangeView]:
    with session() as s:
        row = s.get(SubprocessorChange, int(change_id))
        return _to_change(row) if row else None


def record_acknowledgment(
    *,
    tenant_id: str,
    change_id: int,
    subject: str,
    subject_role: str,
    ip: Optional[str] = None,
    user_agent: Optional[str] = None,
    request_id: Optional[str] = None,
) -> AckView:
    """Record one acknowledgment. Idempotent on
    ``(tenant_id, change_id, subject)``: a repeat returns the existing
    row instead of erroring.

    Raises :class:`UnknownChange` if ``change_id`` does not exist.
    """
    tid = (tenant_id or "default").strip()[:64]
    sub = (subject or "").strip()[:128]
    if not sub:
        raise ValueError("subject is required to record acknowledgment")
    role = (subject_role or "viewer").strip().lower()[:16]
    cid = int(change_id)

    with session() as s:
        change = s.get(SubprocessorChange, cid)
        if change is None:
            raise UnknownChange(f"change {cid} does not exist")
        try:
            row = SubprocessorAcknowledgment(
                tenant_id=tid,
                change_id=cid,
                subject=sub,
                subject_role=role,
                ip=(ip[:64] if ip else None),
                user_agent=(user_agent[:512] if user_agent else None),
                request_id=(request_id[:32] if request_id else None),
            )
            s.add(row)
            s.commit()
            return _to_ack(row)
        except IntegrityError:
            s.rollback()
            existing = s.execute(
                select(SubprocessorAcknowledgment).where(
                    SubprocessorAcknowledgment.tenant_id == tid,
                    SubprocessorAcknowledgment.change_id == cid,
                    SubprocessorAcknowledgment.subject == sub,
                )
            ).scalar_one()
            return _to_ack(existing)


def list_acknowledgments(
    tenant_id: str,
    *,
    change_id: Optional[int] = None,
    limit: int = 200,
) -> list[AckView]:
    """Strictly tenant-scoped: never returns rows from another tenant."""
    tid = (tenant_id or "default").strip()[:64]
    stmt = select(SubprocessorAcknowledgment).where(
        SubprocessorAcknowledgment.tenant_id == tid
    )
    if change_id is not None:
        stmt = stmt.where(SubprocessorAcknowledgment.change_id == int(change_id))
    stmt = stmt.order_by(
        desc(SubprocessorAcknowledgment.acknowledged_at),
        desc(SubprocessorAcknowledgment.id),
    ).limit(max(1, min(int(limit), 1000)))
    with session() as s:
        return [_to_ack(r) for r in s.execute(stmt).scalars().all()]


def outstanding_changes(tenant_id: str) -> list[ChangeView]:
    """Changes the tenant has not yet acknowledged, newest first.

    Used by the UI banner and by any future enforcement hook that
    wants to gate destructive traffic when a notice has gone unread
    past its effective date.
    """
    tid = (tenant_id or "default").strip()[:64]
    with session() as s:
        ack_ids_stmt = select(SubprocessorAcknowledgment.change_id).where(
            SubprocessorAcknowledgment.tenant_id == tid
        )
        acked = {int(x) for x in s.execute(ack_ids_stmt).scalars().all()}
        stmt = select(SubprocessorChange).order_by(
            desc(SubprocessorChange.announced_at),
            desc(SubprocessorChange.id),
        )
        rows = s.execute(stmt).scalars().all()
        return [_to_change(r) for r in rows if int(r.id) not in acked]


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _to_view(row: Subprocessor) -> SubprocessorView:
    return SubprocessorView(
        id=int(row.id),
        name=str(row.name),
        purpose=str(row.purpose),
        data_categories=str(row.data_categories),
        region=str(row.region),
        url=(str(row.url) if row.url else None),
        status=str(row.status),
        created_at=row.created_at,
        updated_at=row.updated_at,
        created_by=(str(row.created_by) if row.created_by else None),
    )


def _to_change(row: SubprocessorChange) -> ChangeView:
    return ChangeView(
        id=int(row.id),
        subprocessor_id=int(row.subprocessor_id),
        name=str(row.name_snapshot),
        change_type=str(row.change_type),
        summary=str(row.summary),
        announced_at=row.announced_at,
        effective_at=row.effective_at,
        created_by=(str(row.created_by) if row.created_by else None),
    )


def _to_ack(row: SubprocessorAcknowledgment) -> AckView:
    return AckView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        change_id=int(row.change_id),
        subject=str(row.subject),
        subject_role=str(row.subject_role),
        acknowledged_at=row.acknowledged_at,
        ip=(str(row.ip) if row.ip else None),
        user_agent=(str(row.user_agent) if row.user_agent else None),
        request_id=(str(row.request_id) if row.request_id else None),
    )


def _safe_init_for_tests() -> None:
    """Test helper: ensure tables exist on the current engine."""
    from adherence_common.db import _engine

    Base.metadata.create_all(_engine())
