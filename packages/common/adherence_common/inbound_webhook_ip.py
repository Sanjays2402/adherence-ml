"""Per-source IP / CIDR allowlist for inbound webhooks.

Enterprise buyers want a network-layer pre-check on partner webhook
endpoints (``/v1/webhooks/<source>/...``) so that a leaked HMAC secret
alone cannot mint forged outcome events from an arbitrary egress IP.

Configuration is environment-driven via
``ADHERENCE_INBOUND_WEBHOOK_IP_ALLOWLIST``:

    medtracker:10.0.0.0/8,medtracker:54.230.0.0/16,rxops:198.51.100.7

Semantics:

* Sources that appear in the allowlist accept traffic *only* from
  matching CIDRs. Everything else is rejected with a typed result so
  the route can emit ``403`` + a structured log line.
* Sources that do not appear in the allowlist are unrestricted (the
  gate is OFF for them). This keeps back-compat with partners who only
  rely on HMAC.
* Malformed CIDR entries are dropped at parse time and logged so a
  single typo cannot brick a healthy partner.
"""
from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from functools import lru_cache

from adherence_common.logging import get_logger

log = get_logger(__name__)


@dataclass(frozen=True)
class IpCheckResult:
    ok: bool
    reason: str = ""
    configured: bool = False


def _parse_one(raw: str) -> ipaddress._BaseNetwork | None:
    s = (raw or "").strip()
    if not s:
        return None
    if "/" not in s:
        try:
            addr = ipaddress.ip_address(s)
        except ValueError:
            log.warning("inbound_webhook_ip_bad_entry", entry=raw)
            return None
        s = f"{addr}/{addr.max_prefixlen}"
    try:
        return ipaddress.ip_network(s, strict=False)
    except ValueError:
        log.warning("inbound_webhook_ip_bad_entry", entry=raw)
        return None


def parse_allowlist(csv: str) -> dict[str, tuple[ipaddress._BaseNetwork, ...]]:
    """Parse ``"source:cidr,source:cidr"`` into ``{source: (network, ...)}``.

    Bad entries are skipped (and logged) rather than raising so a single
    fat-finger in ops config cannot brick the receiver for healthy
    partners.
    """
    out: dict[str, list[ipaddress._BaseNetwork]] = {}
    if not csv:
        return {}
    for chunk in csv.split(","):
        chunk = chunk.strip()
        if not chunk or ":" not in chunk:
            continue
        source, _, cidr = chunk.partition(":")
        source = source.strip()
        net = _parse_one(cidr)
        if not source or net is None:
            continue
        out.setdefault(source, []).append(net)
    return {k: tuple(v) for k, v in out.items()}


def _client_addr(client_ip: str) -> ipaddress._BaseAddress | None:
    try:
        return ipaddress.ip_address((client_ip or "").strip())
    except ValueError:
        return None


def check(
    *, source: str, client_ip: str, allowlist_csv: str
) -> IpCheckResult:
    """Return whether ``client_ip`` is allowed to post as ``source``.

    Gate is OFF (``ok=True``, ``configured=False``) when ``source`` has
    no rules. When rules exist, only matching addresses pass; everything
    else (including unparseable client IPs) is rejected.
    """
    table = parse_allowlist(allowlist_csv)
    nets = table.get(source)
    if not nets:
        return IpCheckResult(True, "no allowlist configured", False)
    addr = _client_addr(client_ip)
    if addr is None:
        return IpCheckResult(False, "client ip unparseable", True)
    for n in nets:
        if addr.version != n.version:
            continue
        if addr in n:
            return IpCheckResult(True, "allowed", True)
    return IpCheckResult(False, f"client ip {client_ip} not in allowlist", True)


def summary(allowlist_csv: str) -> dict[str, list[str]]:
    """Return ``{source: ["cidr", ...]}`` for the admin config endpoint."""
    return {k: [str(n) for n in v] for k, v in parse_allowlist(allowlist_csv).items()}


@lru_cache(maxsize=1)
def _noop_cache_marker() -> None:
    # Parse is cheap and the CSV is small; we intentionally do not cache
    # the parsed table so an operator can edit the env var and reload
    # settings without restarting workers.
    return None
