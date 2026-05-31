"""W3C Trace Context parsing and minting.

Implements just enough of the W3C ``traceparent`` header
(https://www.w3.org/TR/trace-context/) to:

* Honor an inbound ``traceparent`` so downstream spans and log lines
  inherit the caller's trace_id (correlation across services).
* Mint a fresh, spec-compliant ``traceparent`` when no upstream context
  is supplied, so every request still has a trace_id to surface in
  logs, response headers, and audit rows.

This is intentionally dependency-free (no OpenTelemetry import) so the
middleware layer keeps working when the optional ``opentelemetry``
stack is absent or disabled. When OTEL *is* configured, the SDK reads
the same header via its own propagator; the values produced here line
up with the spec, so traces stitch end-to-end.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass

_TRACEPARENT_RE = re.compile(
    r"^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$"
)

_VERSION = "00"
_DEFAULT_FLAGS = "01"  # sampled


@dataclass(frozen=True)
class TraceContext:
    trace_id: str  # 32 hex chars
    span_id: str   # 16 hex chars
    flags: str     # 2 hex chars
    inbound: bool  # True if extracted from a request header

    def traceparent(self) -> str:
        return f"{_VERSION}-{self.trace_id}-{self.span_id}-{self.flags}"


def _rand_hex(n_bytes: int) -> str:
    return os.urandom(n_bytes).hex()


def parse_traceparent(header: str | None) -> TraceContext | None:
    """Return a TraceContext when ``header`` is a valid traceparent.

    The check is strict: invalid or malformed headers return ``None``
    so the caller mints a fresh context rather than silently honoring
    junk from an untrusted client.
    """
    if not header:
        return None
    m = _TRACEPARENT_RE.match(header.strip().lower())
    if not m:
        return None
    version, trace_id, span_id, flags = m.groups()
    # Reject all-zero ids per the spec.
    if trace_id == "0" * 32 or span_id == "0" * 16:
        return None
    if version == "ff":
        return None
    return TraceContext(
        trace_id=trace_id, span_id=span_id, flags=flags, inbound=True,
    )


def mint_context() -> TraceContext:
    return TraceContext(
        trace_id=_rand_hex(16),
        span_id=_rand_hex(8),
        flags=_DEFAULT_FLAGS,
        inbound=False,
    )


def context_for(header: str | None) -> TraceContext:
    """Parse the incoming traceparent or mint a fresh one."""
    parsed = parse_traceparent(header)
    if parsed is not None:
        return parsed
    return mint_context()
