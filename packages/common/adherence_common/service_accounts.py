"""Per-tenant Service Account / Non-Human Identity (NHI) register.

Enterprise procurement and SOC 2 / ISO 27001 auditors increasingly
ask for an inventory of every non-human identity that holds standing
credentials against the system: CI runners, ETL pipelines, third-party
integrations, monitoring probes, headless daemons. The asks are
consistent across frameworks:

* SOC 2 CC6.1, CC6.2, CC6.3: inventory of logical access, including
  service accounts, with documented owner and periodic review.
* ISO 27001 A.5.16, A.5.18, A.9.2.4, A.9.4.3: registration and
  de-registration of identifiers, management of secret authentication
  information, periodic review of access rights.
* NIST SP 800-53 IA-2(5), IA-4, IA-5: unique identification of
  non-organisational and shared accounts, identifier and authenticator
  management.
* CSA CCM IAM-02, IAM-06: account credential lifecycle, including
  rotation cadence and use of secrets management.

Without a documented register that names the human owner, the system
of record, the kind of credential, the scopes granted, when it was
last rotated, when it was last used, when it must next be reviewed,
and whether secrets are stored in a vault, a buyer's security team
treats the vendor as having "no service account governance" and the
deal stalls.

This module is the per-workspace register. It sits next to api_keys,
SCIM tokens, the SSO configuration, the access reviews module, and
the pentests / vendor risk / RoPA / DPIA / BCDR / incidents / SLA
registers so a workspace owner can produce a complete identity-
governance evidence pack without leaving the product.

Semantics
---------

* A workspace has zero or more service account entries. Each entry
  declares one non-human identity: a stable name, a kind
  (``ci``, ``etl``, ``integration``, ``webhook``, ``monitor``,
  ``daemon``, ``backup``, ``other``), the system of record (the
  external platform the identity authenticates into), the credential
  kind (``api_key``, ``oauth_client``, ``oidc_sa``, ``ssh_key``,
  ``certificate``, ``shared_secret``), the human owner (an email),
  a list of scopes, whether the secret is stored in a vault,
  rotation and review cadences in days, the timestamps of last
  rotation and last observed use, current status
  (``active``, ``suspended``, ``decommissioned``), and free text
  notes.
* ``next_rotation_due_at`` is derived from ``last_rotated_at`` plus
  ``rotation_cadence_days``. ``next_review_due_at`` is derived from
  ``last_reviewed_at`` (falling back to ``created_at``) plus
  ``review_cadence_days``.
* ``dormant_days`` is the number of days since ``last_used_at``.
* Entries are mutable; every change bumps a monotonic ``version``
  and the route layer writes an admin audit row.
* ``record_rotation`` refreshes ``last_rotated_at`` and bumps
  version. ``record_use`` updates ``last_used_at`` (intended for
  authenticated callers wiring in the identity, not for procurement
  inputs). ``record_review`` refreshes ``last_reviewed_at`` and
  bumps version.
* Entries can be decommissioned (status flip) and archived rather
  than hard-deleted, preserving the historical record for the
  auditor. Decommissioning is the operationally correct end-state
  for an NHI you no longer use; archival removes it from the active
  register while keeping the row.
* Every read and write is strictly scoped to the caller's tenant.
  There is no cross-tenant code path: ``tenant_id`` is part of every
  query.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import (
    Column,
    DateTime,
    Integer,
    String,
    Text,
    UniqueConstraint,
    select,
)

from adherence_common.db import Base, session


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

MIN_NAME_LEN = 2
MAX_NAME_LEN = 96
MAX_SYSTEM_LEN = 96
MAX_OWNER_LEN = 254
MAX_NOTES_LEN = 4096
MAX_SCOPE_ITEM_LEN = 96
MAX_SCOPES = 32

KINDS = (
    "ci",
    "etl",
    "integration",
    "webhook",
    "monitor",
    "daemon",
    "backup",
    "other",
)

CREDENTIAL_KINDS = (
    "api_key",
    "oauth_client",
    "oidc_sa",
    "ssh_key",
    "certificate",
    "shared_secret",
)

STATUSES = ("active", "suspended", "decommissioned")

DEFAULT_ROTATION_CADENCE_DAYS = 90
MIN_ROTATION_CADENCE_DAYS = 7
MAX_ROTATION_CADENCE_DAYS = 365 * 2

DEFAULT_REVIEW_CADENCE_DAYS = 180
MIN_REVIEW_CADENCE_DAYS = 30
MAX_REVIEW_CADENCE_DAYS = 365 * 2

# RFC 5322 lite: good enough for owner email validation, mirrors
# what verified_domains.py and workspace_contacts.py do elsewhere.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]*$")
_SCOPE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:\-]*$")


class ServiceAccountError(ValueError):
    """Raised when a service account entry input is invalid."""


def _clean(s: Optional[str], *, max_len: int) -> Optional[str]:
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    if len(t) > max_len:
        raise ServiceAccountError(f"value too long (max {max_len})")
    return t


def _name(v: str) -> str:
    if v is None:
        raise ServiceAccountError("name is required")
    t = str(v).strip()
    if len(t) < MIN_NAME_LEN:
        raise ServiceAccountError(
            f"name must be at least {MIN_NAME_LEN} characters"
        )
    if len(t) > MAX_NAME_LEN:
        raise ServiceAccountError(
            f"name must be at most {MAX_NAME_LEN} characters"
        )
    if not _NAME_RE.match(t):
        raise ServiceAccountError(
            "name must start with a letter or digit and contain only "
            "letters, digits, '.', '_' or '-'"
        )
    return t


def _system(v: str) -> str:
    t = (v or "").strip()
    if len(t) < 2:
        raise ServiceAccountError("system_of_record must be at least 2 characters")
    if len(t) > MAX_SYSTEM_LEN:
        raise ServiceAccountError(
            f"system_of_record must be at most {MAX_SYSTEM_LEN} characters"
        )
    return t


def _owner(v: str) -> str:
    t = (v or "").strip().lower()
    if not t:
        raise ServiceAccountError("owner_email is required")
    if len(t) > MAX_OWNER_LEN:
        raise ServiceAccountError(
            f"owner_email must be at most {MAX_OWNER_LEN} characters"
        )
    if not _EMAIL_RE.match(t):
        raise ServiceAccountError("owner_email must be a valid email address")
    return t


def _kind(v: str) -> str:
    t = (v or "").strip().lower()
    if t not in KINDS:
        raise ServiceAccountError(
            f"kind must be one of: {', '.join(KINDS)}"
        )
    return t


def _credential_kind(v: str) -> str:
    t = (v or "").strip().lower()
    if t not in CREDENTIAL_KINDS:
        raise ServiceAccountError(
            f"credential_kind must be one of: {', '.join(CREDENTIAL_KINDS)}"
        )
    return t


def _status(v: str) -> str:
    t = (v or "").strip().lower()
    if t not in STATUSES:
        raise ServiceAccountError(
            f"status must be one of: {', '.join(STATUSES)}"
        )
    return t


def _scopes(v: Optional[list[str]]) -> list[str]:
    if v is None:
        return []
    if not isinstance(v, (list, tuple)):
        raise ServiceAccountError("scopes must be a list of strings")
    out: list[str] = []
    seen: set[str] = set()
    for item in v:
        if item is None:
            continue
        t = str(item).strip()
        if not t:
            continue
        if len(t) > MAX_SCOPE_ITEM_LEN:
            raise ServiceAccountError(
                f"scope '{t[:20]}...' exceeds {MAX_SCOPE_ITEM_LEN} characters"
            )
        if not _SCOPE_RE.match(t):
            raise ServiceAccountError(
                f"scope {t!r} must contain only letters, digits, '.', "
                "'_', ':' or '-'"
            )
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
        if len(out) > MAX_SCOPES:
            raise ServiceAccountError(
                f"cannot register more than {MAX_SCOPES} scopes per identity"
            )
    return out


def _cadence(n: Optional[int], *, default: int, lo: int, hi: int, field: str) -> int:
    if n is None:
        return default
    try:
        v = int(n)
    except (TypeError, ValueError) as exc:
        raise ServiceAccountError(f"{field} must be an integer") from exc
    if v < lo or v > hi:
        raise ServiceAccountError(
            f"{field} must be between {lo} and {hi}"
        )
    return v


def _future_ok(ts: Optional[datetime], *, field: str) -> Optional[datetime]:
    if ts is None:
        return None
    if not isinstance(ts, datetime):
        raise ServiceAccountError(f"{field} must be a datetime")
    if ts > datetime.utcnow() + timedelta(days=1):
        raise ServiceAccountError(f"{field} cannot be in the future")
    return ts


def _join_scopes(items: list[str]) -> str:
    return "\n".join(items)


def _split_scopes(blob: Optional[str]) -> list[str]:
    if not blob:
        return []
    return [line for line in blob.split("\n") if line]


# ---------------------------------------------------------------------------
# ORM
# ---------------------------------------------------------------------------


class ServiceAccount(Base):
    """One non-human identity, scoped to a tenant.

    ``(tenant_id, name)`` is unique among active rows.
    """

    __tablename__ = "service_accounts"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "name", name="uq_service_accounts_tenant_name"
        ),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    name = Column(String(MAX_NAME_LEN), nullable=False)
    kind = Column(String(16), nullable=False, default="integration")
    system_of_record = Column(String(MAX_SYSTEM_LEN), nullable=False)
    credential_kind = Column(String(24), nullable=False, default="api_key")
    owner_email = Column(String(MAX_OWNER_LEN), nullable=False)
    scopes = Column(Text, nullable=True)  # newline-joined
    vault_managed = Column(Integer, nullable=False, default=0)
    rotation_cadence_days = Column(
        Integer, nullable=False, default=DEFAULT_ROTATION_CADENCE_DAYS
    )
    review_cadence_days = Column(
        Integer, nullable=False, default=DEFAULT_REVIEW_CADENCE_DAYS
    )
    last_rotated_at = Column(DateTime, nullable=True)
    last_reviewed_at = Column(DateTime, nullable=True)
    last_used_at = Column(DateTime, nullable=True)
    status = Column(String(16), nullable=False, default="active")
    notes = Column(Text, nullable=True)
    version = Column(Integer, default=1, nullable=False)
    created_by = Column(String(128), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_by = Column(String(128), nullable=True)
    updated_at = Column(DateTime, nullable=True)
    archived_by = Column(String(128), nullable=True)
    archived_at = Column(DateTime, nullable=True, index=True)


@dataclass(frozen=True)
class ServiceAccountView:
    id: int
    tenant_id: str
    name: str
    kind: str
    system_of_record: str
    credential_kind: str
    owner_email: str
    scopes: list[str]
    vault_managed: bool
    rotation_cadence_days: int
    review_cadence_days: int
    last_rotated_at: Optional[str]
    last_reviewed_at: Optional[str]
    last_used_at: Optional[str]
    next_rotation_due_at: str
    next_review_due_at: str
    rotation_overdue: bool
    review_overdue: bool
    dormant_days: Optional[int]
    status: str
    notes: Optional[str]
    version: int
    created_by: str
    created_at: str
    updated_by: Optional[str]
    updated_at: Optional[str]
    archived_by: Optional[str]
    archived_at: Optional[str]
    active: bool


def _next_rotation(row: ServiceAccount) -> datetime:
    base = row.last_rotated_at or row.created_at or datetime.utcnow()
    cadence = int(row.rotation_cadence_days or DEFAULT_ROTATION_CADENCE_DAYS)
    return base + timedelta(days=cadence)


def _next_review(row: ServiceAccount) -> datetime:
    base = row.last_reviewed_at or row.created_at or datetime.utcnow()
    cadence = int(row.review_cadence_days or DEFAULT_REVIEW_CADENCE_DAYS)
    return base + timedelta(days=cadence)


def _to_view(row: ServiceAccount, *, now: Optional[datetime] = None) -> ServiceAccountView:
    n = now or datetime.utcnow()
    nxt_rot = _next_rotation(row)
    nxt_rev = _next_review(row)
    rot_overdue = bool(
        row.archived_at is None
        and row.status == "active"
        and nxt_rot < n
    )
    rev_overdue = bool(
        row.archived_at is None
        and row.status == "active"
        and nxt_rev < n
    )
    dormant: Optional[int] = None
    if row.last_used_at is not None:
        dormant = max(0, (n - row.last_used_at).days)
    return ServiceAccountView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        name=str(row.name),
        kind=str(row.kind or "integration"),
        system_of_record=str(row.system_of_record or ""),
        credential_kind=str(row.credential_kind or "api_key"),
        owner_email=str(row.owner_email or ""),
        scopes=_split_scopes(row.scopes),
        vault_managed=bool(int(row.vault_managed or 0)),
        rotation_cadence_days=int(
            row.rotation_cadence_days or DEFAULT_ROTATION_CADENCE_DAYS
        ),
        review_cadence_days=int(
            row.review_cadence_days or DEFAULT_REVIEW_CADENCE_DAYS
        ),
        last_rotated_at=(
            row.last_rotated_at.isoformat() if row.last_rotated_at else None
        ),
        last_reviewed_at=(
            row.last_reviewed_at.isoformat() if row.last_reviewed_at else None
        ),
        last_used_at=(
            row.last_used_at.isoformat() if row.last_used_at else None
        ),
        next_rotation_due_at=nxt_rot.isoformat(),
        next_review_due_at=nxt_rev.isoformat(),
        rotation_overdue=rot_overdue,
        review_overdue=rev_overdue,
        dormant_days=dormant,
        status=str(row.status or "active"),
        notes=(str(row.notes) if row.notes else None),
        version=int(row.version or 1),
        created_by=str(row.created_by),
        created_at=row.created_at.isoformat() if row.created_at else "",
        updated_by=(str(row.updated_by) if row.updated_by else None),
        updated_at=(row.updated_at.isoformat() if row.updated_at else None),
        archived_by=(str(row.archived_by) if row.archived_by else None),
        archived_at=(row.archived_at.isoformat() if row.archived_at else None),
        active=(row.archived_at is None),
    )


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------


def create_entry(
    *,
    tenant_id: str,
    name: str,
    kind: str,
    system_of_record: str,
    credential_kind: str,
    owner_email: str,
    created_by: str,
    scopes: Optional[list[str]] = None,
    vault_managed: bool = False,
    rotation_cadence_days: Optional[int] = None,
    review_cadence_days: Optional[int] = None,
    last_rotated_at: Optional[datetime] = None,
    last_reviewed_at: Optional[datetime] = None,
    last_used_at: Optional[datetime] = None,
    status: str = "active",
    notes: Optional[str] = None,
) -> ServiceAccountView:
    tid = (tenant_id or "default")[:64]
    cname = _name(name)
    ckind = _kind(kind)
    csystem = _system(system_of_record)
    ccred = _credential_kind(credential_kind)
    cowner = _owner(owner_email)
    cscopes = _scopes(scopes)
    cstatus = _status(status)
    cnotes = _clean(notes, max_len=MAX_NOTES_LEN)
    crot = _cadence(
        rotation_cadence_days,
        default=DEFAULT_ROTATION_CADENCE_DAYS,
        lo=MIN_ROTATION_CADENCE_DAYS,
        hi=MAX_ROTATION_CADENCE_DAYS,
        field="rotation_cadence_days",
    )
    crev = _cadence(
        review_cadence_days,
        default=DEFAULT_REVIEW_CADENCE_DAYS,
        lo=MIN_REVIEW_CADENCE_DAYS,
        hi=MAX_REVIEW_CADENCE_DAYS,
        field="review_cadence_days",
    )
    rot_ts = _future_ok(last_rotated_at, field="last_rotated_at")
    rev_ts = _future_ok(last_reviewed_at, field="last_reviewed_at")
    use_ts = _future_ok(last_used_at, field="last_used_at")
    actor = (created_by or "unknown")[:128]
    with session() as s:
        existing = s.execute(
            select(ServiceAccount).where(
                ServiceAccount.tenant_id == tid,
                ServiceAccount.name == cname,
                ServiceAccount.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if existing is not None:
            raise ServiceAccountError(
                f"a service account named {cname!r} already exists for this workspace"
            )
        row = ServiceAccount(
            tenant_id=tid,
            name=cname,
            kind=ckind,
            system_of_record=csystem,
            credential_kind=ccred,
            owner_email=cowner,
            scopes=_join_scopes(cscopes) if cscopes else None,
            vault_managed=1 if vault_managed else 0,
            rotation_cadence_days=crot,
            review_cadence_days=crev,
            last_rotated_at=rot_ts,
            last_reviewed_at=rev_ts,
            last_used_at=use_ts,
            status=cstatus,
            notes=cnotes,
            version=1,
            created_by=actor,
            created_at=datetime.utcnow(),
        )
        s.add(row)
        s.commit()
        s.refresh(row)
        return _to_view(row)


def update_entry(
    *,
    tenant_id: str,
    entry_id: int,
    updated_by: str,
    kind: Optional[str] = None,
    system_of_record: Optional[str] = None,
    credential_kind: Optional[str] = None,
    owner_email: Optional[str] = None,
    scopes: Optional[list[str]] = None,
    vault_managed: Optional[bool] = None,
    rotation_cadence_days: Optional[int] = None,
    review_cadence_days: Optional[int] = None,
    status: Optional[str] = None,
    notes: Optional[str] = None,
) -> Optional[ServiceAccountView]:
    """Update one entry, strictly scoped to ``tenant_id``."""
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(ServiceAccount).where(
                ServiceAccount.tenant_id == tid,
                ServiceAccount.id == int(entry_id),
                ServiceAccount.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        if kind is not None:
            row.kind = _kind(kind)
        if system_of_record is not None:
            row.system_of_record = _system(system_of_record)
        if credential_kind is not None:
            row.credential_kind = _credential_kind(credential_kind)
        if owner_email is not None:
            row.owner_email = _owner(owner_email)
        if scopes is not None:
            sc = _scopes(scopes)
            row.scopes = _join_scopes(sc) if sc else None
        if vault_managed is not None:
            row.vault_managed = 1 if vault_managed else 0
        if rotation_cadence_days is not None:
            row.rotation_cadence_days = _cadence(
                rotation_cadence_days,
                default=DEFAULT_ROTATION_CADENCE_DAYS,
                lo=MIN_ROTATION_CADENCE_DAYS,
                hi=MAX_ROTATION_CADENCE_DAYS,                field="rotation_cadence_days",
            )
        if review_cadence_days is not None:
            row.review_cadence_days = _cadence(
                review_cadence_days,
                default=DEFAULT_REVIEW_CADENCE_DAYS,
                lo=MIN_REVIEW_CADENCE_DAYS,
                hi=MAX_REVIEW_CADENCE_DAYS,
                field="review_cadence_days",
            )
        if status is not None:
            row.status = _status(status)
        if notes is not None:
            row.notes = _clean(notes, max_len=MAX_NOTES_LEN)
        row.version = int(row.version or 1) + 1
        row.updated_by = (updated_by or "unknown")[:128]
        row.updated_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return _to_view(row)


def record_rotation(
    *,
    tenant_id: str,
    entry_id: int,
    rotated_by: str,
    rotated_at: Optional[datetime] = None,
) -> Optional[ServiceAccountView]:
    """Record that the credential was rotated.

    Refreshes ``last_rotated_at``, bumps ``version``. Returns
    ``None`` when the entry is not active for this tenant.
    """
    tid = (tenant_id or "default")[:64]
    when = _future_ok(rotated_at, field="rotated_at") or datetime.utcnow()
    with session() as s:
        row = s.execute(
            select(ServiceAccount).where(
                ServiceAccount.tenant_id == tid,
                ServiceAccount.id == int(entry_id),
                ServiceAccount.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        if row.status == "decommissioned":
            raise ServiceAccountError(
                "cannot record rotation on a decommissioned identity"
            )
        row.last_rotated_at = when
        row.version = int(row.version or 1) + 1
        row.updated_by = (rotated_by or "unknown")[:128]
        row.updated_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return _to_view(row)


def record_review(
    *,
    tenant_id: str,
    entry_id: int,
    reviewed_by: str,
    reviewed_at: Optional[datetime] = None,
) -> Optional[ServiceAccountView]:
    """Record that the identity's access was reviewed."""
    tid = (tenant_id or "default")[:64]
    when = _future_ok(reviewed_at, field="reviewed_at") or datetime.utcnow()
    with session() as s:
        row = s.execute(
            select(ServiceAccount).where(
                ServiceAccount.tenant_id == tid,
                ServiceAccount.id == int(entry_id),
                ServiceAccount.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        row.last_reviewed_at = when
        row.version = int(row.version or 1) + 1
        row.updated_by = (reviewed_by or "unknown")[:128]
        row.updated_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return _to_view(row)


def archive_entry(
    *,
    tenant_id: str,
    entry_id: int,
    archived_by: str,
) -> Optional[ServiceAccountView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(ServiceAccount).where(
                ServiceAccount.tenant_id == tid,
                ServiceAccount.id == int(entry_id),
                ServiceAccount.archived_at.is_(None),
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


def list_entries(
    *,
    tenant_id: str,
    include_archived: bool = False,
    status_filter: Optional[str] = None,
    limit: int = 200,
    offset: int = 0,
) -> list[ServiceAccountView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        q = select(ServiceAccount).where(ServiceAccount.tenant_id == tid)
        if not include_archived:
            q = q.where(ServiceAccount.archived_at.is_(None))
        if status_filter is not None:
            q = q.where(ServiceAccount.status == _status(status_filter))
        q = q.order_by(ServiceAccount.id.desc()).offset(int(offset)).limit(int(limit))
        return [_to_view(r) for r in s.execute(q).scalars().all()]


def get_entry(*, tenant_id: str, entry_id: int) -> Optional[ServiceAccountView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(ServiceAccount).where(
                ServiceAccount.tenant_id == tid,
                ServiceAccount.id == int(entry_id),
            )
        ).scalar_one_or_none()
        return _to_view(row) if row is not None else None


def active_count(tenant_id: str) -> int:
    tid = (tenant_id or "default")[:64]
    try:
        with session() as s:
            return len(
                s.execute(
                    select(ServiceAccount).where(
                        ServiceAccount.tenant_id == tid,
                        ServiceAccount.archived_at.is_(None),
                    )
                ).all()
            )
    except Exception:
        return 0


def rotation_overdue_count(tenant_id: str) -> int:
    tid = (tenant_id or "default")[:64]
    try:
        with session() as s:
            rows = s.execute(
                select(ServiceAccount).where(
                    ServiceAccount.tenant_id == tid,
                    ServiceAccount.archived_at.is_(None),
                    ServiceAccount.status == "active",
                )
            ).scalars().all()
    except Exception:
        return 0
    now = datetime.utcnow()
    return sum(1 for r in rows if _next_rotation(r) < now)


def review_overdue_count(tenant_id: str) -> int:
    tid = (tenant_id or "default")[:64]
    try:
        with session() as s:
            rows = s.execute(
                select(ServiceAccount).where(
                    ServiceAccount.tenant_id == tid,
                    ServiceAccount.archived_at.is_(None),
                    ServiceAccount.status == "active",
                )
            ).scalars().all()
    except Exception:
        return 0
    now = datetime.utcnow()
    return sum(1 for r in rows if _next_review(r) < now)


__all__ = [
    "KINDS",
    "CREDENTIAL_KINDS",
    "STATUSES",
    "DEFAULT_ROTATION_CADENCE_DAYS",
    "MIN_ROTATION_CADENCE_DAYS",
    "MAX_ROTATION_CADENCE_DAYS",
    "DEFAULT_REVIEW_CADENCE_DAYS",
    "MIN_REVIEW_CADENCE_DAYS",
    "MAX_REVIEW_CADENCE_DAYS",
    "MIN_NAME_LEN",
    "MAX_NAME_LEN",
    "MAX_SYSTEM_LEN",
    "MAX_OWNER_LEN",
    "MAX_NOTES_LEN",
    "MAX_SCOPE_ITEM_LEN",
    "MAX_SCOPES",
    "ServiceAccountError",
    "ServiceAccount",
    "ServiceAccountView",
    "create_entry",
    "update_entry",
    "record_rotation",
    "record_review",
    "archive_entry",
    "list_entries",
    "get_entry",
    "active_count",
    "rotation_overdue_count",
    "review_overdue_count",
]
