"""Per-subscription custom outbound webhook headers.

Lets a workspace owner attach a small set of extra HTTP headers (for
example ``Authorization: Bearer ...`` for a customer's API gateway, or
``X-Customer-Tenant: acme``) to every outbound delivery for one
subscription. Headers travel with every retry of the same delivery and
are exposed in the admin console; sensitive values are write-only over
the API (redacted in listing responses).

Validation rules: name must be an RFC 7230 token, must not be a
hop-by-hop or framing header (Host, Content-Length, Content-Type,
Connection, Transfer-Encoding, Upgrade, Cookie, etc.), and must not
use the reserved ``X-Adherence-`` prefix so a tenant can never forge
the dispatcher's HMAC signature, timestamp, event type, or attempt
counter. Values cannot contain CR, LF, or NUL (CRLF injection guard);
each value is bounded to 1 KiB and the collection to 4 KiB total with
a hard cap of 10 entries.

The store format is a JSON object on the subscription row. Values
never reach structured logs or admin audit details: only the set of
header names appears in audit evidence, so an Authorization token
added here does not leak via SOC2 evidence exports.
"""
from __future__ import annotations

import json
import re
from typing import Mapping

MAX_HEADERS = 10
MAX_HEADER_NAME_BYTES = 64
MAX_HEADER_VALUE_BYTES = 1024
MAX_TOTAL_BYTES = 4096

# RFC 7230 token = 1*tchar.  tchar excludes separators and CTLs.
_TOKEN_RE = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")

# Names the receiver-facing transport owns; we will never let a tenant
# rewrite framing or our own signatures.
RESERVED_PREFIXES: tuple[str, ...] = ("x-adherence-",)
RESERVED_NAMES: frozenset[str] = frozenset({
    "host",
    "content-length",
    "content-type",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "expect",
    "cookie",
    "set-cookie",
})

REDACTION = "***"
# Header names whose values are sensitive enough that even an admin
# reading the dashboard should not see them once stored. The value is
# still sent over the wire on dispatch; we just refuse to echo it back.
SENSITIVE_NAME_HINTS: tuple[str, ...] = (
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "api-key",
    "apikey",
    "x-auth-token",
    "token",
    "secret",
    "password",
)


class HeaderValidationError(ValueError):
    """Raised when a custom header set is malformed or forbidden.

    ``code`` is a short machine string suitable for an HTTP 400 detail;
    ``field`` is the offending header name (or ``"_collection"`` for
    collection-level errors like too many headers).
    """

    def __init__(self, code: str, message: str, *, field: str | None = None):
        super().__init__(message)
        self.code = code
        self.field = field


def _norm_name(name: str) -> str:
    return name.strip().lower()


def is_sensitive_name(name: str) -> bool:
    n = _norm_name(name)
    return any(hint in n for hint in SENSITIVE_NAME_HINTS)


def validate_headers(headers: Mapping[str, str] | None) -> dict[str, str]:
    """Normalise and validate a custom-header mapping.

    Returns a fresh dict keyed by the original (preserved-case) header
    name. Raises :class:`HeaderValidationError` on any rule violation.
    An empty / None input is allowed and returns ``{}``.
    """
    if headers is None:
        return {}
    if not isinstance(headers, Mapping):
        raise HeaderValidationError(
            "invalid_headers_type",
            "custom headers must be an object of string-to-string",
        )
    if len(headers) > MAX_HEADERS:
        raise HeaderValidationError(
            "too_many_headers",
            f"at most {MAX_HEADERS} custom headers per subscription",
            field="_collection",
        )
    cleaned: dict[str, str] = {}
    seen_lower: set[str] = set()
    total_bytes = 0
    for raw_name, raw_value in headers.items():
        if not isinstance(raw_name, str) or not isinstance(raw_value, str):
            raise HeaderValidationError(
                "non_string_header",
                "header names and values must be strings",
                field=str(raw_name) if raw_name is not None else None,
            )
        name = raw_name.strip()
        value = raw_value
        if not name:
            raise HeaderValidationError(
                "empty_header_name", "header name is required",
            )
        if len(name.encode("utf-8")) > MAX_HEADER_NAME_BYTES:
            raise HeaderValidationError(
                "header_name_too_long",
                f"header name exceeds {MAX_HEADER_NAME_BYTES} bytes",
                field=name,
            )
        if not _TOKEN_RE.match(name):
            raise HeaderValidationError(
                "header_name_invalid",
                "header name must be an RFC 7230 token",
                field=name,
            )
        lower = name.lower()
        if lower in seen_lower:
            raise HeaderValidationError(
                "duplicate_header",
                "header is set more than once (case-insensitive)",
                field=name,
            )
        seen_lower.add(lower)
        if lower in RESERVED_NAMES:
            raise HeaderValidationError(
                "reserved_header",
                f"{name!r} is reserved and cannot be overridden",
                field=name,
            )
        for prefix in RESERVED_PREFIXES:
            if lower.startswith(prefix):
                raise HeaderValidationError(
                    "reserved_header_prefix",
                    f"{name!r} uses a reserved prefix ({prefix!r})",
                    field=name,
                )
        if "\r" in value or "\n" in value or "\x00" in value:
            raise HeaderValidationError(
                "header_value_invalid",
                "header value cannot contain CR, LF, or NUL",
                field=name,
            )
        vbytes = len(value.encode("utf-8"))
        if vbytes > MAX_HEADER_VALUE_BYTES:
            raise HeaderValidationError(
                "header_value_too_long",
                f"value for {name!r} exceeds {MAX_HEADER_VALUE_BYTES} bytes",
                field=name,
            )
        total_bytes += len(name.encode("utf-8")) + vbytes
        if total_bytes > MAX_TOTAL_BYTES:
            raise HeaderValidationError(
                "headers_total_too_large",
                f"combined headers exceed {MAX_TOTAL_BYTES} bytes",
                field="_collection",
            )
        cleaned[name] = value
    return cleaned


def encode(headers: Mapping[str, str] | None) -> str | None:
    """Serialise a validated header map for storage. Returns ``None``
    for an empty map so the DB column reads as NULL."""
    if not headers:
        return None
    return json.dumps(dict(headers), separators=(",", ":"), sort_keys=True)


def decode(stored: str | None) -> dict[str, str]:
    """Deserialise the column value. Returns ``{}`` for NULL / empty /
    malformed JSON (never raises; a malformed row is treated as "no
    custom headers" so dispatch keeps working)."""
    if not stored:
        return {}
    try:
        loaded = json.loads(stored)
    except (TypeError, ValueError):
        return {}
    if not isinstance(loaded, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in loaded.items():
        if isinstance(k, str) and isinstance(v, str):
            out[k] = v
    return out


def redact_for_display(headers: Mapping[str, str]) -> dict[str, str]:
    """Public view of a stored header map.

    Sensitive header values (Authorization, tokens, secrets) are
    replaced with :data:`REDACTION`. Non-sensitive values are echoed
    as-is so an operator can confirm a correlation id or vendor name
    looks right.
    """
    out: dict[str, str] = {}
    for name, value in headers.items():
        if is_sensitive_name(name):
            out[name] = REDACTION
        else:
            out[name] = value
    return out
