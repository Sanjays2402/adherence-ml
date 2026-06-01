"""Per-tenant browser ``Origin`` allowlist.

Complements the deployment-wide CORS policy with a per-workspace,
DB-backed gate: when a tenant has zero rows the gate is OFF for that
tenant; when at least one row exists, browser issued requests
(requests that carry an ``Origin`` header) bound to that tenant must
match a row, otherwise they are rejected with HTTP 403.

Match rules:
* ``https://app.example.com`` matches that scheme+host(+port) exactly.
* ``https://*.example.com`` matches any subdomain of example.com but
  not the bare apex.
* Server to server callers (no ``Origin`` header at all) are
  unaffected. Lock those down with the IP allowlist and API key
  scopes instead.

The store is the same SQLAlchemy session as the rest of the app so
the workspace settings UI and the request-path middleware always see
the same data.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from threading import Lock
from urllib.parse import urlsplit

from sqlalchemy import select

from adherence_common.db import TenantOriginAllowlist, session
from adherence_common.logging import get_logger

log = get_logger(__name__)


class OriginAllowlistError(ValueError):
    """Raised when a caller-supplied origin pattern cannot be parsed."""


@dataclass(frozen=True)
class OriginEntry:
    id: int
    tenant_id: str
    origin: str
    label: str | None
    created_by: str | None
    created_at: str


CACHE_TTL_SECONDS = 30
_cache: dict[str, tuple[float, tuple[str, ...]]] = {}
_cache_lock = Lock()

_HOST_RE = re.compile(r"^(?:\*\.)?[a-z0-9]([a-z0-9.\-]{0,251}[a-z0-9])?$")

# Hosts without a dot are only accepted from this allowlist (loopback /
# intranet dev surfaces). Everything else requires a TLD-style host.
_DOTLESS_OK = frozenset({"localhost"})


def _now_monotonic() -> float:
    import time
    return time.monotonic()


def _invalidate(tenant_id: str | None = None) -> None:
    with _cache_lock:
        if tenant_id is None:
            _cache.clear()
        else:
            _cache.pop(tenant_id, None)


def normalize_origin(raw: str) -> str:
    """Normalize a user-supplied origin to ``scheme://host[:port]``.

    Accepts entries with an optional ``*.`` wildcard for the leftmost
    DNS label. Rejects paths, query strings, fragments, userinfo,
    plain hostnames without a scheme, and anything that does not look
    like an http(s) origin.
    """
    raw_str = raw or ""
    # Reject whitespace anywhere (incl. trailing) before any normalization
    # so we never silently accept ``https://app.example.com `` and then
    # match it against a clean stored origin.
    if any(ch in raw_str for ch in (" ", "\t", "\n", "\r")):
        raise OriginAllowlistError("origin must not contain whitespace")
    s = raw_str.strip()
    if not s:
        raise OriginAllowlistError("origin is required")
    # Block path/query/fragment bleed early so we never accept something
    # like ``https://app.example.com/admin`` and silently widen the match
    # by stripping the path.
    if "@" in s:
        raise OriginAllowlistError("origin must not contain userinfo")
    parts = urlsplit(s)
    if parts.scheme not in ("http", "https"):
        raise OriginAllowlistError(
            "origin must include an http or https scheme, e.g. https://app.example.com"
        )
    if parts.path not in ("", "/"):
        raise OriginAllowlistError("origin must not include a path")
    if parts.query or parts.fragment:
        raise OriginAllowlistError("origin must not include a query or fragment")
    host = (parts.hostname or "").lower()
    if not host:
        raise OriginAllowlistError("origin must include a host")
    # Wildcards: only ``*.`` as the leftmost label.
    wildcard = host.startswith("*.")
    bare_host = host[2:] if wildcard else host
    if "*" in bare_host:
        raise OriginAllowlistError("wildcard must only appear as the leftmost label")
    if not _HOST_RE.match(host):
        raise OriginAllowlistError(f"invalid host: {host}")
    if bare_host.count(".") < 1 and bare_host not in _DOTLESS_OK:
        raise OriginAllowlistError(f"invalid host: {host}")
    port = parts.port
    netloc = host
    if port is not None:
        if not (1 <= port <= 65535):
            raise OriginAllowlistError(f"invalid port: {port}")
        netloc = f"{host}:{port}"
    return f"{parts.scheme}://{netloc}"


def _matches(pattern: str, origin: str) -> bool:
    """Return True if a normalized origin matches a stored pattern.

    Wildcard host patterns match any single (or multi) label prefix:
    ``https://*.example.com`` matches ``https://a.example.com`` and
    ``https://a.b.example.com`` but not ``https://example.com``.
    """
    try:
        p = urlsplit(pattern)
        o = urlsplit(origin)
    except Exception:
        return False
    if p.scheme != o.scheme:
        return False
    if (p.port or None) != (o.port or None):
        return False
    p_host = (p.hostname or "").lower()
    o_host = (o.hostname or "").lower()
    if p_host.startswith("*."):
        suffix = p_host[1:]  # ".example.com"
        return o_host.endswith(suffix) and o_host != suffix.lstrip(".")
    return p_host == o_host


def _load_origins(tenant_id: str) -> tuple[str, ...]:
    try:
        with session() as s:
            rows = list(
                s.execute(
                    select(TenantOriginAllowlist.origin).where(
                        TenantOriginAllowlist.tenant_id == tenant_id
                    )
                ).scalars()
            )
    except Exception as exc:
        log.warning(
            "origin_allowlist_load_failed", tenant_id=tenant_id, error=str(exc)
        )
        return ()
    out: list[str] = []
    for r in rows:
        try:
            out.append(normalize_origin(r))
        except OriginAllowlistError:
            log.warning("origin_allowlist_bad_row", tenant_id=tenant_id, origin=r)
            continue
    return tuple(out)


def _cached_origins(tenant_id: str) -> tuple[str, ...]:
    now = _now_monotonic()
    with _cache_lock:
        hit = _cache.get(tenant_id)
        if hit is not None and (now - hit[0]) < CACHE_TTL_SECONDS:
            return hit[1]
    items = _load_origins(tenant_id)
    with _cache_lock:
        _cache[tenant_id] = (now, items)
    return items


def is_enforced(tenant_id: str) -> bool:
    """Return True if at least one origin row exists for this tenant."""
    return bool(_cached_origins((tenant_id or "default")))


def is_allowed(tenant_id: str, origin: str) -> bool:
    """Return True if ``origin`` is acceptable for ``tenant_id``.

    Empty allowlist means OFF (allow all). Origins that cannot be
    normalized are denied when the gate is on; when the gate is off
    we never reject for parse reasons.
    """
    tid = (tenant_id or "default")
    patterns = _cached_origins(tid)
    if not patterns:
        return True
    try:
        candidate = normalize_origin(origin)
    except OriginAllowlistError:
        return False
    return any(_matches(p, candidate) for p in patterns)


def list_entries(tenant_id: str) -> list[OriginEntry]:
    tid = (tenant_id or "default")
    with session() as s:
        rows = list(
            s.execute(
                select(TenantOriginAllowlist)
                .where(TenantOriginAllowlist.tenant_id == tid)
                .order_by(TenantOriginAllowlist.id.asc())
            ).scalars()
        )
    return [
        OriginEntry(
            id=int(r.id),
            tenant_id=str(r.tenant_id),
            origin=str(r.origin),
            label=r.label,
            created_by=r.created_by,
            created_at=r.created_at.isoformat() if r.created_at else "",
        )
        for r in rows
    ]


def add_entry(
    *, tenant_id: str, origin: str, label: str | None, created_by: str | None
) -> OriginEntry:
    tid = (tenant_id or "default")
    normalized = normalize_origin(origin)
    with session() as s:
        existing = s.execute(
            select(TenantOriginAllowlist).where(
                TenantOriginAllowlist.tenant_id == tid,
                TenantOriginAllowlist.origin == normalized,
            )
        ).scalar_one_or_none()
        if existing is not None:
            raise OriginAllowlistError(f"{normalized} already in allowlist")
        row = TenantOriginAllowlist(
            tenant_id=tid,
            origin=normalized,
            label=(label or None),
            created_by=(created_by or None),
            created_at=datetime.utcnow(),
        )
        s.add(row)
        s.commit()
        entry = OriginEntry(
            id=int(row.id),
            tenant_id=tid,
            origin=normalized,
            label=row.label,
            created_by=row.created_by,
            created_at=row.created_at.isoformat(),
        )
    _invalidate(tid)
    return entry


def remove_entry(*, tenant_id: str, entry_id: int) -> bool:
    tid = (tenant_id or "default")
    with session() as s:
        row = s.execute(
            select(TenantOriginAllowlist).where(
                TenantOriginAllowlist.tenant_id == tid,
                TenantOriginAllowlist.id == int(entry_id),
            )
        ).scalar_one_or_none()
        if row is None:
            return False
        s.delete(row)
        s.commit()
    _invalidate(tid)
    return True


def reset_cache() -> None:
    """Test hook: drop the in-process origin cache."""
    _invalidate()
