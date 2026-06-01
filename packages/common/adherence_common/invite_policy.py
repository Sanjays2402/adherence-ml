"""Per-workspace invitation email-domain policy.

Enterprise IT does not want a workspace admin able to invite a
``@gmail.com`` or ``@personal.example`` address into the company tenant
by accident or as a back door. This module owns a small DB-backed
policy per workspace with two rule sets:

* ``allowlist`` domains: when at least one row exists, an invitation's
  email domain must match one of them or the create call is rejected.
  Acceptance is also re-checked so a domain removed after the invite
  was sent still blocks the join.
* ``blocklist`` domains: invitations whose email domain matches are
  always rejected, even when an allowlist row also matches. Useful for
  banning known personal mail providers without having to enumerate
  every corporate domain.

Domains are normalised lowercase. ``example.com`` matches the apex and
every subdomain (``a.example.com``, ``b.example.com``). Wildcards are
implicit: there is no ``*.`` syntax.

Empty policy = the gate is off for that workspace; ``create_invitation``
behaves exactly as before. This means a fresh tenant keeps the existing
behaviour and only locks down once an admin opts in.
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


RULE_KINDS = frozenset({"allow", "block"})

# RFC 1035 style: labels of 1-63 chars, letters/digits/hyphens, no
# leading or trailing hyphen, at least two labels.
_DOMAIN_RE = re.compile(
    r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$"
)


class InvitePolicyError(ValueError):
    """Raised when a caller-supplied domain / kind is invalid."""


class InviteDomainBlocked(Exception):
    """Raised when a policy rejects an invitation email domain.

    ``code`` is one of:

    * ``not_in_allowlist`` — workspace has an allowlist and ``domain`` is
      not on it.
    * ``in_blocklist`` — ``domain`` matches an explicit block rule.
    """

    def __init__(self, code: str, domain: str, message: str) -> None:
        self.code = code
        self.domain = domain
        super().__init__(message)


class WorkspaceInviteDomainRule(Base):
    """One row per ``(tenant_id, kind, domain)``.

    Append-and-delete only; rules are not edited in place. Removing the
    last allow row turns the allowlist off for the workspace. Removing
    every row of either kind turns that side of the policy off.
    """

    __tablename__ = "workspace_invite_domain_rules"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "kind", "domain",
            name="uq_invite_domain_rule_tenant_kind_domain",
        ),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    kind = Column(String(8), index=True, nullable=False)  # 'allow' | 'block'
    domain = Column(String(253), index=True, nullable=False)
    note = Column(String(256), nullable=True)
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


@dataclass(frozen=True)
class DomainRuleView:
    id: int
    tenant_id: str
    kind: str
    domain: str
    note: str | None
    created_by: str | None
    created_at: str


def _iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat() + "Z"


def _to_view(row: WorkspaceInviteDomainRule) -> DomainRuleView:
    return DomainRuleView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        kind=str(row.kind),
        domain=str(row.domain),
        note=(str(row.note) if row.note is not None else None),
        created_by=(str(row.created_by) if row.created_by is not None else None),
        created_at=_iso(row.created_at),
    )


def normalise_domain(raw: str) -> str:
    """Lowercase, strip whitespace and a leading ``@``. Validate shape."""
    if raw is None:
        raise InvitePolicyError("domain is required")
    s = str(raw).strip().lower()
    if s.startswith("@"):
        s = s[1:]
    if not s:
        raise InvitePolicyError("domain is required")
    if not _DOMAIN_RE.match(s):
        raise InvitePolicyError(f"invalid domain: {raw!r}")
    return s


def normalise_kind(raw: str) -> str:
    s = (raw or "").strip().lower()
    if s not in RULE_KINDS:
        raise InvitePolicyError(f"kind must be one of {sorted(RULE_KINDS)}")
    return s


def _email_domain(email: str) -> str:
    em = (email or "").strip().lower()
    if "@" not in em:
        raise InvitePolicyError(f"invalid email: {email!r}")
    return em.rsplit("@", 1)[1]


def _matches(rule_domain: str, candidate: str) -> bool:
    """``example.com`` matches ``example.com`` and any subdomain of it."""
    rule_domain = rule_domain.lower()
    candidate = candidate.lower()
    if rule_domain == candidate:
        return True
    return candidate.endswith("." + rule_domain)


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

def list_rules(tenant_id: str, *, kind: str | None = None) -> list[DomainRuleView]:
    tid = (tenant_id or "default").strip() or "default"
    with session() as db:
        stmt = select(WorkspaceInviteDomainRule).where(
            WorkspaceInviteDomainRule.tenant_id == tid
        )
        if kind is not None:
            stmt = stmt.where(WorkspaceInviteDomainRule.kind == normalise_kind(kind))
        stmt = stmt.order_by(
            WorkspaceInviteDomainRule.kind,
            WorkspaceInviteDomainRule.domain,
        )
        rows = db.execute(stmt).scalars().all()
        return [_to_view(r) for r in rows]


def add_rule(
    *,
    tenant_id: str,
    kind: str,
    domain: str,
    note: str | None = None,
    created_by: str | None = None,
) -> DomainRuleView:
    tid = (tenant_id or "default").strip() or "default"
    k = normalise_kind(kind)
    d = normalise_domain(domain)
    with session() as db:
        existing = db.execute(
            select(WorkspaceInviteDomainRule).where(
                WorkspaceInviteDomainRule.tenant_id == tid,
                WorkspaceInviteDomainRule.kind == k,
                WorkspaceInviteDomainRule.domain == d,
            )
        ).scalar_one_or_none()
        if existing is not None:
            raise InvitePolicyError(
                f"{k} rule for {d!r} already exists in workspace {tid!r}"
            )
        row = WorkspaceInviteDomainRule(
            tenant_id=tid,
            kind=k,
            domain=d,
            note=(note or None),
            created_by=created_by,
            created_at=datetime.utcnow(),
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return _to_view(row)


def remove_rule(*, tenant_id: str, rule_id: int) -> DomainRuleView | None:
    tid = (tenant_id or "default").strip() or "default"
    with session() as db:
        row = db.execute(
            select(WorkspaceInviteDomainRule).where(
                WorkspaceInviteDomainRule.tenant_id == tid,
                WorkspaceInviteDomainRule.id == int(rule_id),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        view = _to_view(row)
        db.delete(row)
        db.commit()
        return view


# ---------------------------------------------------------------------------
# Enforcement
# ---------------------------------------------------------------------------

def evaluate(tenant_id: str, email: str) -> None:
    """Raise :class:`InviteDomainBlocked` if ``email`` is rejected.

    Block rules win over allow rules. An empty policy is a no-op.
    """
    tid = (tenant_id or "default").strip() or "default"
    try:
        candidate = _email_domain(email)
    except InvitePolicyError:
        # Caller layer validates email shape; surface the same way it
        # always did rather than raise our blocked-domain exception.
        raise
    with session() as db:
        rows = db.execute(
            select(WorkspaceInviteDomainRule).where(
                WorkspaceInviteDomainRule.tenant_id == tid
            )
        ).scalars().all()
    if not rows:
        return
    blocks = [r for r in rows if str(r.kind) == "block"]
    allows = [r for r in rows if str(r.kind) == "allow"]
    for r in blocks:
        if _matches(str(r.domain), candidate):
            raise InviteDomainBlocked(
                "in_blocklist",
                candidate,
                f"email domain {candidate!r} is on the workspace blocklist",
            )
    if allows:
        if not any(_matches(str(r.domain), candidate) for r in allows):
            raise InviteDomainBlocked(
                "not_in_allowlist",
                candidate,
                f"email domain {candidate!r} is not on the workspace allowlist",
            )


def policy_summary(tenant_id: str) -> dict:
    """Compact view used by the admin console."""
    rules = list_rules(tenant_id)
    allow = [r for r in rules if r.kind == "allow"]
    block = [r for r in rules if r.kind == "block"]
    return {
        "tenant_id": (tenant_id or "default").strip() or "default",
        "allowlist_enforced": bool(allow),
        "blocklist_enforced": bool(block),
        "allow_domains": [r.domain for r in allow],
        "block_domains": [r.domain for r in block],
    }


__all__ = [
    "InvitePolicyError",
    "InviteDomainBlocked",
    "WorkspaceInviteDomainRule",
    "DomainRuleView",
    "RULE_KINDS",
    "normalise_domain",
    "normalise_kind",
    "list_rules",
    "add_rule",
    "remove_rule",
    "evaluate",
    "policy_summary",
]
