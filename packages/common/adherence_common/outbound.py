"""Outbound webhook dispatch for events like intervention recommendations.

Each ``WebhookSubscription`` row is a URL plus shared HMAC secret. When an
event fires (e.g. a high-risk intervention is recommended), ``dispatch``
POSTs a signed JSON payload to every active subscription whose
``event_types_csv`` allowlist matches the event type. Each attempt is
recorded as a ``WebhookDelivery`` row so operators can audit and replay.

Signature scheme: ``X-Adherence-Signature: sha256=<hex(hmac(secret, body))>``.
Receivers should reject any request that does not match (constant-time
compare) and ignore retries via ``X-Adherence-Delivery-Id``.

Failures here never bubble out to the API request that triggered them;
the event is best-effort and isolated from the request hot path.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from datetime import datetime, timedelta
from typing import Any, Iterable

import httpx
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from adherence_common.db import (
    WebhookDelivery, WebhookSubscription, init_db, session,
)
from adherence_common.logging import get_logger
from adherence_common import outbound_policy
from adherence_common import webhook_events as _webhook_catalog

log = get_logger(__name__)

_INITIALIZED = False
DEFAULT_TIMEOUT_S = 5.0
MAX_ATTEMPTS = 3
RETRY_BACKOFF_S = (0.0, 0.5, 2.0)  # delay BEFORE attempt i


def _ensure_table() -> None:
    global _INITIALIZED
    if _INITIALIZED:
        return
    try:
        init_db()
        _INITIALIZED = True
    except Exception as exc:  # pragma: no cover
        log.warning("webhook_init_failed", error=str(exc))


def sign(secret: str, body: bytes) -> str:
    """Return the value for the ``X-Adherence-Signature`` header."""
    mac = hmac.new(secret.encode("utf-8"), body, hashlib.sha256)
    return f"sha256={mac.hexdigest()}"


def verify(secret: str, body: bytes, header_value: str) -> bool:
    """Constant-time verification helper for tests / downstream receivers."""
    expected = sign(secret, body)
    return hmac.compare_digest(expected, header_value or "")


def verify_any(
    secrets_in: Iterable[str], body: bytes, header_value: str,
) -> bool:
    """Return True if ``header_value`` matches the signature of any of
    ``secrets_in``. Used by receivers during a secret rotation overlap
    window where the sender may sign with the new secret while the
    receiver still has the old one (or vice versa)."""
    if not header_value:
        return False
    for s in secrets_in:
        if not s:
            continue
        if hmac.compare_digest(sign(s, body), header_value):
            return True
    return False


def _previous_secret_active(sub: "WebhookSubscription") -> str | None:
    """Return the previous secret if the rotation overlap window is still
    open, else None. Pure helper, no DB access."""
    prev = getattr(sub, "secret_previous", None)
    expires = getattr(sub, "secret_previous_expires_at", None)
    if not prev or expires is None:
        return None
    if datetime.utcnow() >= expires:
        return None
    return prev


def _matches(sub: WebhookSubscription, event_type: str) -> bool:
    csv = (sub.event_types_csv or "").strip()
    if not csv:
        return True
    return event_type in {t.strip() for t in csv.split(",") if t.strip()}


def list_targets(event_type: str) -> list[WebhookSubscription]:
    _ensure_table()
    try:
        with session() as s:
            subs = list(s.scalars(
                select(WebhookSubscription).where(WebhookSubscription.active == 1)
            ))
    except SQLAlchemyError as exc:  # pragma: no cover
        log.warning("webhook_list_failed", error=str(exc))
        return []
    # Skip circuit-broken subscriptions: ``disabled_at`` is stamped by the
    # breaker once consecutive_failures crosses the threshold. Operators
    # re-enable via /v1/webhooks/outbound/subscriptions/{name}/reset-breaker.
    return [
        sb for sb in subs
        if _matches(sb, event_type)
        and getattr(sb, "disabled_at", None) is None
    ]


def _breaker_threshold() -> int:
    """Read the circuit-breaker threshold from settings. 0 disables it."""
    try:
        from adherence_common.settings import get_settings
        return int(getattr(get_settings(), "outbound_circuit_breaker_threshold", 0) or 0)
    except Exception:  # pragma: no cover - settings always present in prod
        return 0


def _post(
    url: str, body: bytes, headers: dict[str, str], timeout: float,
    client: httpx.Client | None = None,
) -> tuple[int | None, float, str | None]:
    t0 = time.perf_counter()
    try:
        if client is not None:
            r = client.post(url, content=body, headers=headers, timeout=timeout)
        else:
            with httpx.Client(timeout=timeout) as c:
                r = c.post(url, content=body, headers=headers, timeout=timeout)
        return r.status_code, (time.perf_counter() - t0) * 1000.0, None
    except httpx.HTTPError as exc:
        return None, (time.perf_counter() - t0) * 1000.0, str(exc)


def dispatch(
    event_type: str,
    payload: dict[str, Any],
    *,
    timeout: float = DEFAULT_TIMEOUT_S,
    max_attempts: int = MAX_ATTEMPTS,
    _client: httpx.Client | None = None,
) -> list[int]:
    """Send the event to every matching active subscription.

    Returns the list of ``WebhookDelivery`` ids created (one per
    subscription, regardless of success). HTTP 2xx counts as success;
    everything else retries up to ``max_attempts`` with exponential backoff
    and ends in state ``failed``.
    """
    targets = list_targets(event_type)
    if not _webhook_catalog.is_known(event_type):
        # Catalog miss: emit a structured warning so it surfaces in
        # observability without breaking any in-flight caller. Do not
        # raise; the call site contract is best-effort.
        log.warning(
            "webhook_dispatch_unknown_event",
            event_type=event_type, targets=len(targets),
        )
    if not targets:
        return []
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True,
                      default=str).encode("utf-8")
    out_ids: list[int] = []
    for sub in targets:
        # SSRF defense, re-evaluated on every dispatch so a subscription
        # whose DNS has been rebound to a private IP since creation is
        # blocked here and recorded as state='blocked'. No HTTP attempt.
        # Also re-checks the per-tenant outbound host allowlist so a
        # tenant tightening its egress policy retroactively blocks its
        # own previously-saved subscriptions.
        sub_tenant = getattr(sub, "tenant_id", None) or "default"
        decision = outbound_policy.evaluate(sub.url, tenant_id=sub_tenant)
        if not decision.allowed:
            try:
                _ensure_table()
                with session() as s:
                    row = WebhookDelivery(
                        subscription_id=sub.id,
                        tenant_id=sub_tenant,
                        event_type=event_type,
                        payload_json=payload,
                        attempt=0,
                        status_code=None,
                        latency_ms=None,
                        error=f"outbound_blocked: {decision.reason}",
                        state="blocked",
                    )
                    s.add(row)
                    s.commit()
                    s.refresh(row)
                    out_ids.append(row.id)
            except SQLAlchemyError as exc:  # pragma: no cover
                log.warning("webhook_block_record_failed", error=str(exc))
            log.warning(
                "outbound_webhook_blocked",
                subscription_id=sub.id, url=sub.url,
                reason=decision.reason,
            )
            continue
        sig = sign(sub.secret, body)
        prev_secret = _previous_secret_active(sub)
        sig_prev = sign(prev_secret, body) if prev_secret else None
        last_status: int | None = None
        last_error: str | None = None
        last_latency: float | None = None
        attempt_n = 0
        state = "failed"
        for attempt in range(1, max_attempts + 1):
            attempt_n = attempt
            if attempt > 1 and attempt - 1 < len(RETRY_BACKOFF_S):
                time.sleep(RETRY_BACKOFF_S[attempt - 1])
            headers = {
                "Content-Type": "application/json",
                "X-Adherence-Signature": sig,
                "X-Adherence-Event": event_type,
                "X-Adherence-Attempt": str(attempt),
            }
            if sig_prev:
                # Receivers in the middle of rotating their stored secret
                # can verify either header. Drop this header once the
                # window expires.
                headers["X-Adherence-Signature-Previous"] = sig_prev
            status, latency_ms, err = _post(
                sub.url, body, headers, timeout, client=_client,
            )
            last_status, last_latency, last_error = status, latency_ms, err
            if status is not None and 200 <= status < 300:
                state = "success"
                break
        else:
            # No 2xx within the configured retry budget. Promote the
            # terminal state from generic "failed" to "dead_letter" so
            # operator dashboards can surface a DLQ count and require an
            # explicit replay to retry. Transport-level rejects already
            # use the dedicated "blocked" state (see above).
            if attempt_n >= max_attempts:
                state = "dead_letter"
        try:
            _ensure_table()
            threshold = _breaker_threshold()
            with session() as s:
                row = WebhookDelivery(
                    subscription_id=sub.id,
                    tenant_id=sub_tenant,
                    event_type=event_type,
                    payload_json=payload,
                    attempt=attempt_n,
                    status_code=last_status,
                    latency_ms=last_latency,
                    error=last_error,
                    state=state,
                )
                s.add(row)
                # Update the circuit-breaker counter on the subscription.
                # Reset on success, increment on failure, auto-disable on
                # crossing the configured threshold so a dead receiver
                # stops burning retries (and operator pager budget).
                live = s.get(WebhookSubscription, sub.id)
                if live is not None:
                    if state == "success":
                        if (live.consecutive_failures or 0) != 0:
                            live.consecutive_failures = 0
                            live.updated_at = datetime.utcnow()
                    else:
                        live.consecutive_failures = (live.consecutive_failures or 0) + 1
                        live.updated_at = datetime.utcnow()
                        if (
                            threshold > 0
                            and live.consecutive_failures >= threshold
                            and live.disabled_at is None
                        ):
                            live.disabled_at = datetime.utcnow()
                            live.disabled_reason = (
                                f"circuit_breaker: {live.consecutive_failures} "
                                f"consecutive failures (threshold {threshold})"
                            )
                            log.warning(
                                "outbound_webhook_circuit_breaker_tripped",
                                subscription_id=sub.id, url=sub.url,
                                consecutive_failures=live.consecutive_failures,
                                threshold=threshold,
                            )
                s.commit()
                s.refresh(row)
                out_ids.append(row.id)
        except SQLAlchemyError as exc:  # pragma: no cover
            log.warning("webhook_delivery_record_failed", error=str(exc))
    return out_ids


def replay(delivery_id: int, *, _client: httpx.Client | None = None) -> int | None:
    """Re-attempt a previously failed delivery. Returns the new delivery id."""
    _ensure_table()
    with session() as s:
        prev = s.get(WebhookDelivery, delivery_id)
        if prev is None:
            return None
        sub = s.get(WebhookSubscription, prev.subscription_id)
        if sub is None or not sub.active:
            return None
        # Refuse replay if the breaker has tripped. Operator must reset first.
        if getattr(sub, "disabled_at", None) is not None:
            return None
        event_type = prev.event_type
        payload = prev.payload_json
    ids = dispatch(event_type, dict(payload), _client=_client)
    return ids[0] if ids else None


def recent_deliveries(
    limit: int = 100,
    *,
    tenant_id: str | None = None,
) -> list[WebhookDelivery]:
    """Return the most recent WebhookDelivery rows, newest first.

    When ``tenant_id`` is provided the result is scoped to deliveries
    that belong to that tenant. The unscoped form remains available for
    internal jobs (retention sweep, prometheus exporter) that have a
    legitimate cross-tenant read, but all user-facing routes must pass
    the caller's tenant explicitly so cross-tenant leakage is impossible
    at the query layer.
    """
    _ensure_table()
    with session() as s:
        q = (
            select(WebhookDelivery)
            .order_by(WebhookDelivery.id.desc())
            .limit(limit)
        )
        if tenant_id is not None:
            q = (
                select(WebhookDelivery)
                .where(WebhookDelivery.tenant_id == str(tenant_id))
                .order_by(WebhookDelivery.id.desc())
                .limit(limit)
            )
        return list(s.scalars(q))


def dead_letter_count(tenant_id: str) -> int:
    """Number of dead-letter deliveries pending operator attention.

    Scoped to a single tenant; a returned value > 0 should drive a
    banner / alert in the admin console.
    """
    _ensure_table()
    with session() as s:
        rows = list(s.scalars(
            select(WebhookDelivery).where(
                WebhookDelivery.tenant_id == str(tenant_id),
                WebhookDelivery.state == "dead_letter",
            )
        ))
    return len(rows)


__all__ = [
    "DEFAULT_TIMEOUT_S",
    "MAX_ATTEMPTS",
    "sign",
    "verify",
    "verify_any",
    "list_targets",
    "dispatch",
    "replay",
    "recent_deliveries",
    "dead_letter_count",
]
