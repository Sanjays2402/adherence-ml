"""Inbound webhook HMAC signature verification.

Enterprise partners post outcome events to ``/v1/webhooks/<source>/...``.
Without an authenticated signature, a compromised API key or a man-in-the
middle could forge ground-truth outcome rows that flow into model promotion
gates. This module adds an HMAC-SHA256 envelope with a timestamp to defeat
both forgery and replay.

Signature scheme (compatible with Stripe/GitHub style):

    X-Webhook-Timestamp: 1717029600                       # seconds since epoch
    X-Webhook-Signature: sha256=<hex(hmac(secret, ts + "." + raw_body))>

* Constant-time compare via ``hmac.compare_digest``.
* Requests with skew > ``inbound_webhook_max_skew_seconds`` are rejected.
* Per-source secrets are loaded from ``ADHERENCE_INBOUND_WEBHOOK_SECRETS``
  (CSV ``source:secret,source:secret``).
* Sources that have no configured secret are allowed through for back-compat
  unless ``inbound_webhook_require_signed`` is true, but every unsigned
  request is logged so operators can find them.
"""
from __future__ import annotations

import hashlib
import hmac
import time
from dataclasses import dataclass

from adherence_common.logging import get_logger
from adherence_common.settings import Settings

log = get_logger(__name__)


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    reason: str = ""
    signed: bool = False


def parse_secrets(csv: str) -> dict[str, str]:
    """Parse ``"source:secret,other:secret"`` into a dict.

    Bad entries are skipped silently so a single typo cannot brick the
    receiver for healthy partners.
    """
    out: dict[str, str] = {}
    if not csv:
        return out
    for chunk in csv.split(","):
        chunk = chunk.strip()
        if not chunk or ":" not in chunk:
            continue
        source, _, secret = chunk.partition(":")
        source = source.strip()
        secret = secret.strip()
        if source and secret:
            out[source] = secret
    return out


def expected_signature(secret: str, timestamp: str, body: bytes) -> str:
    """Return the value for the ``X-Webhook-Signature`` header."""
    payload = timestamp.encode("ascii") + b"." + body
    mac = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256)
    return f"sha256={mac.hexdigest()}"


def verify(
    *,
    source: str,
    body: bytes,
    signature_header: str | None,
    timestamp_header: str | None,
    settings: Settings,
    now: float | None = None,
) -> VerifyResult:
    """Verify inbound HMAC envelope. See module docstring for the scheme."""
    secrets = parse_secrets(settings.inbound_webhook_secrets)
    secret = secrets.get(source)

    if secret is None:
        if settings.inbound_webhook_require_signed:
            return VerifyResult(False, "no secret configured for source", False)
        log.warning("inbound_webhook_unsigned", source=source)
        return VerifyResult(True, "unsigned (no secret configured)", False)

    if not signature_header or not timestamp_header:
        return VerifyResult(False, "missing X-Webhook-Signature/Timestamp", False)

    # Timestamp must be a recent unix int (seconds). Reject negative/garbage.
    try:
        ts_int = int(timestamp_header)
    except (TypeError, ValueError):
        return VerifyResult(False, "bad X-Webhook-Timestamp", False)
    current = float(now) if now is not None else time.time()
    skew = abs(current - ts_int)
    if skew > max(1, settings.inbound_webhook_max_skew_seconds):
        return VerifyResult(False, f"timestamp skew {skew:.0f}s exceeds limit", False)

    expected = expected_signature(secret, timestamp_header, body)
    # constant-time compare
    if not hmac.compare_digest(expected, signature_header.strip()):
        return VerifyResult(False, "signature mismatch", False)

    return VerifyResult(True, "ok", True)
