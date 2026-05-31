"""Per-tenant outbound webhook destination host allowlist.

Companion to :mod:`adherence_common.outbound_policy`. The global
``outbound_host_allowlist`` setting is a deployment-wide gate that
applies to every tenant. Enterprise buyers also need a *tenant-owned*
gate so a single workspace owner can paste their own approved partner
hostnames without coordinating with the operator running the cluster.

Semantics:

* If a tenant has zero rows, the per-tenant gate is OFF for that tenant.
  The global allowlist (if any) still applies as before.
* If a tenant has one or more rows, an outbound destination is only
  permitted for that tenant when the hostname matches at least one row
  AND also passes every other policy check (scheme, IP class, metadata
  hosts, global allowlist if configured).

Host match rules mirror the global allowlist: ``api.example.com`` is an
exact match; ``.example.com`` matches any subdomain of ``example.com``
but not the apex.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from threading import Lock
from typing import Iterable

from sqlalchemy import select

from adherence_common.db import TenantOutboundHostAllowlist, session
from adherence_common.logging import get_logger

log = get_logger(__name__)

# Cheap in-process cache; mirrors the IP allowlist cache style.
CACHE_TTL_SECONDS = 30
_cache: dict[str, tuple[float, tuple[str, ...]]] = {}
_cache_lock = Lock()


# RFC 1123-ish hostname check. Permissive enough for real hostnames and
# the leading-dot subdomain wildcard form we accept.
_HOST_RE = re.compile(
    r"^\.?(?=.{1,253}$)"
    r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
)


class HostAllowlistError(ValueError):
    """Raised when a caller-supplied host is not a valid hostname."""


@dataclass(frozen=True)
class HostAllowlistEntry:
    id: int
    tenant_id: str
    host: str
    label: str | None
    created_by: str | None
    created_at: str


def normalize_host(raw: str) -> str:
    s = (raw or "").strip().lower().rstrip(".")
    if not s:
        raise HostAllowlistError("host is required")
    if len(s) > 253:
        raise HostAllowlistError("host is too long")
    if not _HOST_RE.match(s):
        raise HostAllowlistError(f"invalid host: {raw}")
    return s


def _now_monotonic() -> float:
    import time
    return time.monotonic()


def _invalidate(tenant_id: str | None = None) -> None:
    with _cache_lock:
        if tenant_id is None:
            _cache.clear()
        else:
            _cache.pop(tenant_id, None)


def _load(tenant_id: str) -> tuple[str, ...]:
    try:
        with session() as s:
            rows = list(
                s.execute(
                    select(TenantOutboundHostAllowlist.host).where(
                        TenantOutboundHostAllowlist.tenant_id == tenant_id
                    )
                ).scalars()
            )
    except Exception as exc:
        log.warning(
            "outbound_host_allowlist_load_failed",
            tenant_id=tenant_id,
            error=str(exc),
        )
        return ()
    return tuple(r.lower() for r in rows if r)


def _cached(tenant_id: str) -> tuple[str, ...]:
    now = _now_monotonic()
    with _cache_lock:
        hit = _cache.get(tenant_id)
        if hit is not None and (now - hit[0]) < CACHE_TTL_SECONDS:
            return hit[1]
    rows = _load(tenant_id)
    with _cache_lock:
        _cache[tenant_id] = (now, rows)
    return rows


def host_matches(host: str, allowlist: Iterable[str]) -> bool:
    """Return True if ``host`` matches any entry. Pure helper for tests."""
    h = (host or "").lower().strip(".")
    for entry in allowlist:
        if not entry:
            continue
        if entry.startswith("."):
            if h.endswith(entry):
                return True
        elif entry == h:
            return True
    return False


def list_entries(tenant_id: str) -> list[HostAllowlistEntry]:
    tid = (tenant_id or "default")
    with session() as s:
        rows = list(
            s.execute(
                select(TenantOutboundHostAllowlist).where(
                    TenantOutboundHostAllowlist.tenant_id == tid
                ).order_by(TenantOutboundHostAllowlist.id.asc())
            ).scalars()
        )
    return [
        HostAllowlistEntry(
            id=int(r.id),
            tenant_id=str(r.tenant_id),
            host=str(r.host),
            label=r.label,
            created_by=r.created_by,
            created_at=r.created_at.isoformat() if r.created_at else "",
        )
        for r in rows
    ]


def add_entry(
    *, tenant_id: str, host: str, label: str | None, created_by: str | None
) -> HostAllowlistEntry:
    tid = (tenant_id or "default")
    normalized = normalize_host(host)
    with session() as s:
        existing = s.execute(
            select(TenantOutboundHostAllowlist).where(
                TenantOutboundHostAllowlist.tenant_id == tid,
                TenantOutboundHostAllowlist.host == normalized,
            )
        ).scalar_one_or_none()
        if existing is not None:
            raise HostAllowlistError(
                f"{normalized} already in outbound host allowlist"
            )
        row = TenantOutboundHostAllowlist(
            tenant_id=tid,
            host=normalized,
            label=(label or None),
            created_by=(created_by or None),
            created_at=datetime.utcnow(),
        )
        s.add(row)
        s.commit()
        entry = HostAllowlistEntry(
            id=int(row.id),
            tenant_id=tid,
            host=normalized,
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
            select(TenantOutboundHostAllowlist).where(
                TenantOutboundHostAllowlist.tenant_id == tid,
                TenantOutboundHostAllowlist.id == int(entry_id),
            )
        ).scalar_one_or_none()
        if row is None:
            return False
        s.delete(row)
        s.commit()
    _invalidate(tid)
    return True


def is_allowed(tenant_id: str, host: str) -> tuple[bool, str | None]:
    """Per-tenant gate.

    Returns ``(True, None)`` when there are no per-tenant rows (gate off
    for this tenant) or when ``host`` matches a row. Returns
    ``(False, reason)`` when rows exist and the host does not match.
    Pure check; does not consult the global allowlist or any IP policy.
    """
    tid = (tenant_id or "default")
    rows = _cached(tid)
    if not rows:
        return True, None
    if host_matches(host, rows):
        return True, None
    return (
        False,
        f"host {host.lower()!r} is not in tenant outbound host allowlist",
    )


def reset_cache() -> None:
    """Test hook: drop the in-process allowlist cache."""
    _invalidate()


__all__ = [
    "HostAllowlistEntry",
    "HostAllowlistError",
    "normalize_host",
    "host_matches",
    "list_entries",
    "add_entry",
    "remove_entry",
    "is_allowed",
    "reset_cache",
]
