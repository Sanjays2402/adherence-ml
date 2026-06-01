"""Per-workspace notification contact roles.

Enterprise procurement reviewers always ask the same question: when
something goes wrong, who do we email? A single ``support@`` shared by
the operator is not enough. Each buyer wants their own routing:

* ``security``            — vulnerability reports, scanner findings.
* ``privacy``             — GDPR / CCPA data subject correspondence,
                            DPO of record.
* ``billing``             — invoice and renewal contact.
* ``abuse``               — abuse reports targeted at this workspace.
* ``technical``           — outage / incident bridge contact.
* ``breach_notification`` — Article 33 / state breach mail recipient.

This module owns one row per ``(tenant_id, role)`` so a workspace can
designate at most one address per role. Updating a role rewrites the
row in place but always appends to the admin audit log with the
before / after diff so SOC2 reviewers can reconstruct who changed the
breach-notification mailbox and when.

A workspace with no contacts on file falls back to the operator
defaults exposed via ``/.well-known/security.txt``. Setting any role
overrides only that role; the rest still inherit.

Roles are a closed enum. Email is RFC-5321 lite (one ``@``, no
control chars, length capped). Optional ``label`` is for human display
in the admin console (e.g. ``"Sec Eng on-call"``).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
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


ROLES: tuple[str, ...] = (
    "security",
    "privacy",
    "billing",
    "abuse",
    "technical",
    "breach_notification",
)
ROLE_SET = frozenset(ROLES)


# Per-role human-readable description for the admin console + API docs.
ROLE_DESCRIPTIONS: dict[str, str] = {
    "security": "Vulnerability reports and scanner findings.",
    "privacy": "GDPR / CCPA correspondence and data subject requests.",
    "billing": "Invoices, renewals, and dunning notices.",
    "abuse": "Abuse reports targeted at this workspace.",
    "technical": "Outage and incident bridge contact.",
    "breach_notification": "Article 33 and state breach notifications.",
}


# Closed list of fall-back operator addresses surfaced when a workspace
# has not set its own contact for a role. Kept in sync with
# ``services/api/adherence_api/routes/well_known.py`` _SECURITY_TXT.
OPERATOR_DEFAULTS: dict[str, str] = {
    "security": "security@adherence.ml",
    "privacy": "privacy@adherence.ml",
    "billing": "billing@adherence.ml",
    "abuse": "abuse@adherence.ml",
    "technical": "support@adherence.ml",
    "breach_notification": "security@adherence.ml",
}


_EMAIL_RE = re.compile(
    r"^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,253}\.[A-Za-z]{2,}$"
)
_LABEL_MAX = 80


class WorkspaceContactError(ValueError):
    """Raised when a caller-supplied role / email / label is invalid."""


class WorkspaceContact(Base):
    """One row per ``(tenant_id, role)``.

    Updates rewrite the row in place but the prior value is preserved
    in the admin audit ``before`` field. Removing the contact deletes
    the row, after which the role inherits from
    :data:`OPERATOR_DEFAULTS`.
    """

    __tablename__ = "workspace_contacts"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "role",
            name="uq_workspace_contact_tenant_role",
        ),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    role = Column(String(32), index=True, nullable=False)
    email = Column(String(320), nullable=False)
    label = Column(String(_LABEL_MAX), nullable=True)
    updated_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


@dataclass(frozen=True)
class ContactView:
    role: str
    email: str
    label: str | None
    updated_by: str | None
    updated_at: str
    source: str  # 'workspace' or 'operator_default'


def _iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat() + "Z"


def normalise_role(raw: str) -> str:
    s = (raw or "").strip().lower()
    if s not in ROLE_SET:
        raise WorkspaceContactError(
            f"role must be one of {sorted(ROLE_SET)}"
        )
    return s


def normalise_email(raw: str) -> str:
    if raw is None:
        raise WorkspaceContactError("email is required")
    s = str(raw).strip()
    if not s:
        raise WorkspaceContactError("email is required")
    if len(s) > 320:
        raise WorkspaceContactError("email exceeds 320 characters")
    if any(ord(ch) < 0x20 for ch in s):
        raise WorkspaceContactError("email contains control characters")
    # Local part case is preserved; domain is lowercased per RFC.
    if "@" not in s:
        raise WorkspaceContactError(f"invalid email: {raw!r}")
    local, _, domain = s.rpartition("@")
    s = f"{local}@{domain.lower()}"
    if not _EMAIL_RE.match(s):
        raise WorkspaceContactError(f"invalid email: {raw!r}")
    return s


def normalise_label(raw: str | None) -> str | None:
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    if len(s) > _LABEL_MAX:
        raise WorkspaceContactError(
            f"label exceeds {_LABEL_MAX} characters"
        )
    if any(ord(ch) < 0x20 for ch in s):
        raise WorkspaceContactError("label contains control characters")
    return s


def _row_to_view(row: WorkspaceContact) -> ContactView:
    return ContactView(
        role=str(row.role),
        email=str(row.email),
        label=(str(row.label) if row.label is not None else None),
        updated_by=(str(row.updated_by) if row.updated_by is not None else None),
        updated_at=_iso(row.updated_at),
        source="workspace",
    )


def _operator_view(role: str) -> ContactView:
    return ContactView(
        role=role,
        email=OPERATOR_DEFAULTS[role],
        label=None,
        updated_by=None,
        updated_at="",
        source="operator_default",
    )


# ---------------------------------------------------------------------------
# Read API
# ---------------------------------------------------------------------------

def list_contacts(tenant_id: str) -> list[ContactView]:
    """Return every role with its effective contact.

    Roles with no workspace override resolve to the operator default
    and are marked ``source='operator_default'``. Order is stable: the
    declaration order of :data:`ROLES`.
    """
    tid = (tenant_id or "default").strip() or "default"
    with session() as db:
        rows = db.execute(
            select(WorkspaceContact).where(
                WorkspaceContact.tenant_id == tid
            )
        ).scalars().all()
    by_role = {str(r.role): r for r in rows}
    out: list[ContactView] = []
    for role in ROLES:
        row = by_role.get(role)
        if row is not None:
            out.append(_row_to_view(row))
        else:
            out.append(_operator_view(role))
    return out


def get_contact(tenant_id: str, role: str) -> ContactView:
    """Return the effective contact for ``role`` (workspace or default)."""
    r = normalise_role(role)
    tid = (tenant_id or "default").strip() or "default"
    with session() as db:
        row = db.execute(
            select(WorkspaceContact).where(
                WorkspaceContact.tenant_id == tid,
                WorkspaceContact.role == r,
            )
        ).scalar_one_or_none()
    if row is None:
        return _operator_view(r)
    return _row_to_view(row)


# ---------------------------------------------------------------------------
# Mutating API
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SetContactResult:
    view: ContactView
    before: dict | None  # the prior row as a plain dict, or None if first set
    created: bool


def set_contact(
    *,
    tenant_id: str,
    role: str,
    email: str,
    label: str | None = None,
    updated_by: str | None = None,
) -> SetContactResult:
    """Create or replace the contact for ``(tenant_id, role)``.

    Returns the new view plus the prior workspace-scoped value (or
    ``None`` if this is the first time the role is set), so the caller
    can log an audit diff.
    """
    r = normalise_role(role)
    e = normalise_email(email)
    lab = normalise_label(label)
    tid = (tenant_id or "default").strip() or "default"
    with session() as db:
        row = db.execute(
            select(WorkspaceContact).where(
                WorkspaceContact.tenant_id == tid,
                WorkspaceContact.role == r,
            )
        ).scalar_one_or_none()
        now = datetime.utcnow()
        if row is None:
            row = WorkspaceContact(
                tenant_id=tid,
                role=r,
                email=e,
                label=lab,
                updated_by=updated_by,
                created_at=now,
                updated_at=now,
            )
            db.add(row)
            db.commit()
            db.refresh(row)
            return SetContactResult(
                view=_row_to_view(row),
                before=None,
                created=True,
            )
        before = {
            "role": str(row.role),
            "email": str(row.email),
            "label": (str(row.label) if row.label is not None else None),
        }
        row.email = e
        row.label = lab
        row.updated_by = updated_by
        row.updated_at = now
        db.commit()
        db.refresh(row)
        return SetContactResult(
            view=_row_to_view(row),
            before=before,
            created=False,
        )


@dataclass(frozen=True)
class DeleteContactResult:
    role: str
    before: dict | None  # None if there was nothing to delete


def delete_contact(
    *,
    tenant_id: str,
    role: str,
) -> DeleteContactResult:
    """Remove the workspace override for ``role``.

    After deletion the role inherits the operator default. Returns a
    ``before`` payload if a row was actually removed, or ``None`` if no
    workspace override existed.
    """
    r = normalise_role(role)
    tid = (tenant_id or "default").strip() or "default"
    with session() as db:
        row = db.execute(
            select(WorkspaceContact).where(
                WorkspaceContact.tenant_id == tid,
                WorkspaceContact.role == r,
            )
        ).scalar_one_or_none()
        if row is None:
            return DeleteContactResult(role=r, before=None)
        before = {
            "role": str(row.role),
            "email": str(row.email),
            "label": (str(row.label) if row.label is not None else None),
        }
        db.delete(row)
        db.commit()
        return DeleteContactResult(role=r, before=before)


# ---------------------------------------------------------------------------
# Resolution helper used by other subsystems (e.g. incident mail).
# ---------------------------------------------------------------------------

def resolve_email(tenant_id: str, role: str) -> str:
    """Return the effective email for ``role`` in this workspace.

    Falls back to :data:`OPERATOR_DEFAULTS` when the workspace has not
    set its own. Always returns a syntactically valid address.
    """
    view = get_contact(tenant_id, role)
    return view.email


def security_txt_lines(tenant_id: str) -> list[str]:
    """Render an RFC 9116 style ``security.txt`` body for this workspace.

    Used by the workspace admin console to show "here is what a
    researcher would see if they pulled your workspace contact card"
    without requiring the buyer to read the underlying DB rows.
    """
    contacts = {c.role: c for c in list_contacts(tenant_id)}
    lines: list[str] = []
    for role in ROLES:
        c = contacts[role]
        lines.append(f"# {role} ({c.source})")
        lines.append(f"Contact: mailto:{c.email}")
        if c.label:
            lines.append(f"# label: {c.label}")
    return lines


__all__ = [
    "ROLES",
    "ROLE_SET",
    "ROLE_DESCRIPTIONS",
    "OPERATOR_DEFAULTS",
    "WorkspaceContactError",
    "WorkspaceContact",
    "ContactView",
    "SetContactResult",
    "DeleteContactResult",
    "normalise_role",
    "normalise_email",
    "normalise_label",
    "list_contacts",
    "get_contact",
    "set_contact",
    "delete_contact",
    "resolve_email",
    "security_txt_lines",
]
