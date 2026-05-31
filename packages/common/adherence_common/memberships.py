"""Workspace memberships and email invitations.

Enterprise procurement needs a first-class way to invite people into a
workspace, manage their role, and remove them — without handing out
long-lived API keys. This module owns:

* :class:`WorkspaceMember` — one row per ``(tenant_id, subject)`` granting
  a role inside that workspace. ``subject`` is whatever identity the rest
  of the API recognises (an email for human users, a service id for bots).
* :class:`WorkspaceInvitation` — pending or resolved invite. The accept
  token is stored hashed; the plaintext is returned exactly once at
  creation time and again in the audit row's redacted summary.

The FastAPI layer in :mod:`adherence_api.routes.memberships` exposes these
as ``/v1/workspace/members`` and ``/v1/workspace/invitations``. Every
mutation is audit-logged and tenant-scoped via the principal.

Design notes:

* Tables live alongside the rest of ``adherence_common.db`` so the
  idempotent ``init_db()`` picks them up automatically.
* Roles allowed: ``admin | service | viewer`` to mirror the API key /
  JWT role vocabulary already used in :mod:`adherence_common.auth`.
* Invite tokens are 256-bit URL-safe randoms hashed with sha256 before
  persistence (same shape as API key records). The plaintext never
  touches the DB or the audit row.
"""
from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable

from sqlalchemy import (
    Column,
    DateTime,
    Integer,
    String,
    UniqueConstraint,
    select,
)

from adherence_common.db import Base, session

ROLES: frozenset[str] = frozenset({"admin", "service", "viewer"})
DEFAULT_INVITE_TTL_HOURS = 168  # 7 days


class WorkspaceMember(Base):
    """A user (or service account) granted access to a workspace.

    Unique on ``(tenant_id, subject)``. ``subject`` is matched
    case-insensitively for email-shaped identities but stored verbatim
    so audit logs keep the form the inviter typed.
    """

    __tablename__ = "workspace_members"
    __table_args__ = (
        UniqueConstraint("tenant_id", "subject_lower", name="uq_member_tenant_subject"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    subject = Column(String(256), nullable=False)
    subject_lower = Column(String(256), index=True, nullable=False)
    role = Column(String(16), nullable=False, default="viewer")
    added_by = Column(String(128), nullable=True)
    added_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class WorkspaceInvitation(Base):
    """Pending or resolved invitation to join a workspace.

    Only one *pending* invite per ``(tenant_id, email)`` is allowed; the
    create endpoint rejects duplicates. Accepted, expired, or revoked
    rows stay around as immutable audit trail.
    """

    __tablename__ = "workspace_invitations"

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    email = Column(String(256), index=True, nullable=False)
    role = Column(String(16), nullable=False, default="viewer")
    token_hash = Column(String(64), index=True, nullable=False)
    invited_by = Column(String(128), nullable=True)
    expires_at = Column(DateTime, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    accepted_at = Column(DateTime, nullable=True, index=True)
    accepted_by = Column(String(128), nullable=True)
    revoked_at = Column(DateTime, nullable=True, index=True)
    revoked_by = Column(String(128), nullable=True)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _normalise_email(email: str) -> str:
    return email.strip().lower()


def _normalise_subject(subject: str) -> str:
    return subject.strip().lower()


def normalise_role(role: str) -> str:
    r = (role or "").strip().lower()
    if r not in ROLES:
        raise ValueError(f"invalid role {role!r}; expected one of {sorted(ROLES)}")
    return r


# ---------------------------------------------------------------------------
# Member operations
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class MemberView:
    id: int
    tenant_id: str
    subject: str
    role: str
    added_by: str | None
    added_at: datetime
    updated_at: datetime


def _to_member_view(row: WorkspaceMember) -> MemberView:
    return MemberView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        subject=str(row.subject),
        role=str(row.role),
        added_by=row.added_by,
        added_at=row.added_at,
        updated_at=row.updated_at,
    )


def list_members(tenant_id: str) -> list[MemberView]:
    tid = (tenant_id or "default").strip() or "default"
    with session() as db:
        rows = db.execute(
            select(WorkspaceMember)
            .where(WorkspaceMember.tenant_id == tid)
            .order_by(WorkspaceMember.added_at.asc())
        ).scalars().all()
    return [_to_member_view(r) for r in rows]


def get_member(tenant_id: str, subject: str) -> MemberView | None:
    tid = (tenant_id or "default").strip() or "default"
    sub_l = _normalise_subject(subject)
    with session() as db:
        row = db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.tenant_id == tid,
                WorkspaceMember.subject_lower == sub_l,
            )
        ).scalar_one_or_none()
    return _to_member_view(row) if row else None


def upsert_member(
    tenant_id: str,
    subject: str,
    role: str,
    added_by: str | None,
) -> MemberView:
    """Insert or update a membership row. Returns the resulting view."""
    tid = (tenant_id or "default").strip() or "default"
    sub = subject.strip()
    if not sub:
        raise ValueError("subject required")
    sub_l = _normalise_subject(sub)
    role_n = normalise_role(role)
    now = _now()
    with session() as db:
        row = db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.tenant_id == tid,
                WorkspaceMember.subject_lower == sub_l,
            )
        ).scalar_one_or_none()
        if row is None:
            row = WorkspaceMember(
                tenant_id=tid,
                subject=sub,
                subject_lower=sub_l,
                role=role_n,
                added_by=added_by,
                added_at=now,
                updated_at=now,
            )
            db.add(row)
        else:
            row.role = role_n
            row.updated_at = now
        db.commit()
        db.refresh(row)
        return _to_member_view(row)


def update_member_role(
    tenant_id: str,
    subject: str,
    role: str,
) -> MemberView | None:
    tid = (tenant_id or "default").strip() or "default"
    sub_l = _normalise_subject(subject)
    role_n = normalise_role(role)
    with session() as db:
        row = db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.tenant_id == tid,
                WorkspaceMember.subject_lower == sub_l,
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        row.role = role_n
        row.updated_at = _now()
        db.commit()
        db.refresh(row)
        return _to_member_view(row)


def remove_member(tenant_id: str, subject: str) -> MemberView | None:
    tid = (tenant_id or "default").strip() or "default"
    sub_l = _normalise_subject(subject)
    with session() as db:
        row = db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.tenant_id == tid,
                WorkspaceMember.subject_lower == sub_l,
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        view = _to_member_view(row)
        db.delete(row)
        db.commit()
        return view


def count_owners(tenant_id: str) -> int:
    """Number of admin (owner-equivalent) members. Used to keep at least
    one admin in the workspace at all times.
    """
    tid = (tenant_id or "default").strip() or "default"
    with session() as db:
        rows = db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.tenant_id == tid,
                WorkspaceMember.role == "admin",
            )
        ).scalars().all()
    return len(rows)


# ---------------------------------------------------------------------------
# Invitation operations
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class InvitationView:
    id: int
    tenant_id: str
    email: str
    role: str
    invited_by: str | None
    expires_at: datetime
    created_at: datetime
    accepted_at: datetime | None
    accepted_by: str | None
    revoked_at: datetime | None
    revoked_by: str | None

    @property
    def state(self) -> str:
        if self.revoked_at is not None:
            return "revoked"
        if self.accepted_at is not None:
            return "accepted"
        if self.expires_at <= _now():
            return "expired"
        return "pending"


def _to_invite_view(row: WorkspaceInvitation) -> InvitationView:
    return InvitationView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        email=str(row.email),
        role=str(row.role),
        invited_by=row.invited_by,
        expires_at=row.expires_at,
        created_at=row.created_at,
        accepted_at=row.accepted_at,
        accepted_by=row.accepted_by,
        revoked_at=row.revoked_at,
        revoked_by=row.revoked_by,
    )


class DuplicateInvitation(Exception):
    """Raised when a pending invite already exists for the email."""


def create_invitation(
    tenant_id: str,
    email: str,
    role: str,
    invited_by: str | None,
    ttl_hours: int = DEFAULT_INVITE_TTL_HOURS,
) -> tuple[str, InvitationView]:
    """Create a new pending invitation. Returns ``(plaintext_token, view)``.

    The plaintext token is the only value the caller can hand to the
    invitee; only its sha256 hash is persisted. If a pending invite
    already exists for ``(tenant_id, email)``, raises
    :class:`DuplicateInvitation`.
    """
    tid = (tenant_id or "default").strip() or "default"
    em = _normalise_email(email)
    if "@" not in em or len(em) < 3:
        raise ValueError("invalid email")
    role_n = normalise_role(role)
    if ttl_hours <= 0 or ttl_hours > 24 * 90:
        raise ValueError("ttl_hours must be between 1 and 2160")
    now = _now()
    expires = now + timedelta(hours=ttl_hours)

    with session() as db:
        # Reject duplicate pending invites.
        existing = db.execute(
            select(WorkspaceInvitation).where(
                WorkspaceInvitation.tenant_id == tid,
                WorkspaceInvitation.email == em,
                WorkspaceInvitation.accepted_at.is_(None),
                WorkspaceInvitation.revoked_at.is_(None),
            )
        ).scalars().all()
        if any(r.expires_at > now for r in existing):
            raise DuplicateInvitation(
                f"a pending invitation already exists for {em!r} in workspace {tid!r}"
            )
        token = secrets.token_urlsafe(32)
        row = WorkspaceInvitation(
            tenant_id=tid,
            email=em,
            role=role_n,
            token_hash=_hash_token(token),
            invited_by=invited_by,
            expires_at=expires,
            created_at=now,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return token, _to_invite_view(row)


def list_invitations(
    tenant_id: str,
    *,
    include_resolved: bool = False,
) -> list[InvitationView]:
    tid = (tenant_id or "default").strip() or "default"
    stmt = select(WorkspaceInvitation).where(WorkspaceInvitation.tenant_id == tid)
    if not include_resolved:
        stmt = stmt.where(
            WorkspaceInvitation.accepted_at.is_(None),
            WorkspaceInvitation.revoked_at.is_(None),
        )
    stmt = stmt.order_by(WorkspaceInvitation.created_at.desc())
    with session() as db:
        rows = db.execute(stmt).scalars().all()
    return [_to_invite_view(r) for r in rows]


def get_invitation(invite_id: int, tenant_id: str) -> InvitationView | None:
    tid = (tenant_id or "default").strip() or "default"
    with session() as db:
        row = db.execute(
            select(WorkspaceInvitation).where(
                WorkspaceInvitation.id == invite_id,
                WorkspaceInvitation.tenant_id == tid,
            )
        ).scalar_one_or_none()
    return _to_invite_view(row) if row else None


def revoke_invitation(
    invite_id: int,
    tenant_id: str,
    revoked_by: str | None,
) -> InvitationView | None:
    tid = (tenant_id or "default").strip() or "default"
    now = _now()
    with session() as db:
        row = db.execute(
            select(WorkspaceInvitation).where(
                WorkspaceInvitation.id == invite_id,
                WorkspaceInvitation.tenant_id == tid,
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        if row.accepted_at is not None or row.revoked_at is not None:
            return _to_invite_view(row)
        row.revoked_at = now
        row.revoked_by = revoked_by
        db.commit()
        db.refresh(row)
        return _to_invite_view(row)


def preview_invitation(token: str) -> InvitationView | None:
    """Look up an invite by plaintext token without consuming it.

    Returns the view regardless of state so the UI can show a precise
    "expired" / "already accepted" message. Returns ``None`` only when
    no row matches the token at all.
    """
    if not token:
        return None
    h = _hash_token(token)
    with session() as db:
        row = db.execute(
            select(WorkspaceInvitation).where(WorkspaceInvitation.token_hash == h)
        ).scalar_one_or_none()
    return _to_invite_view(row) if row else None


@dataclass(frozen=True)
class AcceptResult:
    invitation: InvitationView
    member: MemberView


class InvitationError(Exception):
    """Raised when an invite cannot be accepted."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def accept_invitation(
    token: str,
    subject: str,
    *,
    expected_email: str | None = None,
) -> AcceptResult:
    """Consume an invite and create / upgrade the member row.

    ``subject`` is the caller's identity (JWT ``sub`` or API key
    principal). ``expected_email`` is an optional second check: when the
    caller has a verified email (from JWT or SSO), it must match the
    invited address case-insensitively.

    Raises :class:`InvitationError` with a ``code`` of ``not_found``,
    ``revoked``, ``expired``, ``already_accepted``, ``email_mismatch``,
    or ``subject_required``.
    """
    if not (subject or "").strip():
        raise InvitationError("subject_required", "caller subject required")
    h = _hash_token(token or "")
    now = _now()
    with session() as db:
        row = db.execute(
            select(WorkspaceInvitation).where(WorkspaceInvitation.token_hash == h)
        ).scalar_one_or_none()
        if row is None:
            raise InvitationError("not_found", "invitation not found")
        if row.revoked_at is not None:
            raise InvitationError("revoked", "invitation has been revoked")
        if row.accepted_at is not None:
            raise InvitationError("already_accepted", "invitation already accepted")
        if row.expires_at <= now:
            raise InvitationError("expired", "invitation has expired")
        if expected_email and _normalise_email(expected_email) != _normalise_email(row.email):
            raise InvitationError(
                "email_mismatch",
                "signed-in email does not match the invited address",
            )
        # Commit the membership inside the same transaction-of-record so
        # we never accept-without-membership or vice versa.
        tid = str(row.tenant_id)
        sub_clean = subject.strip()
        sub_l = _normalise_subject(sub_clean)
        member = db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.tenant_id == tid,
                WorkspaceMember.subject_lower == sub_l,
            )
        ).scalar_one_or_none()
        if member is None:
            member = WorkspaceMember(
                tenant_id=tid,
                subject=sub_clean,
                subject_lower=sub_l,
                role=str(row.role),
                added_by=row.invited_by,
                added_at=now,
                updated_at=now,
            )
            db.add(member)
        else:
            # Upgrade role only if the invite grants higher privileges.
            # Order: admin > service > viewer.
            rank = {"viewer": 0, "service": 1, "admin": 2}
            if rank.get(str(row.role), 0) > rank.get(str(member.role), 0):
                member.role = str(row.role)
            member.updated_at = now
        row.accepted_at = now
        row.accepted_by = sub_clean
        db.commit()
        db.refresh(row)
        db.refresh(member)
        return AcceptResult(
            invitation=_to_invite_view(row),
            member=_to_member_view(member),
        )


def purge_expired(before: datetime | None = None) -> int:
    """Mark expired pending invites as revoked. Returns the count touched.

    Intended for a periodic cleanup task; safe to call ad-hoc. Pending
    rows whose ``expires_at`` has passed are converted to ``revoked``
    with ``revoked_by='system:expiry'``.
    """
    cutoff = before or _now()
    touched = 0
    with session() as db:
        rows = db.execute(
            select(WorkspaceInvitation).where(
                WorkspaceInvitation.accepted_at.is_(None),
                WorkspaceInvitation.revoked_at.is_(None),
                WorkspaceInvitation.expires_at <= cutoff,
            )
        ).scalars().all()
        for r in rows:
            r.revoked_at = cutoff
            r.revoked_by = "system:expiry"
            touched += 1
        if touched:
            db.commit()
    return touched
