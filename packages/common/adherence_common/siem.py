"""Per-tenant SIEM audit-log drain.

Enterprise security teams require that audit events flow to their own
SIEM (Splunk HEC, Datadog Logs intake, an in-house syslog forwarder,
etc.) so they can correlate vendor activity with the rest of their
detection stack. Without this, a security review will block
procurement: "we cannot adopt a SaaS that hides our own activity
from our SOC".

This module is the answer:

* Each tenant may configure exactly one drain row (``TenantSiemDrain``)
  with a destination URL, an HMAC shared secret, and an enable flag.
  Owner/admin only; tenant-scoped.
* Every audit row written by :func:`adherence_common.audit.record` is
  shipped to the configured drain in a best-effort background thread.
  Dispatch is wrapped so SIEM failures never fail the original request
  path.
* Each delivery attempt is logged to ``TenantSiemDelivery`` with
  status, http code, response snippet, attempt count, and timing.
  Operators can list, filter, and replay a delivery from the admin
  console. The delivery row is denormalised with ``tenant_id`` so
  every query is naturally scoped.
* Payloads are signed with ``X-Adherence-Signature: sha256=<hex>`` over
  the raw JSON body, using the per-tenant secret. Receivers verify the
  signature before accepting; the drain URL must be reachable over
  HTTPS in production (validated at config time).

There is intentionally no global config: every drain belongs to one
tenant id, and admins from other tenants cannot read or replay it.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable
from urllib import error as urlerror
from urllib import request as urlrequest
from urllib.parse import urlsplit

from sqlalchemy import Column, DateTime, Integer, String, Text, func, select

from adherence_common.db import Base, session
from adherence_common.logging import get_logger

log = get_logger(__name__)


MAX_URL_LEN = 1024
MAX_SECRET_LEN = 256
MAX_ATTEMPTS = 3
RETRY_BACKOFF_S = (0.5, 1.5, 3.0)
REQUEST_TIMEOUT_S = 5.0
RESPONSE_SNIPPET_LEN = 1024
SIGNATURE_HEADER = "X-Adherence-Signature"
EVENT_HEADER = "X-Adherence-Event"


class SiemConfigError(ValueError):
    """Raised when a SIEM drain config is missing or invalid."""


class TenantSiemDrain(Base):
    """One drain row per tenant. Singleton on (tenant_id)."""
    __tablename__ = "tenant_siem_drain"
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), unique=True, index=True, nullable=False)
    url = Column(String(MAX_URL_LEN), nullable=False)
    secret = Column(String(MAX_SECRET_LEN), nullable=False)
    enabled = Column(Integer, nullable=False, default=1)
    created_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_status = Column(String(16), nullable=True)
    last_attempt_at = Column(DateTime, nullable=True)


class TenantSiemDelivery(Base):
    """Per-attempt delivery log. Append-only, tenant-scoped."""
    __tablename__ = "tenant_siem_delivery"
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False)
    event_type = Column(String(64), nullable=False)
    audit_id = Column(Integer, nullable=True, index=True)
    request_id = Column(String(32), nullable=True, index=True)
    url = Column(String(MAX_URL_LEN), nullable=False)
    status = Column(String(16), nullable=False)  # ok | failed | disabled
    http_code = Column(Integer, nullable=True)
    attempts = Column(Integer, nullable=False, default=0)
    duration_ms = Column(Integer, nullable=True)
    payload = Column(Text, nullable=False)
    response_snippet = Column(Text, nullable=True)
    error = Column(String(512), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


@dataclass(frozen=True)
class DrainConfig:
    tenant_id: str
    url: str
    secret: str
    enabled: bool


def _validate_url(url: str) -> str:
    if not url or len(url) > MAX_URL_LEN:
        raise SiemConfigError("url must be 1..1024 chars")
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"}:
        raise SiemConfigError("url must use http or https")
    if not parts.netloc:
        raise SiemConfigError("url missing host")
    return url


def _validate_secret(secret: str) -> str:
    if not secret or len(secret) < 16:
        raise SiemConfigError("secret must be at least 16 chars")
    if len(secret) > MAX_SECRET_LEN:
        raise SiemConfigError("secret too long")
    return secret


def upsert_drain(
    *,
    tenant_id: str,
    url: str,
    secret: str,
    enabled: bool,
    actor: str | None,
) -> DrainConfig:
    tenant_id = (tenant_id or "default").strip()[:64]
    url = _validate_url(url.strip())
    secret = _validate_secret(secret.strip())
    now = datetime.utcnow()
    with session() as s:
        row = s.execute(
            select(TenantSiemDrain).where(TenantSiemDrain.tenant_id == tenant_id)
        ).scalar_one_or_none()
        if row is None:
            row = TenantSiemDrain(
                tenant_id=tenant_id,
                url=url,
                secret=secret,
                enabled=1 if enabled else 0,
                created_by=(actor or None) and actor[:64],
                created_at=now,
                updated_at=now,
            )
            s.add(row)
        else:
            row.url = url
            row.secret = secret
            row.enabled = 1 if enabled else 0
            row.updated_at = now
        s.commit()
        return DrainConfig(
            tenant_id=row.tenant_id,
            url=row.url,
            secret=row.secret,
            enabled=bool(row.enabled),
        )


def delete_drain(tenant_id: str) -> bool:
    tenant_id = (tenant_id or "default").strip()[:64]
    with session() as s:
        row = s.execute(
            select(TenantSiemDrain).where(TenantSiemDrain.tenant_id == tenant_id)
        ).scalar_one_or_none()
        if row is None:
            return False
        s.delete(row)
        s.commit()
        return True


def get_drain(tenant_id: str) -> DrainConfig | None:
    tenant_id = (tenant_id or "default").strip()[:64]
    with session() as s:
        row = s.execute(
            select(TenantSiemDrain).where(TenantSiemDrain.tenant_id == tenant_id)
        ).scalar_one_or_none()
        if row is None:
            return None
        return DrainConfig(
            tenant_id=row.tenant_id,
            url=row.url,
            secret=row.secret,
            enabled=bool(row.enabled),
        )


def list_deliveries(
    tenant_id: str,
    *,
    limit: int = 100,
    status: str | None = None,
    event_type: str | None = None,
) -> list[dict[str, Any]]:
    tenant_id = (tenant_id or "default").strip()[:64]
    limit = max(1, min(int(limit), 500))
    with session() as s:
        stmt = (
            select(TenantSiemDelivery)
            .where(TenantSiemDelivery.tenant_id == tenant_id)
            .order_by(TenantSiemDelivery.id.desc())
            .limit(limit)
        )
        if status:
            stmt = stmt.where(TenantSiemDelivery.status == status[:16])
        if event_type:
            stmt = stmt.where(TenantSiemDelivery.event_type == event_type[:64])
        rows = list(s.execute(stmt).scalars())
        return [_delivery_to_dict(r) for r in rows]


def get_delivery(tenant_id: str, delivery_id: int) -> dict[str, Any] | None:
    tenant_id = (tenant_id or "default").strip()[:64]
    with session() as s:
        row = s.execute(
            select(TenantSiemDelivery).where(
                TenantSiemDelivery.id == int(delivery_id),
                TenantSiemDelivery.tenant_id == tenant_id,
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        return _delivery_to_dict(row, include_payload=True)


def stats(tenant_id: str) -> dict[str, Any]:
    tenant_id = (tenant_id or "default").strip()[:64]
    with session() as s:
        total = s.execute(
            select(func.count(TenantSiemDelivery.id)).where(
                TenantSiemDelivery.tenant_id == tenant_id
            )
        ).scalar() or 0
        ok = s.execute(
            select(func.count(TenantSiemDelivery.id)).where(
                TenantSiemDelivery.tenant_id == tenant_id,
                TenantSiemDelivery.status == "ok",
            )
        ).scalar() or 0
        failed = s.execute(
            select(func.count(TenantSiemDelivery.id)).where(
                TenantSiemDelivery.tenant_id == tenant_id,
                TenantSiemDelivery.status == "failed",
            )
        ).scalar() or 0
        return {
            "n_total": int(total),
            "n_ok": int(ok),
            "n_failed": int(failed),
        }


def _delivery_to_dict(r: TenantSiemDelivery, *, include_payload: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": r.id,
        "tenant_id": r.tenant_id,
        "event_type": r.event_type,
        "audit_id": r.audit_id,
        "request_id": r.request_id,
        "url": r.url,
        "status": r.status,
        "http_code": r.http_code,
        "attempts": r.attempts,
        "duration_ms": r.duration_ms,
        "response_snippet": r.response_snippet,
        "error": r.error,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }
    if include_payload:
        out["payload"] = r.payload
    return out


def sign_payload(secret: str, body: bytes) -> str:
    mac = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return f"sha256={mac}"


def _send_once(url: str, body: bytes, signature: str, event_type: str) -> tuple[int, str]:
    req = urlrequest.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            SIGNATURE_HEADER: signature,
            EVENT_HEADER: event_type,
            "User-Agent": "adherence-ml-siem-drain/1",
        },
    )
    with urlrequest.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:  # noqa: S310
        code = resp.getcode()
        snippet = resp.read(RESPONSE_SNIPPET_LEN).decode("utf-8", errors="replace")
        return code, snippet


def _post_with_retries(
    url: str, body: bytes, signature: str, event_type: str
) -> tuple[int | None, int, str | None, str | None]:
    """Returns (http_code, attempts, response_snippet, error_or_None)."""
    last_err: str | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            code, snippet = _send_once(url, body, signature, event_type)
            if 200 <= code < 300:
                return code, attempt, snippet, None
            last_err = f"http_{code}"
            snippet_out = snippet
            if attempt < MAX_ATTEMPTS:
                time.sleep(RETRY_BACKOFF_S[attempt - 1])
                continue
            return code, attempt, snippet_out, last_err
        except urlerror.HTTPError as e:
            try:
                snippet = e.read(RESPONSE_SNIPPET_LEN).decode("utf-8", errors="replace")
            except Exception:
                snippet = None
            last_err = f"http_{e.code}"
            if attempt < MAX_ATTEMPTS:
                time.sleep(RETRY_BACKOFF_S[attempt - 1])
                continue
            return int(e.code), attempt, snippet, last_err
        except Exception as exc:  # network, timeout, dns
            last_err = type(exc).__name__ + ":" + str(exc)[:200]
            if attempt < MAX_ATTEMPTS:
                time.sleep(RETRY_BACKOFF_S[attempt - 1])
                continue
            return None, attempt, None, last_err
    return None, MAX_ATTEMPTS, None, last_err


def _record_delivery(
    *,
    tenant_id: str,
    event_type: str,
    audit_id: int | None,
    request_id: str | None,
    url: str,
    status: str,
    http_code: int | None,
    attempts: int,
    duration_ms: int,
    payload: str,
    response_snippet: str | None,
    error: str | None,
) -> int | None:
    try:
        with session() as s:
            row = TenantSiemDelivery(
                tenant_id=tenant_id[:64],
                event_type=event_type[:64],
                audit_id=audit_id,
                request_id=(request_id or None) and request_id[:32],
                url=url[:MAX_URL_LEN],
                status=status[:16],
                http_code=http_code,
                attempts=attempts,
                duration_ms=duration_ms,
                payload=payload,
                response_snippet=(response_snippet or None) and response_snippet[:RESPONSE_SNIPPET_LEN],
                error=(error or None) and error[:512],
                created_at=datetime.utcnow(),
            )
            s.add(row)
            try:
                drain = s.execute(
                    select(TenantSiemDrain).where(TenantSiemDrain.tenant_id == tenant_id)
                ).scalar_one_or_none()
                if drain is not None:
                    drain.last_status = status[:16]
                    drain.last_attempt_at = datetime.utcnow()
            except Exception:
                pass
            s.commit()
            return int(row.id)
    except Exception as exc:  # pragma: no cover - defensive
        log.warning("siem_delivery_record_failed", error=str(exc), tenant=tenant_id)
        return None


def deliver_event(
    *,
    tenant_id: str,
    event_type: str,
    event: dict[str, Any],
    audit_id: int | None = None,
    request_id: str | None = None,
) -> dict[str, Any] | None:
    """Synchronous deliver. Returns delivery dict or None if no drain.

    Used by tests, manual replay, and the test-fire endpoint. The
    background hook calls this on a worker thread.
    """
    drain = get_drain(tenant_id)
    if drain is None:
        return None
    if not drain.enabled:
        _record_delivery(
            tenant_id=drain.tenant_id,
            event_type=event_type,
            audit_id=audit_id,
            request_id=request_id,
            url=drain.url,
            status="disabled",
            http_code=None,
            attempts=0,
            duration_ms=0,
            payload=json.dumps(event, sort_keys=True, default=str),
            response_snippet=None,
            error="drain_disabled",
        )
        return {"status": "disabled"}
    body = json.dumps(event, sort_keys=True, default=str).encode("utf-8")
    signature = sign_payload(drain.secret, body)
    started = time.monotonic()
    http_code, attempts, snippet, err = _post_with_retries(
        drain.url, body, signature, event_type
    )
    duration_ms = int((time.monotonic() - started) * 1000)
    status = "ok" if (http_code is not None and 200 <= http_code < 300) else "failed"
    delivery_id = _record_delivery(
        tenant_id=drain.tenant_id,
        event_type=event_type,
        audit_id=audit_id,
        request_id=request_id,
        url=drain.url,
        status=status,
        http_code=http_code,
        attempts=attempts,
        duration_ms=duration_ms,
        payload=body.decode("utf-8"),
        response_snippet=snippet,
        error=err,
    )
    return {
        "id": delivery_id,
        "status": status,
        "http_code": http_code,
        "attempts": attempts,
        "duration_ms": duration_ms,
        "error": err,
    }


_DISPATCH_DISABLED = False  # tests can flip to True to keep sync semantics
_DISPATCH_SYNC = False  # tests set True to run dispatch_async() inline


def set_test_mode(*, sync: bool = False, disabled: bool = False) -> None:
    """Test hook. Sync makes dispatch_async() run inline."""
    global _DISPATCH_SYNC, _DISPATCH_DISABLED
    _DISPATCH_SYNC = sync
    _DISPATCH_DISABLED = disabled


def dispatch_async(
    *,
    tenant_id: str,
    event_type: str,
    event: dict[str, Any],
    audit_id: int | None = None,
    request_id: str | None = None,
) -> None:
    """Best-effort: fire-and-forget background SIEM ship.

    Safe to call on any code path. Never raises. Skips fast if the
    tenant has no drain configured (one cheap select).
    """
    if _DISPATCH_DISABLED:
        return
    try:
        drain = get_drain(tenant_id)
    except Exception:
        return
    if drain is None:
        return

    def _run() -> None:
        try:
            deliver_event(
                tenant_id=tenant_id,
                event_type=event_type,
                event=event,
                audit_id=audit_id,
                request_id=request_id,
            )
        except Exception as exc:  # pragma: no cover
            log.warning("siem_dispatch_failed", error=str(exc), tenant=tenant_id)

    if _DISPATCH_SYNC:
        _run()
        return
    t = threading.Thread(target=_run, name="siem-drain", daemon=True)
    t.start()
