"""Per-workspace HIPAA Purpose of Use (POU) policy + PHI access log.

Healthcare buyers (HIPAA covered entities and HITRUST-certified vendors)
require that every request reaching protected health information (PHI)
declare a *purpose of use* drawn from HL7 v3 PurposeOfUse codes. The
classic set is TREATMENT, PAYMENT, OPERATIONS (HIPAA "TPO"), with
EMERGENCY, RESEARCH, and COVERAGE rounding out the common cases. This
turns the "minimum necessary" doctrine into something auditable:
reviewers can answer "what purposes are reaching what data, by whom,
when, from where" off a single table.

What this module provides
=========================
* :class:`WorkspacePurposeOfUsePolicy` ORM row, one per tenant.
  Holds the enabled POU codes the workspace will accept, an
  ``enforce`` toggle, and an optional ``default_purpose`` used when a
  caller does not send the ``X-Purpose-Of-Use`` header.
* :class:`PHIAccessLogRow` ORM row, append-only PHI access log with
  request id, route, method, actor, purpose, tenant, IP, status,
  latency, and the user id whose record was touched.
* Helpers to read/write the policy and append / list / count log rows.

Wiring sites
============
* :mod:`adherence_api.purpose_of_use_middleware` consults this policy
  on every request whose path starts with a PHI prefix. If the
  workspace is enforcing and no acceptable POU is present the request
  is rejected with HTTP 412 (Precondition Failed) plus a structured
  error body and an ``X-Purpose-Required`` header listing the
  acceptable values.
* The same middleware appends one :class:`PHIAccessLogRow` per
  request after the route returns, stamping ``X-Purpose-Of-Use`` on
  the response so SIEM and SDK telemetry can correlate.
* :mod:`adherence_api.routes.purpose_of_use` is the admin surface
  for the policy. :mod:`adherence_api.routes.phi_access` exposes the
  log to workspace owners.

Fail-open on infrastructure
===========================
Every DB call here is wrapped: if the store is unreachable the
policy lookup returns the default-off view and the log append is a
no-op. The application keeps serving (fail-open) and the failure is
logged. This mirrors how PII policy, session policy, and the legal
gate degrade in this codebase.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import (
    JSON,
    Column,
    DateTime,
    Float,
    Integer,
    String,
    Text,
    select,
    func,
)
from sqlalchemy.exc import SQLAlchemyError

from adherence_common.db import Base, session
from adherence_common.logging import get_logger

log = get_logger(__name__)


# HL7 v3 PurposeOfUse code subset relevant to a medication-adherence
# platform. Anything outside this set is rejected at the validation
# boundary so a typo cannot silently grant access.
KNOWN_POU_CODES: tuple[str, ...] = (
    "TREATMENT",
    "PAYMENT",
    "OPERATIONS",
    "EMERGENCY",
    "RESEARCH",
    "COVERAGE",
    "PUBLICHEALTH",
)

DEFAULT_POU = "TREATMENT"
POU_HEADER = "X-Purpose-Of-Use"
POU_REQUIRED_HEADER = "X-Purpose-Required"

# Path prefixes that are treated as PHI surfaces. Anything reaching a
# patient row, a per-user prediction, an audit trail of those
# predictions, or a population-level aggregate of them is gated.
PHI_PREFIXES: tuple[str, ...] = (
    "/v1/predict",
    "/v1/cohort",
    "/v1/forecast",
    "/v1/explain",
    "/v1/audit",
    "/v1/interventions",
    "/v1/users",
    "/v1/plots",
)


class WorkspacePurposeOfUsePolicy(Base):
    """One row per tenant.

    ``allowed_csv`` is a comma-separated subset of
    :data:`KNOWN_POU_CODES`. Empty string means "no codes accepted":
    when combined with ``enforce=1`` that effectively quarantines PHI
    for the workspace, which is a valid stance during incident
    response.

    ``enforce`` of ``0`` (default for back-compat) means the policy
    is observed (logged on the response, recorded in the access log
    when present) but not required: a caller without an POU header
    still succeeds.

    ``default_purpose`` is stamped on the request and the access log
    when the caller did not send the header and ``enforce`` is off.
    """

    __tablename__ = "workspace_pou_policy"

    tenant_id = Column(String(64), primary_key=True)
    allowed_csv = Column(String(256), nullable=False, default="")
    enforce = Column(Integer, nullable=False, default=0)
    default_purpose = Column(String(32), nullable=True)
    updated_at = Column(Integer, nullable=False)
    updated_by = Column(String(128), nullable=True)


class PHIAccessLogRow(Base):
    """Append-only PHI access log.

    One row per PHI request, written by the middleware after the route
    returns. Designed to support SIEM export and the workspace owner
    UI; **never** edited or deleted by application code. Operators who
    truly need to prune for retention should do so out of band with a
    documented procedure.
    """

    __tablename__ = "phi_access_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    created_at = Column(
        DateTime, default=datetime.utcnow, nullable=False, index=True
    )
    request_id = Column(String(64), index=True, nullable=True)
    route = Column(String(255), nullable=False)
    method = Column(String(8), nullable=False)
    purpose = Column(String(32), nullable=False, index=True)
    actor = Column(String(128), index=True, nullable=False)
    actor_role = Column(String(32), nullable=False)
    key_name = Column(String(128), nullable=True)
    client_ip = Column(String(64), nullable=True)
    status_code = Column(Integer, nullable=False)
    latency_ms = Column(Float, nullable=True)
    user_id = Column(String(128), nullable=True, index=True)
    note = Column(Text, nullable=True)


# ---------------------------------------------------------------- views


@dataclass(frozen=True)
class PolicyView:
    tenant_id: str
    allowed: tuple[str, ...]
    enforce: bool
    default_purpose: Optional[str]
    updated_at: int
    updated_by: Optional[str]

    @property
    def is_default(self) -> bool:
        return (
            not self.allowed
            and not self.enforce
            and self.default_purpose in (None, "")
        )


@dataclass(frozen=True)
class AccessLogView:
    id: int
    tenant_id: str
    created_at: str
    request_id: Optional[str]
    route: str
    method: str
    purpose: str
    actor: str
    actor_role: str
    key_name: Optional[str]
    client_ip: Optional[str]
    status_code: int
    latency_ms: Optional[float]
    user_id: Optional[str]
    note: Optional[str]


# ---------------------------------------------------------------- helpers


def _now_ts() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())


def normalize_code(raw: str | None) -> str | None:
    """Normalize a caller-supplied POU code.

    Strips whitespace, uppercases, and returns ``None`` for empties.
    Does **not** validate against :data:`KNOWN_POU_CODES`: callers
    that need that should check separately so we can return a helpful
    error message at the boundary.
    """
    if raw is None:
        return None
    s = str(raw).strip().upper()
    return s or None


def parse_allowed_csv(csv: str) -> tuple[str, ...]:
    """Return the unique, known POU codes encoded in ``csv``.

    Unknown codes are silently dropped so a stored row that includes
    a code we have since retired never breaks policy evaluation.
    """
    seen: list[str] = []
    for raw in (csv or "").split(","):
        n = normalize_code(raw)
        if n and n in KNOWN_POU_CODES and n not in seen:
            seen.append(n)
    return tuple(seen)


def is_phi_path(path: str) -> bool:
    p = path or ""
    return any(p.startswith(pref) for pref in PHI_PREFIXES)


# ---------------------------------------------------------------- policy


def get_policy(tenant_id: str) -> PolicyView:
    tid = (tenant_id or "default")
    try:
        with session() as s:
            row = s.execute(
                select(WorkspacePurposeOfUsePolicy).where(
                    WorkspacePurposeOfUsePolicy.tenant_id == tid
                )
            ).scalar_one_or_none()
    except SQLAlchemyError as exc:
        log.warning("pou_policy_load_failed", tenant_id=tid, error=str(exc))
        row = None
    if row is None:
        return PolicyView(
            tenant_id=tid,
            allowed=(),
            enforce=False,
            default_purpose=None,
            updated_at=0,
            updated_by=None,
        )
    return PolicyView(
        tenant_id=tid,
        allowed=parse_allowed_csv(row.allowed_csv or ""),
        enforce=bool(row.enforce),
        default_purpose=normalize_code(row.default_purpose),
        updated_at=int(row.updated_at or 0),
        updated_by=row.updated_by,
    )


def set_policy(
    *,
    tenant_id: str,
    allowed: Iterable[str],
    enforce: bool,
    default_purpose: str | None,
    updated_by: str | None,
) -> PolicyView:
    tid = (tenant_id or "default")
    cleaned: list[str] = []
    for raw in allowed:
        n = normalize_code(raw)
        if not n:
            continue
        if n not in KNOWN_POU_CODES:
            raise ValueError(
                f"unknown purpose of use code: {n}. "
                f"Allowed: {', '.join(KNOWN_POU_CODES)}"
            )
        if n not in cleaned:
            cleaned.append(n)
    default_code = normalize_code(default_purpose)
    if default_code is not None:
        if default_code not in KNOWN_POU_CODES:
            raise ValueError(
                f"unknown default purpose: {default_code}. "
                f"Allowed: {', '.join(KNOWN_POU_CODES)}"
            )
        if cleaned and default_code not in cleaned:
            raise ValueError(
                "default_purpose must be in the allowed list"
            )
    if enforce and not cleaned:
        raise ValueError(
            "enforce=true requires at least one allowed POU code"
        )
    now = _now_ts()
    with session() as s:
        row = s.execute(
            select(WorkspacePurposeOfUsePolicy).where(
                WorkspacePurposeOfUsePolicy.tenant_id == tid
            )
        ).scalar_one_or_none()
        if row is None:
            row = WorkspacePurposeOfUsePolicy(tenant_id=tid)
            s.add(row)
        row.allowed_csv = ",".join(cleaned)
        row.enforce = 1 if enforce else 0
        row.default_purpose = default_code
        row.updated_at = now
        row.updated_by = (updated_by or None)
        s.commit()
    return get_policy(tid)


def clear_policy(*, tenant_id: str) -> bool:
    tid = (tenant_id or "default")
    with session() as s:
        row = s.execute(
            select(WorkspacePurposeOfUsePolicy).where(
                WorkspacePurposeOfUsePolicy.tenant_id == tid
            )
        ).scalar_one_or_none()
        if row is None:
            return False
        s.delete(row)
        s.commit()
    return True


def evaluate(
    *, tenant_id: str, caller_purpose: str | None
) -> tuple[bool, Optional[str], PolicyView]:
    """Return ``(ok, effective_purpose, policy)``.

    * If the policy is enforcing and the caller's purpose is missing
      or not in the allowed set, ``ok`` is False and
      ``effective_purpose`` is None.
    * If the policy is not enforcing, ``ok`` is True. The effective
      purpose is the caller's normalized purpose, else the policy's
      ``default_purpose``, else the global default :data:`DEFAULT_POU`.
      This keeps PHI access log rows populated even before a
      workspace has configured policy.
    """
    pol = get_policy(tenant_id)
    norm = normalize_code(caller_purpose)
    if pol.enforce:
        if norm is None:
            return (False, None, pol)
        if norm not in pol.allowed:
            return (False, None, pol)
        return (True, norm, pol)
    if norm is not None:
        return (True, norm, pol)
    if pol.default_purpose:
        return (True, pol.default_purpose, pol)
    return (True, DEFAULT_POU, pol)


# ---------------------------------------------------------------- log


def record_access(
    *,
    tenant_id: str,
    request_id: str | None,
    route: str,
    method: str,
    purpose: str,
    actor: str,
    actor_role: str,
    key_name: str | None,
    client_ip: str | None,
    status_code: int,
    latency_ms: float | None,
    user_id: str | None,
    note: str | None = None,
) -> int | None:
    try:
        with session() as s:
            row = PHIAccessLogRow(
                tenant_id=str(tenant_id or "default")[:64],
                request_id=(request_id or None),
                route=str(route)[:255],
                method=str(method)[:8],
                purpose=str(purpose or "UNSPECIFIED")[:32],
                actor=str(actor or "unknown")[:128],
                actor_role=str(actor_role or "unknown")[:32],
                key_name=(key_name or None),
                client_ip=(client_ip or None),
                status_code=int(status_code),
                latency_ms=(float(latency_ms) if latency_ms is not None else None),
                user_id=(user_id or None),
                note=(note or None),
            )
            s.add(row)
            s.commit()
            return int(row.id)
    except SQLAlchemyError as exc:
        log.warning("phi_access_log_write_failed", error=str(exc))
        return None


def _row_to_view(r: PHIAccessLogRow) -> AccessLogView:
    return AccessLogView(
        id=int(r.id),
        tenant_id=str(r.tenant_id),
        created_at=(r.created_at.isoformat() if r.created_at else ""),
        request_id=r.request_id,
        route=str(r.route),
        method=str(r.method),
        purpose=str(r.purpose),
        actor=str(r.actor),
        actor_role=str(r.actor_role),
        key_name=r.key_name,
        client_ip=r.client_ip,
        status_code=int(r.status_code),
        latency_ms=(float(r.latency_ms) if r.latency_ms is not None else None),
        user_id=r.user_id,
        note=r.note,
    )


def list_access(
    *,
    tenant_id: str,
    limit: int = 100,
    offset: int = 0,
    purpose: str | None = None,
    actor: str | None = None,
    user_id: str | None = None,
) -> list[AccessLogView]:
    tid = (tenant_id or "default")
    limit = max(1, min(int(limit), 1000))
    offset = max(0, int(offset))
    with session() as s:
        q = select(PHIAccessLogRow).where(PHIAccessLogRow.tenant_id == tid)
        if purpose:
            q = q.where(PHIAccessLogRow.purpose == normalize_code(purpose))
        if actor:
            q = q.where(PHIAccessLogRow.actor == actor)
        if user_id:
            q = q.where(PHIAccessLogRow.user_id == user_id)
        q = q.order_by(PHIAccessLogRow.id.desc()).limit(limit).offset(offset)
        rows = list(s.execute(q).scalars())
    return [_row_to_view(r) for r in rows]


def count_access(
    *,
    tenant_id: str,
    purpose: str | None = None,
    actor: str | None = None,
    user_id: str | None = None,
) -> int:
    tid = (tenant_id or "default")
    with session() as s:
        q = select(func.count(PHIAccessLogRow.id)).where(
            PHIAccessLogRow.tenant_id == tid
        )
        if purpose:
            q = q.where(PHIAccessLogRow.purpose == normalize_code(purpose))
        if actor:
            q = q.where(PHIAccessLogRow.actor == actor)
        if user_id:
            q = q.where(PHIAccessLogRow.user_id == user_id)
        return int(s.execute(q).scalar_one() or 0)
