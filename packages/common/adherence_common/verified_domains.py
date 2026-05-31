"""Per-workspace verified email domains and SSO auto-join.

Enterprise procurement asks: when our IT rolls out SSO, can new
employees from ``acme.com`` land in the Acme workspace automatically,
without each one needing a hand-typed invite? Yes: a workspace admin
adds ``acme.com`` to the workspace's verified-domain list, and on the
next OIDC exchange any signed-in user whose email matches that domain
is added as a member with the workspace's default role.

This module owns:

* :class:`VerifiedDomain` — one row per ``(tenant_id, domain)``. Domain
  is normalised (lowercase, stripped, no leading ``@``). ``default_role``
  is the role new auto-joined members get; ``auto_join_enabled`` lets an
  admin pause auto-join without dropping the verified record (useful
  during an audit).
* CRUD helpers used by ``adherence_api.routes.verified_domains`` and the
  SSO exchange path in ``adherence_api.routes.sso``.
* :func:`resolve_auto_join` — given an email, return the matching
  ``(tenant_id, role)`` if exactly one verified-domain row claims it,
  else ``None``. Returning ``None`` for ambiguous matches is deliberate:
  silently picking one tenant when two have claimed the same domain
  would be a cross-tenant data leak waiting to happen.

Roles allowed mirror :mod:`adherence_common.memberships`:
``admin | service | viewer``. Anything else is rejected at the API
boundary and the helper layer.
"""
from __future__ import annotations

import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Iterable, Optional

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Integer,
    String,
    UniqueConstraint,
    select,
)

from adherence_common.db import Base, session
from adherence_common.memberships import (
    ROLES,
    WorkspaceMember,
    _normalise_subject,
    upsert_member,
)


_DOMAIN_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")


class VerifiedDomain(Base):
    """A workspace-owned claim on an email domain.

    Unique on ``(tenant_id, domain)``. A given domain may appear in
    multiple workspaces only when at most one of them has
    ``auto_join_enabled=True``; the resolver refuses to pick a winner
    otherwise.
    """

    __tablename__ = "workspace_verified_domains"
    __table_args__ = (
        UniqueConstraint("tenant_id", "domain", name="uq_verified_domain_tenant"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    domain = Column(String(253), index=True, nullable=False)
    default_role = Column(String(16), nullable=False, default="viewer")
    auto_join_enabled = Column(Boolean, nullable=False, default=True)
    # DNS TXT verification. ``verification_token`` is the random secret
    # the workspace owner must publish at ``_adherence-ml-verify.<domain>``
    # as ``adherence-ml-verify=<token>``. Until ``verified_at`` is set
    # the row is *pending* and :func:`resolve_auto_join` ignores it, so
    # an unverified claim cannot capture inbound SSO sign-ins for a
    # domain the workspace does not actually control.
    verification_token = Column(String(64), nullable=False, default="")
    verified_at = Column(DateTime, nullable=True)
    added_by = Column(String(128), nullable=True)
    added_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


# ---------------------------------------------------------------------------
# DNS verification constants & helpers
# ---------------------------------------------------------------------------

TXT_HOST_PREFIX = "_adherence-ml-verify"
TXT_VALUE_PREFIX = "adherence-ml-verify="


def _new_token() -> str:
    return secrets.token_hex(16)


class DnsVerificationError(Exception):
    """Raised when DNS lookup or TXT match fails.

    Reasons: ``txt_not_found``, ``token_mismatch_dns``, ``dns_lookup_failed``,
    ``not_found``.
    """


TxtResolver = Callable[[str], Iterable[str]]


def _default_txt_resolver(name: str) -> list[str]:
    """Live DNS lookup; lazy import keeps dnspython a soft dependency."""
    try:
        import dns.resolver  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise DnsVerificationError("dns_lookup_failed") from exc
    try:
        answers = dns.resolver.resolve(name, "TXT", lifetime=5.0)
    except Exception as exc:
        msg = exc.__class__.__name__
        if msg in {"NXDOMAIN", "NoAnswer", "NoNameservers"}:
            raise DnsVerificationError("txt_not_found") from exc
        raise DnsVerificationError("dns_lookup_failed") from exc
    out: list[str] = []
    for rdata in answers:
        try:
            for chunk in rdata.strings:  # type: ignore[attr-defined]
                if isinstance(chunk, bytes):
                    out.append(chunk.decode("utf-8", errors="replace"))
                else:
                    out.append(str(chunk))
        except Exception:
            out.append(str(rdata))
    return out


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def normalise_domain(value: str) -> str:
    """Lowercase, strip whitespace and a leading ``@``. Raise on garbage."""
    d = (value or "").strip().lower().lstrip("@")
    if not d or not _DOMAIN_RE.match(d):
        raise ValueError(f"invalid email domain: {value!r}")
    return d


def normalise_role(role: str) -> str:
    r = (role or "").strip().lower()
    if r not in ROLES:
        raise ValueError(f"invalid role {role!r}; expected one of {sorted(ROLES)}")
    return r


def _domain_of(email: str) -> str:
    if not email or "@" not in email:
        return ""
    return email.rsplit("@", 1)[1].strip().lower()


def dns_txt_name(domain: str) -> str:
    return f"{TXT_HOST_PREFIX}.{normalise_domain(domain)}"


def dns_txt_value(token: str) -> str:
    return f"{TXT_VALUE_PREFIX}{token}"


@dataclass(frozen=True)
class VerifiedDomainView:
    id: int
    tenant_id: str
    domain: str
    default_role: str
    auto_join_enabled: bool
    verification_token: str
    verified_at: Optional[datetime]
    added_by: Optional[str]
    added_at: datetime
    updated_at: datetime

    @property
    def status(self) -> str:
        return "verified" if self.verified_at is not None else "pending"

    @property
    def txt_record_name(self) -> str:
        return dns_txt_name(self.domain)

    @property
    def txt_record_value(self) -> str:
        return dns_txt_value(self.verification_token)


def _to_view(row: VerifiedDomain) -> VerifiedDomainView:
    return VerifiedDomainView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        domain=str(row.domain),
        default_role=str(row.default_role),
        auto_join_enabled=bool(row.auto_join_enabled),
        verification_token=str(row.verification_token or ""),
        verified_at=row.verified_at,
        added_by=row.added_by,
        added_at=row.added_at,
        updated_at=row.updated_at,
    )


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

class DuplicateDomain(Exception):
    """Raised when ``(tenant_id, domain)`` already exists for the workspace."""


def list_domains(tenant_id: str) -> list[VerifiedDomainView]:
    with session() as db:
        rows = (
            db.execute(
                select(VerifiedDomain)
                .where(VerifiedDomain.tenant_id == tenant_id)
                .order_by(VerifiedDomain.domain.asc())
            )
            .scalars()
            .all()
        )
        return [_to_view(r) for r in rows]


def get_domain(tenant_id: str, domain: str) -> Optional[VerifiedDomainView]:
    d = normalise_domain(domain)
    with session() as db:
        row = db.execute(
            select(VerifiedDomain).where(
                VerifiedDomain.tenant_id == tenant_id,
                VerifiedDomain.domain == d,
            )
        ).scalar_one_or_none()
        return _to_view(row) if row is not None else None


def add_domain(
    tenant_id: str,
    domain: str,
    *,
    default_role: str = "viewer",
    auto_join_enabled: bool = True,
    added_by: Optional[str] = None,
) -> VerifiedDomainView:
    d = normalise_domain(domain)
    role = normalise_role(default_role)
    now = _now()
    with session() as db:
        existing = db.execute(
            select(VerifiedDomain).where(
                VerifiedDomain.tenant_id == tenant_id,
                VerifiedDomain.domain == d,
            )
        ).scalar_one_or_none()
        if existing is not None:
            raise DuplicateDomain(f"{d!r} already verified for tenant {tenant_id!r}")
        row = VerifiedDomain(
            tenant_id=tenant_id,
            domain=d,
            default_role=role,
            auto_join_enabled=auto_join_enabled,
            verification_token=_new_token(),
            verified_at=None,
            added_by=added_by,
            added_at=now,
            updated_at=now,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return _to_view(row)


def rotate_verification_token(
    tenant_id: str, domain: str
) -> Optional[VerifiedDomainView]:
    """Mint a new TXT verification token and reset the row to pending.

    Useful if a previously published TXT record leaked or the owner
    wants to start fresh. Auto-join is paused until the new token is
    proved via :func:`verify_domain_dns`.
    """
    d = normalise_domain(domain)
    with session() as db:
        row = db.execute(
            select(VerifiedDomain).where(
                VerifiedDomain.tenant_id == tenant_id,
                VerifiedDomain.domain == d,
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        row.verification_token = _new_token()
        row.verified_at = None
        row.updated_at = _now()
        db.commit()
        db.refresh(row)
        return _to_view(row)


def verify_domain_dns(
    tenant_id: str,
    domain: str,
    *,
    resolver: Optional[TxtResolver] = None,
) -> VerifiedDomainView:
    """Look up the TXT record at ``_adherence-ml-verify.<domain>`` and
    flip the row to verified if ``adherence-ml-verify=<token>`` is
    present and matches the stored token for ``(tenant, domain)``.

    Raises :class:`DnsVerificationError` (reasons ``txt_not_found``,
    ``token_mismatch_dns``, ``dns_lookup_failed``, ``not_found``) on
    failure. Idempotent once verified.
    """
    d = normalise_domain(domain)
    with session() as db:
        row = db.execute(
            select(VerifiedDomain).where(
                VerifiedDomain.tenant_id == tenant_id,
                VerifiedDomain.domain == d,
            )
        ).scalar_one_or_none()
        if row is None:
            raise DnsVerificationError("not_found")
        if row.verified_at is not None:
            return _to_view(row)
        token = str(row.verification_token or "")
        if not token:
            row.verification_token = _new_token()
            db.commit()
            db.refresh(row)
            raise DnsVerificationError("txt_not_found")

    name = dns_txt_name(d)
    expected = dns_txt_value(token)
    resolve = resolver or _default_txt_resolver
    txts = list(resolve(name))
    if not txts:
        raise DnsVerificationError("txt_not_found")
    if expected not in txts:
        raise DnsVerificationError("token_mismatch_dns")

    with session() as db:
        row = db.execute(
            select(VerifiedDomain).where(
                VerifiedDomain.tenant_id == tenant_id,
                VerifiedDomain.domain == d,
            )
        ).scalar_one_or_none()
        if row is None:  # pragma: no cover - racing delete
            raise DnsVerificationError("not_found")
        row.verified_at = _now()
        row.updated_at = _now()
        db.commit()
        db.refresh(row)
        return _to_view(row)


def update_domain(
    tenant_id: str,
    domain: str,
    *,
    default_role: Optional[str] = None,
    auto_join_enabled: Optional[bool] = None,
) -> Optional[VerifiedDomainView]:
    d = normalise_domain(domain)
    with session() as db:
        row = db.execute(
            select(VerifiedDomain).where(
                VerifiedDomain.tenant_id == tenant_id,
                VerifiedDomain.domain == d,
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        if default_role is not None:
            row.default_role = normalise_role(default_role)
        if auto_join_enabled is not None:
            row.auto_join_enabled = bool(auto_join_enabled)
        row.updated_at = _now()
        db.commit()
        db.refresh(row)
        return _to_view(row)


def remove_domain(tenant_id: str, domain: str) -> Optional[VerifiedDomainView]:
    d = normalise_domain(domain)
    with session() as db:
        row = db.execute(
            select(VerifiedDomain).where(
                VerifiedDomain.tenant_id == tenant_id,
                VerifiedDomain.domain == d,
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        view = _to_view(row)
        db.delete(row)
        db.commit()
        return view


# ---------------------------------------------------------------------------
# SSO auto-join resolver
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AutoJoinResolution:
    """Outcome of looking up an email against verified-domain claims."""

    tenant_id: str
    role: str
    domain: str


def resolve_auto_join(email: str) -> Optional[AutoJoinResolution]:
    """Find the workspace that claims this email's domain for auto-join.

    Returns ``None`` if no enabled verified domain matches, or if two or
    more workspaces have an enabled claim on the same domain (ambiguous
    claims are refused rather than guessed).
    """
    d = _domain_of(email)
    if not d:
        return None
    with session() as db:
        rows = (
            db.execute(
                select(VerifiedDomain).where(
                    VerifiedDomain.domain == d,
                    VerifiedDomain.auto_join_enabled.is_(True),
                    VerifiedDomain.verified_at.is_not(None),
                )
            )
            .scalars()
            .all()
        )
    if len(rows) != 1:
        return None
    r = rows[0]
    return AutoJoinResolution(
        tenant_id=str(r.tenant_id),
        role=str(r.default_role),
        domain=str(r.domain),
    )


def auto_join_member(
    resolution: AutoJoinResolution,
    *,
    subject: str,
    added_by: str = "sso:auto-join",
) -> Optional[str]:
    """Add ``subject`` to ``resolution.tenant_id`` if they are not already a member.

    Returns the role granted on a fresh add, or ``None`` if the caller
    was already a member (we do not silently downgrade existing roles).
    """
    if not (subject or "").strip():
        return None
    from sqlalchemy import select as _select

    sub_l = _normalise_subject(subject)
    with session() as db:
        existing = db.execute(
            _select(WorkspaceMember).where(
                WorkspaceMember.tenant_id == resolution.tenant_id,
                WorkspaceMember.subject_lower == sub_l,
            )
        ).scalar_one_or_none()
        if existing is not None:
            return None
    upsert_member(
        resolution.tenant_id,
        subject,
        resolution.role,
        added_by,
    )
    return resolution.role
