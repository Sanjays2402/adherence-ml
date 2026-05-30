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
    return [s for s in subs if _matches(s, event_type)]


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
    if not targets:
        return []
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True,
                      default=str).encode("utf-8")
    out_ids: list[int] = []
    for sub in targets:
        sig = sign(sub.secret, body)
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
            status, latency_ms, err = _post(
                sub.url, body, headers, timeout, client=_client,
            )
            last_status, last_latency, last_error = status, latency_ms, err
            if status is not None and 200 <= status < 300:
                state = "success"
                break
        try:
            _ensure_table()
            with session() as s:
                row = WebhookDelivery(
                    subscription_id=sub.id,
                    event_type=event_type,
                    payload_json=payload,
                    attempt=attempt_n,
                    status_code=last_status,
                    latency_ms=last_latency,
                    error=last_error,
                    state=state,
                )
                s.add(row)
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
        event_type = prev.event_type
        payload = prev.payload_json
    ids = dispatch(event_type, dict(payload), _client=_client)
    return ids[0] if ids else None


def recent_deliveries(limit: int = 100) -> list[WebhookDelivery]:
    _ensure_table()
    with session() as s:
        return list(s.scalars(
            select(WebhookDelivery)
            .order_by(WebhookDelivery.id.desc())
            .limit(limit)
        ))


__all__ = [
    "DEFAULT_TIMEOUT_S",
    "MAX_ATTEMPTS",
    "sign",
    "verify",
    "list_targets",
    "dispatch",
    "replay",
    "recent_deliveries",
]
