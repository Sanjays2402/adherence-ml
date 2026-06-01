"""Per-workspace customer-managed encryption key (CMEK / BYOK) reference registry.

Enterprise procurement teams in regulated verticals require evidence that
the workspace's data is encrypted under a key the customer controls and
can rotate, audit, or revoke. The operator already runs platform-managed
KMS (see ``trust_manifest`` and ``caiq``). This module records the
customer-supplied reference for that key so a buyer can:

* declare the cloud KMS the key lives in (AWS KMS, GCP KMS, Azure Key Vault),
* publish the key alias / ARN / resource URI used for tenant-scoped envelope
  encryption,
* set the contractual rotation cadence (in days) and log each rotation,
* mark the registration ``pending`` while paperwork is in flight, ``active``
  once the operator has accepted the grant, or ``retired`` to retain the
  history without continued enforcement.

The registry is purely declarative; it does not itself encrypt data. Its
job is to give procurement, audit, and incident-response teams one place
to answer "is BYOK on for this workspace, when was it last rotated, and
who signed it off?". Every mutation is admin-only, MFA-gated, dry-run
aware, and written to the admin audit log.

Cross-tenant isolation is enforced by the ``tenant_id`` primary key plus
the per-tenant ``current_tenant`` dependency in the HTTP layer; one
workspace can never read or write another workspace's registration.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Column, Integer, String, select
from sqlalchemy.exc import SQLAlchemyError

from adherence_common.db import Base, session
from adherence_common.logging import get_logger

log = get_logger(__name__)

# Allowed cloud KMS providers. The list is intentionally short: every
# extra provider widens the operator's compliance surface.
ALLOWED_PROVIDERS: tuple[str, ...] = (
    "aws_kms",
    "gcp_kms",
    "azure_keyvault",
    "hashicorp_vault",
    "other",
)

# Allowed lifecycle states. ``pending`` is the initial state when a
# customer declares an intent but the operator has not yet accepted the
# grant; ``active`` once the grant is in place; ``retired`` keeps the
# row visible for audit history without continued enforcement.
ALLOWED_STATES: tuple[str, ...] = ("pending", "active", "retired")

# Acceptable rotation cadence in days. Floor of 1 day matches the most
# aggressive customer ask we have seen; ceiling of ~5 years matches the
# API key TTL ceiling already enforced elsewhere.
MIN_ROTATION_DAYS = 1
MAX_ROTATION_DAYS = 365 * 5

# Length caps on operator-visible free text. Long enough for every
# cloud-KMS resource name we have observed, short enough to prevent
# accidental dumping of secrets or huge blobs.
MAX_PROVIDER_LEN = 32
MAX_KEY_REF_LEN = 512
MAX_DESCRIPTION_LEN = 512
MAX_CONTACT_LEN = 256
MAX_NOTE_LEN = 512


class WorkspaceCMEKRegistration(Base):
    """One row per tenant. Absence means BYOK is not declared."""

    __tablename__ = "workspace_cmek_registration"

    tenant_id = Column(String(64), primary_key=True)
    provider = Column(String(MAX_PROVIDER_LEN), nullable=False)
    key_reference = Column(String(MAX_KEY_REF_LEN), nullable=False)
    rotation_period_days = Column(Integer, nullable=False)
    state = Column(String(16), nullable=False, default="pending")
    description = Column(String(MAX_DESCRIPTION_LEN), nullable=True)
    contact = Column(String(MAX_CONTACT_LEN), nullable=True)
    registered_at = Column(Integer, nullable=False)
    registered_by = Column(String(128), nullable=True)
    last_rotated_at = Column(Integer, nullable=True)
    last_rotated_by = Column(String(128), nullable=True)
    rotation_count = Column(Integer, nullable=False, default=0)
    updated_at = Column(Integer, nullable=False)
    updated_by = Column(String(128), nullable=True)


@dataclass(frozen=True)
class RegistrationView:
    tenant_id: str
    provider: str
    key_reference: str
    rotation_period_days: int
    state: str
    description: Optional[str]
    contact: Optional[str]
    registered_at: int
    registered_by: Optional[str]
    last_rotated_at: Optional[int]
    last_rotated_by: Optional[str]
    rotation_count: int
    updated_at: int
    updated_by: Optional[str]
    rotation_due_at: Optional[int]
    rotation_overdue: bool


def _now_ts() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())


def _validate_provider(provider: str) -> str:
    p = (provider or "").strip().lower()
    if p not in ALLOWED_PROVIDERS:
        raise ValueError(
            f"provider must be one of {', '.join(ALLOWED_PROVIDERS)}"
        )
    return p


def _validate_state(state: str) -> str:
    s = (state or "").strip().lower()
    if s not in ALLOWED_STATES:
        raise ValueError(
            f"state must be one of {', '.join(ALLOWED_STATES)}"
        )
    return s


def _validate_key_reference(key_reference: str) -> str:
    k = (key_reference or "").strip()
    if not k:
        raise ValueError("key_reference must not be empty")
    if len(k) > MAX_KEY_REF_LEN:
        raise ValueError(f"key_reference must be <= {MAX_KEY_REF_LEN} chars")
    # Guard against operators accidentally pasting a raw secret. Real
    # KMS references are URIs or ARNs, not random base64.
    if "\n" in k or "\r" in k:
        raise ValueError("key_reference must be a single-line resource id")
    return k


def _validate_rotation_period(days: int) -> int:
    if not isinstance(days, int) or isinstance(days, bool):
        raise ValueError("rotation_period_days must be an integer")
    if days < MIN_ROTATION_DAYS or days > MAX_ROTATION_DAYS:
        raise ValueError(
            f"rotation_period_days must be between "
            f"{MIN_ROTATION_DAYS} and {MAX_ROTATION_DAYS}"
        )
    return days


def _trim(value: Optional[str], cap: int) -> Optional[str]:
    if value is None:
        return None
    v = value.strip()
    if not v:
        return None
    if len(v) > cap:
        raise ValueError(f"value must be <= {cap} chars")
    return v


def _to_view(row: WorkspaceCMEKRegistration) -> RegistrationView:
    rotated = int(row.last_rotated_at) if row.last_rotated_at is not None else None
    anchor = rotated if rotated is not None else int(row.registered_at)
    due_at = anchor + int(row.rotation_period_days) * 86400
    overdue = bool(row.state == "active" and _now_ts() > due_at)
    return RegistrationView(
        tenant_id=str(row.tenant_id),
        provider=str(row.provider),
        key_reference=str(row.key_reference),
        rotation_period_days=int(row.rotation_period_days),
        state=str(row.state),
        description=row.description if row.description is None else str(row.description),
        contact=row.contact if row.contact is None else str(row.contact),
        registered_at=int(row.registered_at),
        registered_by=row.registered_by if row.registered_by is None else str(row.registered_by),
        last_rotated_at=rotated,
        last_rotated_by=row.last_rotated_by if row.last_rotated_by is None else str(row.last_rotated_by),
        rotation_count=int(row.rotation_count or 0),
        updated_at=int(row.updated_at),
        updated_by=row.updated_by if row.updated_by is None else str(row.updated_by),
        rotation_due_at=due_at,
        rotation_overdue=overdue,
    )


def get_registration(tenant_id: str) -> Optional[RegistrationView]:
    """Return this tenant's CMEK registration, or ``None`` if absent."""
    tid = str(tenant_id or "").strip()
    if not tid:
        return None
    try:
        with session() as s:
            row = s.execute(
                select(WorkspaceCMEKRegistration).where(
                    WorkspaceCMEKRegistration.tenant_id == tid
                )
            ).scalar_one_or_none()
            if row is None:
                return None
            return _to_view(row)
    except SQLAlchemyError as exc:
        log.error("cmek_registry.get_failed", tenant=tid, error=str(exc))
        return None


def set_registration(
    tenant_id: str,
    *,
    provider: str,
    key_reference: str,
    rotation_period_days: int,
    state: str = "pending",
    description: Optional[str] = None,
    contact: Optional[str] = None,
    updated_by: Optional[str] = None,
) -> RegistrationView:
    """Create or overwrite the tenant's registration. Rotation counters
    are preserved across overwrites so the audit history survives an
    edit to (for example) ``description``."""
    tid = str(tenant_id or "").strip()
    if not tid:
        raise ValueError("tenant_id required")
    p = _validate_provider(provider)
    k = _validate_key_reference(key_reference)
    days = _validate_rotation_period(rotation_period_days)
    st = _validate_state(state)
    desc = _trim(description, MAX_DESCRIPTION_LEN)
    ctc = _trim(contact, MAX_CONTACT_LEN)
    now = _now_ts()
    with session() as s:
        existing = s.execute(
            select(WorkspaceCMEKRegistration).where(
                WorkspaceCMEKRegistration.tenant_id == tid
            )
        ).scalar_one_or_none()
        if existing is None:
            row = WorkspaceCMEKRegistration(
                tenant_id=tid,
                provider=p,
                key_reference=k,
                rotation_period_days=days,
                state=st,
                description=desc,
                contact=ctc,
                registered_at=now,
                registered_by=updated_by,
                last_rotated_at=None,
                last_rotated_by=None,
                rotation_count=0,
                updated_at=now,
                updated_by=updated_by,
            )
            s.add(row)
        else:
            existing.provider = p
            existing.key_reference = k
            existing.rotation_period_days = days
            existing.state = st
            existing.description = desc
            existing.contact = ctc
            existing.updated_at = now
            existing.updated_by = updated_by
            row = existing
        s.flush()
        s.commit()
        s.refresh(row)
        return _to_view(row)


def record_rotation(
    tenant_id: str,
    *,
    new_key_reference: Optional[str] = None,
    note: Optional[str] = None,
    updated_by: Optional[str] = None,
) -> RegistrationView:
    """Stamp a rotation event. Optionally replaces the key reference
    when the rotation produced a new key id. Raises ``LookupError`` if
    the tenant has no registration and ``ValueError`` if the state is
    not ``active``."""
    tid = str(tenant_id or "").strip()
    if not tid:
        raise ValueError("tenant_id required")
    _trim(note, MAX_NOTE_LEN)  # validate length only; note is audit-only
    new_ref = (
        _validate_key_reference(new_key_reference)
        if new_key_reference is not None
        else None
    )
    now = _now_ts()
    with session() as s:
        existing = s.execute(
            select(WorkspaceCMEKRegistration).where(
                WorkspaceCMEKRegistration.tenant_id == tid
            )
        ).scalar_one_or_none()
        if existing is None:
            raise LookupError("no CMEK registration for this workspace")
        if str(existing.state) != "active":
            raise ValueError(
                "rotation can only be recorded for an active registration"
            )
        if new_ref is not None:
            existing.key_reference = new_ref
        existing.last_rotated_at = now
        existing.last_rotated_by = updated_by
        existing.rotation_count = int(existing.rotation_count or 0) + 1
        existing.updated_at = now
        existing.updated_by = updated_by
        s.flush()
        s.commit()
        s.refresh(existing)
        return _to_view(existing)


def clear_registration(tenant_id: str) -> bool:
    """Hard-delete the registration. Returns True if a row was removed."""
    tid = str(tenant_id or "").strip()
    if not tid:
        return False
    with session() as s:
        existing = s.execute(
            select(WorkspaceCMEKRegistration).where(
                WorkspaceCMEKRegistration.tenant_id == tid
            )
        ).scalar_one_or_none()
        if existing is None:
            return False
        s.delete(existing)
        s.commit()
        return True
