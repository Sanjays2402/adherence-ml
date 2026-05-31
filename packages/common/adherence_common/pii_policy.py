"""Per-workspace PII redaction policy.

Enterprise buyers in regulated verticals (HIPAA, GDPR, PCI) require that
free-text fields persisted by the platform have personal identifiers
stripped before they hit durable storage. The platform-wide secret-key
scrubber in :mod:`adherence_common.admin_audit` only redacts *keys* whose
name looks secret-bearing; it does not look inside values.

This module adds a per-tenant value-level scrubber:

* :class:`WorkspacePIIPolicy` ORM row, one per tenant, holds the enabled
  built-in pattern set (email, phone, ssn, mrn, credit_card, ipv4) plus
  an optional list of custom regex patterns and a mask token.
* :func:`get_policy` / :func:`set_policy` / :func:`clear_policy` admin
  helpers, used by the workspace settings route.
* :func:`scrub_text` and :func:`scrub_value` apply the tenant policy to a
  string or arbitrary JSON-shaped value. Both fail-open: if the policy
  store is unreachable the input is returned unchanged and the failure
  is logged, mirroring how session-policy and revocation degrade.

Wiring sites:

* :func:`adherence_common.admin_audit.record_admin_action` calls
  :func:`scrub_value` on ``details`` after the secret-key pass, so every
  admin-plane mutation has its narrative fields scrubbed per the actor's
  tenant policy.
* The medtracker inbound webhook calls :func:`scrub_text` on
  ``DoseOutcome.notes`` using the configured source-to-tenant mapping
  (``ADHERENCE_INBOUND_SOURCE_TENANTS``) so partner-supplied free text
  inherits the receiving workspace's policy.

A tenant with no row gets no value-level scrubbing, preserving back-compat.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

from sqlalchemy import Column, Integer, String, Text, select
from sqlalchemy.exc import SQLAlchemyError

from adherence_common.db import Base, session
from adherence_common.logging import get_logger

log = get_logger(__name__)


_BUILTINS: dict[str, re.Pattern[str]] = {
    "email": re.compile(
        r"\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b"
    ),
    "phone": re.compile(
        r"(?:\+\d{1,3}[\s\-]?)?(?:\(\d{3}\)[\s\-]?|\d{3}[\s\-])\d{3}[\s\-]\d{4}\b"
    ),
    "ssn": re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
    "mrn": re.compile(r"\bMRN[\s:\-]?\d{6,12}\b", re.IGNORECASE),
    "credit_card": re.compile(r"\b(?:\d[\s\-]?){13,19}\b"),
    "ipv4": re.compile(
        r"\b(?:25[0-5]|2[0-4]\d|[01]?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)){3}\b"
    ),
}

BUILTIN_NAMES: tuple[str, ...] = tuple(sorted(_BUILTINS.keys()))
DEFAULT_MASK = "[REDACTED]"
MAX_CUSTOM_PATTERNS = 16
MAX_PATTERN_LEN = 256
MAX_MASK_LEN = 32


class WorkspacePIIPolicy(Base):
    """One row per tenant.

    ``enabled_builtins_csv`` is a comma-separated subset of
    :data:`BUILTIN_NAMES`. Empty string means *no* built-ins.

    ``custom_patterns_json`` is a JSON-encoded list of regex strings.
    Patterns that fail to compile at scrub time are skipped (and logged)
    so a single bad rule cannot break the redaction pipeline.

    ``mask`` is the literal replacement; defaults to ``[REDACTED]``.
    """

    __tablename__ = "workspace_pii_policy"

    tenant_id = Column(String(64), primary_key=True)
    enabled_builtins_csv = Column(String(256), nullable=False, default="")
    custom_patterns_json = Column(Text, nullable=False, default="[]")
    mask = Column(String(MAX_MASK_LEN), nullable=False, default=DEFAULT_MASK)
    updated_at = Column(Integer, nullable=False)
    updated_by = Column(String(128), nullable=True)


@dataclass(frozen=True)
class PolicyView:
    tenant_id: str
    enabled_builtins: tuple[str, ...]
    custom_patterns: tuple[str, ...]
    mask: str
    updated_at: int
    updated_by: Optional[str]

    def is_empty(self) -> bool:
        return not self.enabled_builtins and not self.custom_patterns


def _now_ts() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())


def _parse_builtins(csv: str) -> tuple[str, ...]:
    seen: list[str] = []
    for raw in (csv or "").split(","):
        name = raw.strip().lower()
        if name and name in _BUILTINS and name not in seen:
            seen.append(name)
    return tuple(seen)


def _parse_custom(blob: str) -> tuple[str, ...]:
    try:
        arr = json.loads(blob or "[]")
    except (ValueError, TypeError):
        return tuple()
    out: list[str] = []
    if isinstance(arr, list):
        for item in arr:
            if isinstance(item, str) and item and len(item) <= MAX_PATTERN_LEN:
                out.append(item)
            if len(out) >= MAX_CUSTOM_PATTERNS:
                break
    return tuple(out)


def _to_view(row: WorkspacePIIPolicy) -> PolicyView:
    return PolicyView(
        tenant_id=str(row.tenant_id),
        enabled_builtins=_parse_builtins(str(row.enabled_builtins_csv or "")),
        custom_patterns=_parse_custom(str(row.custom_patterns_json or "[]")),
        mask=str(row.mask or DEFAULT_MASK)[:MAX_MASK_LEN] or DEFAULT_MASK,
        updated_at=int(row.updated_at),
        updated_by=(str(row.updated_by) if row.updated_by else None),
    )


def validate_builtins(names: Iterable[str]) -> tuple[str, ...]:
    """Filter ``names`` to the supported set, deduplicate, preserve order."""
    seen: list[str] = []
    for raw in names or ():
        name = str(raw).strip().lower()
        if name and name in _BUILTINS and name not in seen:
            seen.append(name)
    return tuple(seen)


def validate_custom_patterns(patterns: Iterable[str]) -> tuple[str, ...]:
    """Validate that each pattern compiles and is within size limits.

    Raises ``ValueError`` listing every invalid pattern so the admin gets
    one error response instead of N retries.
    """
    out: list[str] = []
    errors: list[str] = []
    for idx, raw in enumerate(patterns or ()):
        if not isinstance(raw, str) or not raw:
            errors.append(f"pattern[{idx}]: must be a non-empty string")
            continue
        if len(raw) > MAX_PATTERN_LEN:
            errors.append(f"pattern[{idx}]: exceeds {MAX_PATTERN_LEN} chars")
            continue
        try:
            re.compile(raw)
        except re.error as exc:
            errors.append(f"pattern[{idx}]: {exc}")
            continue
        out.append(raw)
        if len(out) > MAX_CUSTOM_PATTERNS:
            errors.append(f"too many patterns; max {MAX_CUSTOM_PATTERNS}")
            break
    if errors:
        raise ValueError("; ".join(errors))
    return tuple(out)


def get_policy(tenant_id: str) -> Optional[PolicyView]:
    """Return the tenant policy or ``None`` if none configured."""
    if not tenant_id:
        return None
    try:
        with session() as s:
            row = s.execute(
                select(WorkspacePIIPolicy).where(
                    WorkspacePIIPolicy.tenant_id == str(tenant_id)[:64]
                )
            ).scalar_one_or_none()
            return _to_view(row) if row else None
    except SQLAlchemyError as exc:
        log.warning("pii_policy_get_failed", tenant=tenant_id, error=str(exc))
        return None


def set_policy(
    tenant_id: str,
    *,
    enabled_builtins: Iterable[str],
    custom_patterns: Iterable[str],
    mask: str = DEFAULT_MASK,
    updated_by: str | None = None,
) -> PolicyView:
    """Insert or update the tenant policy. Returns the resulting view.

    Caller is responsible for RBAC (admin-only). Raises ``ValueError`` on
    invalid input so the route can return 422.
    """
    if not tenant_id:
        raise ValueError("tenant_id is required")
    builtins = validate_builtins(enabled_builtins)
    customs = validate_custom_patterns(custom_patterns)
    mask_clean = str(mask or DEFAULT_MASK)[:MAX_MASK_LEN]
    if not mask_clean:
        mask_clean = DEFAULT_MASK
    tid = str(tenant_id)[:64]
    now = _now_ts()
    with session() as s:
        row = s.execute(
            select(WorkspacePIIPolicy).where(
                WorkspacePIIPolicy.tenant_id == tid
            )
        ).scalar_one_or_none()
        if row is None:
            row = WorkspacePIIPolicy(
                tenant_id=tid,
                enabled_builtins_csv=",".join(builtins),
                custom_patterns_json=json.dumps(list(customs)),
                mask=mask_clean,
                updated_at=now,
                updated_by=(str(updated_by)[:128] if updated_by else None),
            )
            s.add(row)
        else:
            row.enabled_builtins_csv = ",".join(builtins)
            row.custom_patterns_json = json.dumps(list(customs))
            row.mask = mask_clean
            row.updated_at = now
            row.updated_by = (str(updated_by)[:128] if updated_by else None)
        s.commit()
        return _to_view(row)


def clear_policy(tenant_id: str) -> bool:
    """Drop the tenant policy. Returns True if a row was removed."""
    if not tenant_id:
        return False
    tid = str(tenant_id)[:64]
    with session() as s:
        row = s.execute(
            select(WorkspacePIIPolicy).where(
                WorkspacePIIPolicy.tenant_id == tid
            )
        ).scalar_one_or_none()
        if row is None:
            return False
        s.delete(row)
        s.commit()
        return True


def _apply_patterns(text: str, view: PolicyView) -> str:
    out = text
    for name in view.enabled_builtins:
        pat = _BUILTINS.get(name)
        if pat is None:
            continue
        try:
            out = pat.sub(view.mask, out)
        except re.error as exc:  # pragma: no cover - defensive
            log.warning("pii_builtin_apply_failed", name=name, error=str(exc))
    for raw in view.custom_patterns:
        try:
            out = re.sub(raw, view.mask, out)
        except re.error as exc:
            log.warning("pii_custom_apply_failed", pattern=raw, error=str(exc))
    return out


def scrub_text(tenant_id: str, value: str) -> str:
    """Apply the tenant PII policy to ``value`` and return the result.

    Fail-open: any backend error returns the input unchanged. Returns the
    input unchanged when no policy exists or the policy has no rules.
    """
    if not isinstance(value, str) or not value:
        return value
    try:
        view = get_policy(str(tenant_id)) if tenant_id else None
    except Exception as exc:  # pragma: no cover - defensive
        log.warning("pii_scrub_text_lookup_failed", error=str(exc))
        return value
    if view is None or view.is_empty():
        return value
    return _apply_patterns(value, view)


def scrub_value(tenant_id: str, value: Any) -> Any:
    """Recursively apply the tenant PII policy to strings inside a JSON-shaped
    value. Dict keys are left untouched (the secret-key scrubber upstream
    already handles them); only leaf string values are rewritten.
    """
    if value is None or not tenant_id:
        return value
    try:
        view = get_policy(str(tenant_id))
    except Exception as exc:  # pragma: no cover - defensive
        log.warning("pii_scrub_value_lookup_failed", error=str(exc))
        return value
    if view is None or view.is_empty():
        return value
    return _walk(value, view)


def _walk(value: Any, view: PolicyView) -> Any:
    if isinstance(value, str):
        return _apply_patterns(value, view)
    if isinstance(value, list):
        return [_walk(v, view) for v in value]
    if isinstance(value, tuple):
        return tuple(_walk(v, view) for v in value)
    if isinstance(value, dict):
        return {k: _walk(v, view) for k, v in value.items()}
    return value


__all__ = [
    "BUILTIN_NAMES",
    "DEFAULT_MASK",
    "MAX_CUSTOM_PATTERNS",
    "MAX_PATTERN_LEN",
    "MAX_MASK_LEN",
    "WorkspacePIIPolicy",
    "PolicyView",
    "get_policy",
    "set_policy",
    "clear_policy",
    "scrub_text",
    "scrub_value",
    "validate_builtins",
    "validate_custom_patterns",
]
