"""Per-tenant IP / CIDR allowlist.

When a tenant has zero allowlist rows the gate is OFF for that tenant.
When at least one row exists, only requests whose client IP matches a
row are accepted on tenant-bound API and dashboard traffic. This lets
buyers paste their corporate egress range and block everything else
without taking the whole deployment offline.

The store is the same SQLAlchemy session as the rest of the app so
the workspace settings UI and the request-path middleware always see
the same data.
"""
from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from threading import Lock

from sqlalchemy import select

from adherence_common.db import TenantIpAllowlist, session
from adherence_common.logging import get_logger

log = get_logger(__name__)


class IpAllowlistError(ValueError):
    """Raised when a caller-supplied CIDR cannot be parsed."""


@dataclass(frozen=True)
class AllowlistEntry:
    id: int
    tenant_id: str
    cidr: str
    label: str | None
    created_by: str | None
    created_at: str


# Tiny in-process cache so the middleware does not hammer the DB on
# every request. Invalidated on any add/remove from this process and
# expires after CACHE_TTL_SECONDS for cross-process safety.
CACHE_TTL_SECONDS = 30
_cache: dict[str, tuple[float, tuple[ipaddress._BaseNetwork, ...]]] = {}
_cache_lock = Lock()


def _parse_cidr(raw: str) -> ipaddress._BaseNetwork:
    s = (raw or "").strip()
    if not s:
        raise IpAllowlistError("cidr is required")
    if "/" not in s:
        # Bare address: pin to a single host.
        try:
            addr = ipaddress.ip_address(s)
        except ValueError as exc:
            raise IpAllowlistError(f"invalid ip: {s}") from exc
        s = f"{addr}/{addr.max_prefixlen}"
    try:
        return ipaddress.ip_network(s, strict=False)
    except ValueError as exc:
        raise IpAllowlistError(f"invalid cidr: {raw}") from exc


def normalize_cidr(raw: str) -> str:
    return str(_parse_cidr(raw))


def _now_monotonic() -> float:
    import time
    return time.monotonic()


def _invalidate(tenant_id: str | None = None) -> None:
    with _cache_lock:
        if tenant_id is None:
            _cache.clear()
        else:
            _cache.pop(tenant_id, None)


def _load_networks(tenant_id: str) -> tuple[ipaddress._BaseNetwork, ...]:
    try:
        with session() as s:
            rows = list(
                s.execute(
                    select(TenantIpAllowlist.cidr).where(
                        TenantIpAllowlist.tenant_id == tenant_id
                    )
                ).scalars()
            )
    except Exception as exc:
        # Table missing (pre-init_db), DB unreachable, or transient error:
        # never let the gate fail-closed on the operator. We log loudly
        # so it surfaces in the access log and revert to open.
        log.warning("ip_allowlist_load_failed", tenant_id=tenant_id, error=str(exc))
        return ()
    nets: list[ipaddress._BaseNetwork] = []
    for r in rows:
        try:
            nets.append(_parse_cidr(r))
        except IpAllowlistError:
            log.warning("ip_allowlist_bad_row", tenant_id=tenant_id, cidr=r)
            continue
    return tuple(nets)


def _cached_networks(tenant_id: str) -> tuple[ipaddress._BaseNetwork, ...]:
    now = _now_monotonic()
    with _cache_lock:
        hit = _cache.get(tenant_id)
        if hit is not None and (now - hit[0]) < CACHE_TTL_SECONDS:
            return hit[1]
    nets = _load_networks(tenant_id)
    with _cache_lock:
        _cache[tenant_id] = (now, nets)
    return nets


def is_allowed(tenant_id: str, client_ip: str) -> bool:
    """Return True if the tenant accepts traffic from ``client_ip``.

    Empty allowlist means OFF (allow all). Unparseable IPs are denied
    only if the allowlist is configured for the tenant: when the gate
    is off we never reject for parse reasons.
    """
    tid = (tenant_id or "default")
    nets = _cached_networks(tid)
    if not nets:
        return True
    try:
        addr = ipaddress.ip_address((client_ip or "").strip())
    except ValueError:
        return False
    for n in nets:
        if addr.version != n.version:
            continue
        if addr in n:
            return True
    return False


def list_entries(tenant_id: str) -> list[AllowlistEntry]:
    tid = (tenant_id or "default")
    with session() as s:
        rows = list(
            s.execute(
                select(TenantIpAllowlist).where(
                    TenantIpAllowlist.tenant_id == tid
                ).order_by(TenantIpAllowlist.id.asc())
            ).scalars()
        )
    return [
        AllowlistEntry(
            id=int(r.id),
            tenant_id=str(r.tenant_id),
            cidr=str(r.cidr),
            label=r.label,
            created_by=r.created_by,
            created_at=r.created_at.isoformat() if r.created_at else "",
        )
        for r in rows
    ]


def add_entry(
    *, tenant_id: str, cidr: str, label: str | None, created_by: str | None
) -> AllowlistEntry:
    tid = (tenant_id or "default")
    normalized = normalize_cidr(cidr)
    with session() as s:
        # Reject exact-duplicate rows so the UI list stays clean.
        existing = s.execute(
            select(TenantIpAllowlist).where(
                TenantIpAllowlist.tenant_id == tid,
                TenantIpAllowlist.cidr == normalized,
            )
        ).scalar_one_or_none()
        if existing is not None:
            raise IpAllowlistError(f"{normalized} already in allowlist")
        row = TenantIpAllowlist(
            tenant_id=tid,
            cidr=normalized,
            label=(label or None),
            created_by=(created_by or None),
            created_at=datetime.utcnow(),
        )
        s.add(row)
        s.commit()
        entry = AllowlistEntry(
            id=int(row.id),
            tenant_id=tid,
            cidr=normalized,
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
            select(TenantIpAllowlist).where(
                TenantIpAllowlist.tenant_id == tid,
                TenantIpAllowlist.id == int(entry_id),
            )
        ).scalar_one_or_none()
        if row is None:
            return False
        s.delete(row)
        s.commit()
    _invalidate(tid)
    return True


def reset_cache() -> None:
    """Test hook: drop the in-process network cache."""
    _invalidate()
