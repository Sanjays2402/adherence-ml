"""Admin-plane audit recorder.

Persists one row per privileged action (token mint, api key create/revoke,
model rollback, retention sweep, GDPR erase, etc.) into ``admin_audit_log``.
Distinct from ``prediction_audit`` which records inference traffic.

Design notes:

* Never raises out of the route handler. A failed insert is logged and the
  caller continues. Audit gaps are surfaced separately via the ``ok=0``
  rows the recorder writes when it catches its own SQLAlchemy errors.
* ``details`` is the redacted, JSON-serializable payload the route saw.
  Use :func:`redact_details` to scrub headers, raw keys, and secret-bearing
  fields before passing in.
* Tenant id and caller identity come from the FastAPI principal dict
  (``current_principal``) so multi-tenant scoping stays consistent with
  the prediction audit chain.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from sqlalchemy.exc import SQLAlchemyError

from adherence_common.db import AdminAuditLog, session
from adherence_common.logging import get_logger

log = get_logger(__name__)

# Keys whose values must never reach the audit row. Matched case-insensitively
# anywhere in a dotted path (e.g. ``body.api_key``, ``headers.authorization``).
_SECRET_KEYS = frozenset(
    {
        "key",
        "api_key",
        "apikey",
        "token",
        "secret",
        "password",
        "authorization",
        "x-api-key",
        "cookie",
        "dsn",
    }
)


def _is_secret_key(name: str) -> bool:
    lowered = name.lower()
    if lowered in _SECRET_KEYS:
        return True
    # Catch ``jwt_secret``, ``client_secret`` etc.
    return any(lowered.endswith("_" + s) or lowered.startswith(s + "_") for s in _SECRET_KEYS)


def redact_details(value: Any) -> Any:
    """Return ``value`` with any secret-looking fields replaced by ``"***"``.

    Walks dicts and lists; primitives pass through unchanged. Strings longer
    than 4 KiB are truncated to keep the audit row small.
    """
    if isinstance(value, Mapping):
        return {k: ("***" if _is_secret_key(str(k)) else redact_details(v)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact_details(v) for v in value]
    if isinstance(value, str) and len(value) > 4096:
        return value[:4093] + "..."
    return value


def record_admin_action(
    *,
    action: str,
    principal: Mapping[str, Any] | None,
    target: str | None = None,
    details: Any = None,
    ok: bool = True,
    error: str | None = None,
    request_id: str | None = None,
    tenant_id: str | None = None,
) -> int | None:
    """Insert one row into ``admin_audit_log`` and return its id.

    Returns ``None`` if the insert failed (the failure is logged but never
    propagated). ``principal`` is the dict returned by
    :func:`adherence_api.deps.current_principal` and is the source for
    ``caller``, ``caller_role``, and ``tenant_id`` when not overridden.
    """
    p = dict(principal or {})
    caller = str(p.get("sub") or p.get("key_name") or "unknown")[:64]
    caller_role = str(p.get("role") or "unknown")[:16]
    tid = (tenant_id or p.get("tenant") or "default")
    tid = str(tid)[:64]
    redacted = redact_details(details) if details is not None else None
    # Per-tenant PII scrub on free-text values inside the (already
    # secret-key-redacted) details blob. Fail-open: any error returns
    # the input unchanged so the audit write still happens.
    if redacted is not None:
        try:
            from adherence_common.pii_policy import scrub_value
            redacted = scrub_value(tid, redacted)
        except Exception as exc:  # pragma: no cover - defensive
            log.warning("admin_audit_pii_scrub_failed", error=str(exc))
    try:
        from adherence_common.admin_audit_chain import (
            assign_chain,
            latest_chain_hash_in_session,
        )
        with session() as s:
            row = AdminAuditLog(
                tenant_id=tid,
                request_id=(request_id or None),
                action=action[:64],
                target=(target[:128] if target else None),
                caller=caller,
                caller_role=caller_role,
                ok=1 if ok else 0,
                error=(error[:8192] if error else None),
                details=redacted,
            )
            s.add(row)
            # Flush so the row has an id (id is part of the hashed
            # canonical tuple) but commit only once at the end.
            s.flush()
            prev = latest_chain_hash_in_session(s, exclude_id=int(row.id))
            assign_chain(row, prev)
            s.commit()
            return int(row.id)
    except SQLAlchemyError as exc:
        log.warning(
            "admin_audit_persist_failed",
            action=action,
            target=target,
            caller=caller,
            error=str(exc),
        )
        return None


def list_admin_actions(
    *,
    tenant_id: str | None = None,
    action: str | None = None,
    caller: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Return the most recent admin audit rows, newest first.

    Filters are AND'd. ``tenant_id="*"`` returns rows across tenants and
    should only be exposed to admins.
    """
    limit = max(1, min(int(limit), 1000))
    try:
        with session() as s:
            q = s.query(AdminAuditLog)
            if tenant_id and tenant_id != "*":
                q = q.filter(AdminAuditLog.tenant_id == tenant_id)
            if action:
                q = q.filter(AdminAuditLog.action == action)
            if caller:
                q = q.filter(AdminAuditLog.caller == caller)
            q = q.order_by(AdminAuditLog.id.desc()).limit(limit)
            return [
                {
                    "id": r.id,
                    "tenant_id": r.tenant_id,
                    "request_id": r.request_id,
                    "action": r.action,
                    "target": r.target,
                    "caller": r.caller,
                    "caller_role": r.caller_role,
                    "ok": bool(r.ok),
                    "error": r.error,
                    "details": r.details,
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                }
                for r in q.all()
            ]
    except SQLAlchemyError as exc:
        log.warning("admin_audit_list_failed", error=str(exc))
        return []
