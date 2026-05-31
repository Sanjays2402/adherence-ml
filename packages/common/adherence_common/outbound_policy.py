"""SSRF defense for outbound webhook destinations.

Enterprise buyers fail procurement when a SaaS will POST to any URL the
caller supplies. A subscription pointed at ``http://169.254.169.254/`` or
``http://127.0.0.1:6379/`` turns the dispatcher into a confused deputy
that can exfiltrate cloud-metadata credentials or hit internal services.

This module enforces a destination policy at two points:

1. **Subscription create time** in ``routes/outbound.py``: rejects bad
   URLs early with a structured 400 so the operator sees the reason.
2. **Dispatch time** in ``outbound.dispatch``: re-resolves DNS and
   re-checks the policy on every send (DNS rebinding defense). When the
   policy rejects, a ``WebhookDelivery`` row is recorded with
   ``state='blocked'`` so the refusal is visible in the delivery log and
   counts against the audit trail; no HTTP request is made.

Defaults are deny-by-default for the dangerous categories:
* HTTP is rejected unless ``outbound_allow_http=true`` (HTTPS only).
* Private / loopback / link-local / multicast / reserved IPs are rejected
  unless ``outbound_allow_private=true`` (kept off in prod).
* Cloud metadata endpoints (AWS 169.254.169.254, GCP metadata.google.internal,
  Azure 169.254.169.254) are ALWAYS rejected, regardless of the
  ``outbound_allow_private`` toggle, because they have no legitimate
  outbound-webhook use case.
* When ``outbound_host_allowlist`` is set, only hostnames in the
  comma-separated list (exact match or ``.suffix`` match) are accepted.
"""
from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from typing import Iterable
from urllib.parse import urlparse

from adherence_common.settings import get_settings


# Hostnames that should never be reachable as outbound webhook targets,
# regardless of the private-IP toggle. Cloud-provider metadata services
# all live behind these names or the link-local IP.
_METADATA_HOSTS = frozenset({
    "metadata.google.internal",
    "metadata",  # short form sometimes used in GCP
    "169.254.169.254",
    "fd00:ec2::254",  # AWS IMDS over IPv6
})


@dataclass(frozen=True)
class PolicyDecision:
    """Result of evaluating a URL against the outbound policy."""
    allowed: bool
    reason: str | None  # None when allowed
    resolved_ips: tuple[str, ...] = ()

    def as_dict(self) -> dict:
        return {
            "allowed": self.allowed,
            "reason": self.reason,
            "resolved_ips": list(self.resolved_ips),
        }


class OutboundPolicyError(ValueError):
    """Raised by ``ensure_allowed`` when a URL violates the policy.

    The string carries a human-readable reason (safe to surface in API
    error bodies). Callers in HTTP routes typically convert this to a
    400 with ``detail={"code": "outbound_blocked", "reason": str(exc)}``.
    """


def _split_csv(raw: str | None) -> tuple[str, ...]:
    if not raw:
        return ()
    return tuple(s.strip().lower() for s in raw.split(",") if s.strip())


def _host_matches_allowlist(host: str, allowlist: Iterable[str]) -> bool:
    host = host.lower().strip(".")
    for entry in allowlist:
        if not entry:
            continue
        if entry == host:
            return True
        # ``.example.com`` matches any subdomain of example.com but not
        # the bare apex; ``example.com`` matches only the apex.
        if entry.startswith(".") and host.endswith(entry):
            return True
    return False


def _resolve(host: str) -> tuple[str, ...]:
    """Return all A/AAAA records for ``host``. Empty tuple on failure.

    We resolve here (not in ``ip_is_blocked``) so dispatch-time checks see
    fresh DNS even when the subscription was created hours ago.
    """
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return ()
    seen: list[str] = []
    for info in infos:
        ip = info[4][0]
        # Strip IPv6 scope id (``fe80::1%en0`` -> ``fe80::1``).
        if "%" in ip:
            ip = ip.split("%", 1)[0]
        if ip not in seen:
            seen.append(ip)
    return tuple(seen)


def _ip_is_blocked(ip_str: str, allow_private: bool) -> str | None:
    """Return a refusal reason for ``ip_str`` or None when it's fine."""
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return f"invalid ip address {ip_str!r}"
    # Metadata IPs are *always* blocked.
    if ip_str in {"169.254.169.254"} or str(ip) in {"fd00:ec2::254"}:
        return "cloud metadata endpoint is not a permitted destination"
    # Link-local catches 169.254.0.0/16 and fe80::/10.
    if ip.is_link_local:
        return f"link-local address {ip} is not permitted"
    if allow_private:
        return None
    if ip.is_loopback:
        return f"loopback address {ip} is not permitted"
    if ip.is_private:
        return f"private address {ip} is not permitted"
    if ip.is_multicast:
        return f"multicast address {ip} is not permitted"
    if ip.is_reserved:
        return f"reserved address {ip} is not permitted"
    if ip.is_unspecified:
        return f"unspecified address {ip} is not permitted"
    return None


def evaluate(url: str, *, settings=None) -> PolicyDecision:
    """Evaluate a destination URL. Pure function, never raises."""
    s = settings or get_settings()
    allow_private = bool(getattr(s, "outbound_allow_private", False))
    allow_http = bool(getattr(s, "outbound_allow_http", False))
    allowlist = _split_csv(getattr(s, "outbound_host_allowlist", ""))

    try:
        parsed = urlparse(url)
    except ValueError as exc:
        return PolicyDecision(False, f"malformed url: {exc}")
    scheme = (parsed.scheme or "").lower()
    if scheme not in {"http", "https"}:
        return PolicyDecision(False, f"scheme {scheme!r} is not permitted")
    if scheme == "http" and not allow_http:
        return PolicyDecision(False, "http is not permitted (set outbound_allow_http=true for dev)")

    host = (parsed.hostname or "").strip()
    if not host:
        return PolicyDecision(False, "url has no host")

    # Reject userinfo (``http://user:pass@host``) as a footgun; nobody
    # should be smuggling credentials through subscription urls.
    if parsed.username or parsed.password:
        return PolicyDecision(False, "url userinfo (user:pass@) is not permitted")

    host_l = host.lower().strip("[]")  # strip IPv6 brackets
    if host_l in _METADATA_HOSTS:
        return PolicyDecision(False, "cloud metadata host is not a permitted destination")

    # Allowlist gate (if configured) operates on the *hostname* the user
    # typed, not the resolved IP. We still IP-check below for SSRF defense.
    if allowlist and not _host_matches_allowlist(host_l, allowlist):
        return PolicyDecision(False, f"host {host_l!r} is not in outbound_host_allowlist")

    # Resolve and check every address. If the literal is already an IP,
    # ``getaddrinfo`` returns it verbatim.
    ips = _resolve(host_l)
    if not ips:
        if allow_private:
            # Dev/test mode: don't block on unresolvable hostnames
            # (test suites use fake TLDs like ``.test``).
            return PolicyDecision(True, None, ())
        return PolicyDecision(False, f"could not resolve host {host_l!r}", ())
    for ip in ips:
        reason = _ip_is_blocked(ip, allow_private=allow_private)
        if reason:
            return PolicyDecision(False, reason, ips)
    return PolicyDecision(True, None, ips)


def ensure_allowed(url: str, *, settings=None) -> PolicyDecision:
    """Same as ``evaluate`` but raises ``OutboundPolicyError`` on refusal.

    Use this inside HTTP routes that should fail fast at subscription
    creation time. Returns the (allowed) decision on success so callers
    can record ``resolved_ips`` if they want.
    """
    decision = evaluate(url, settings=settings)
    if not decision.allowed:
        raise OutboundPolicyError(decision.reason or "destination blocked")
    return decision


__all__ = [
    "PolicyDecision",
    "OutboundPolicyError",
    "evaluate",
    "ensure_allowed",
]
