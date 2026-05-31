"""Database-backed API keys with scopes, expiry, and revocation.

Static `ADHERENCE_API_KEYS` env keys remain supported for bootstrap and
local dev. Production deployments add keys via /v1/admin/api-keys, which
stores a SHA-256 hash of the secret (never the plaintext) in
`api_key_records`. On each request we hash the presented key and look it
up; misses fall through to the env map.

Each row carries a `role` (admin | service | viewer), an optional set of
fine-grained `scopes` (e.g. "predict", "intervene"), optional `expires_at`,
and a `revoked` flag. Lookup checks expiry and revoked atomically.

A 24-hour rolling `last_used_at` is written best-effort so operators can
spot dormant keys.
"""
from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Iterable

from sqlalchemy import (
    Column, DateTime, Integer, String, Text, select, update,
)

from adherence_common.db import Base, init_db, session
from adherence_common.errors import AuthError


class APIKeyRecord(Base):
    """One row per issued API key. ``key_hash`` is sha256(plaintext).

    ``scopes_csv`` is a comma-separated allowlist of fine-grained scopes
    that endpoints may consult on top of the coarse role check. An empty
    value means "all scopes the role allows".
    """
    __tablename__ = "api_key_records"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(64), nullable=False, unique=True, index=True)
    key_prefix = Column(String(12), nullable=False, index=True)
    key_hash = Column(String(64), nullable=False, unique=True, index=True)
    role = Column(String(16), nullable=False)
    tenant_id = Column(String(64), nullable=False, default="default", index=True)
    scopes_csv = Column(String(256), nullable=True)
    note = Column(Text, nullable=True)
    created_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=True, index=True)
    revoked_at = Column(DateTime, nullable=True, index=True)
    last_used_at = Column(DateTime, nullable=True)
    # Best-effort attribution for the most recent successful resolve of
    # this key. Lets admins answer 'where was this key just used from?'
    # in the dashboard without trawling the request log. Both fields are
    # truncated and never used to make security decisions; they are
    # display-only telemetry intended for SOC2-style anomaly review.
    last_used_ip = Column(String(64), nullable=True)
    last_used_user_agent = Column(String(256), nullable=True)
    # Comma-separated list of CIDRs (or bare IPs). Empty/NULL means the
    # key is not restricted by source IP. Enforced by middleware on every
    # request whose credential resolves to this key.
    ip_allowlist_csv = Column(String(1024), nullable=True)
    rotated_at = Column(DateTime, nullable=True)
    rotation_count = Column(Integer, nullable=False, default=0)
    # Optional per-key rate-limit overrides. NULL on either column means
    # the key inherits the role-tier defaults from settings. When both are
    # set the middleware bypasses tier limits and uses these values.
    rate_limit_capacity = Column(Integer, nullable=True)
    rate_limit_refill_per_sec = Column(String(32), nullable=True)


VALID_ROLES = {"admin", "service", "viewer"}


@dataclass
class ResolvedKey:
    name: str
    role: str
    scopes: frozenset[str]
    record_id: int
    tenant_id: str = "default"
    ip_allowlist: tuple[str, ...] = ()
    rate_limit_capacity: int | None = None
    rate_limit_refill_per_sec: float | None = None


def _hash(plain: str) -> str:
    return hashlib.sha256(plain.encode("utf-8")).hexdigest()


def _parse_scopes(csv: str | None) -> frozenset[str]:
    if not csv:
        return frozenset()
    return frozenset(s.strip() for s in csv.split(",") if s.strip())


def generate_key(prefix: str = "ak") -> tuple[str, str, str]:
    """Returns (plaintext, key_prefix, key_hash). Plaintext shown once."""
    body = secrets.token_urlsafe(32)
    plain = f"{prefix}_{body}"
    return plain, plain[:12], _hash(plain)


def create_key(
    *,
    name: str,
    role: str,
    scopes: Iterable[str] = (),
    note: str | None = None,
    created_by: str | None = None,
    ttl_seconds: int | None = None,
    tenant_id: str = "default",
) -> tuple[str, APIKeyRecord]:
    """Create a key; returns (plaintext, row). Caller must surface plaintext
    to the user immediately. It is never recoverable afterwards.
    """
    if role not in VALID_ROLES:
        raise ValueError(f"invalid role {role!r}")
    init_db()
    plain, prefix, key_hash = generate_key()
    scopes_csv = ",".join(sorted({s.strip() for s in scopes if s and s.strip()})) or None
    expires = (
        datetime.utcnow() + timedelta(seconds=ttl_seconds)
        if ttl_seconds and ttl_seconds > 0
        else None
    )
    with session() as s:
        existing = s.execute(
            select(APIKeyRecord).where(APIKeyRecord.name == name)
        ).scalar_one_or_none()
        if existing is not None:
            raise ValueError(f"api key {name!r} already exists")
        row = APIKeyRecord(
            name=name,
            key_prefix=prefix,
            key_hash=key_hash,
            role=role,
            tenant_id=(tenant_id or "default").strip() or "default",
            scopes_csv=scopes_csv,
            note=note,
            created_by=created_by,
            created_at=datetime.utcnow(),
            expires_at=expires,
        )
        s.add(row)
        s.commit()
        s.refresh(row)
        return plain, row


def list_keys() -> list[APIKeyRecord]:
    init_db()
    with session() as s:
        return list(s.scalars(select(APIKeyRecord).order_by(APIKeyRecord.id.asc())))


def rotate_key(
    name: str,
    *,
    by: str | None = None,
    extend_ttl_seconds: int | None = None,
) -> tuple[str, APIKeyRecord]:
    """Rotate the secret for an existing key in place.

    Generates a fresh plaintext, replaces ``key_hash``/``key_prefix``,
    bumps ``rotation_count``, and stamps ``rotated_at``. Identity, role,
    scopes, tenant, IP allowlist, and audit-relevant metadata are
    preserved so downstream RBAC and tenant scoping continue to apply
    without operator intervention.

    ``extend_ttl_seconds`` optionally pushes ``expires_at`` forward to
    ``now + extend_ttl_seconds`` so a rotated key can be re-issued with
    a fresh validity window. Pass ``None`` to leave the existing expiry
    intact (the common case).

    Raises ``LookupError`` if no such key exists, ``ValueError`` if the
    key is revoked or expired (those must be re-created, not rotated).
    Caller must surface the returned plaintext immediately; it is the
    only opportunity to read it.
    """
    init_db()
    now = datetime.utcnow()
    with session() as s:
        row = s.execute(
            select(APIKeyRecord).where(APIKeyRecord.name == name)
        ).scalar_one_or_none()
        if row is None:
            raise LookupError(f"api key {name!r} not found")
        if row.revoked_at is not None:
            raise ValueError("cannot rotate a revoked key")
        if row.expires_at is not None and row.expires_at <= now and not extend_ttl_seconds:
            raise ValueError("cannot rotate an expired key without extend_ttl_seconds")
        plain, prefix, key_hash = generate_key()
        row.key_prefix = prefix
        row.key_hash = key_hash
        row.rotated_at = now
        row.rotation_count = int(row.rotation_count or 0) + 1
        row.last_used_at = None
        if extend_ttl_seconds and extend_ttl_seconds > 0:
            row.expires_at = now + timedelta(seconds=extend_ttl_seconds)
        if by:
            note = (row.note or "").rstrip()
            stamp = f"[rotated by {by} @ {now.isoformat()}]"
            row.note = f"{note} {stamp}".strip() if note else stamp
        s.commit()
        s.refresh(row)
        return plain, row


def revoke_key(name: str, *, by: str | None = None) -> bool:
    init_db()
    now = datetime.utcnow()
    with session() as s:
        row = s.execute(
            select(APIKeyRecord).where(APIKeyRecord.name == name)
        ).scalar_one_or_none()
        if row is None:
            return False
        if row.revoked_at is not None:
            return True
        row.revoked_at = now
        if by:
            row.note = (row.note or "") + f" [revoked by {by} @ {now.isoformat()}]"
        s.commit()
        return True


def _auto_revoke_if_dormant(s, row: APIKeyRecord, now: datetime) -> None:
    """If the row's tenant has ``max_dormant_days`` configured and the
    key has been idle longer than that window, mark it revoked in-place
    inside the open session ``s`` and raise ``AuthError``.

    The function is best-effort about the policy lookup (fail-open via
    :func:`dormant_threshold_seconds`) but strict about enforcement once
    a threshold is known: a stale key is always rejected.
    """
    # Late import to avoid a hard cycle between api_keys and api_key_policy.
    from adherence_common.api_key_policy import (  # noqa: WPS433
        dormant_threshold_seconds,
    )
    threshold = dormant_threshold_seconds(row.tenant_id or "default")
    if threshold is None:
        return
    reference = row.last_used_at or row.rotated_at or row.created_at
    if reference is None:
        return
    age = (now - reference).total_seconds()
    if age < threshold:
        return
    row.revoked_at = now
    days = int(threshold // 86400)
    note = (row.note or "").rstrip()
    stamp = f"[auto-disabled: dormant {days}d @ {now.isoformat()}]"
    row.note = f"{note} {stamp}".strip() if note else stamp
    try:
        s.commit()
    except Exception:  # pragma: no cover - defensive
        s.rollback()
    # Best-effort admin audit so SOC2 reviewers can see automated
    # revocations next to manual ones. Failure must not mask the auth
    # outcome.
    try:
        from adherence_common.admin_audit import record_admin_action  # noqa: WPS433
        record_admin_action(
            action="api_key.auto_disabled.dormant",
            principal={"sub": "system", "role": "system"},
            target=str(row.name),
            details={
                "tenant_id": row.tenant_id,
                "max_dormant_days": days,
                "idle_seconds": int(age),
                "last_used_at": (
                    row.last_used_at.isoformat() if row.last_used_at else None
                ),
            },
            ok=True,
        )
    except Exception:
        pass
    raise AuthError("api key auto-disabled (dormant)")


def resolve_db_key(plain: str) -> ResolvedKey | None:
    """Return a ResolvedKey or None if the plaintext is not a valid DB key.

    Raises AuthError when the key exists but is expired or revoked, so
    callers do not silently fall back to env keys for a known-bad token.
    """
    if not plain:
        return None
    init_db()
    key_hash = _hash(plain)
    now = datetime.utcnow()
    with session() as s:
        row = s.execute(
            select(APIKeyRecord).where(APIKeyRecord.key_hash == key_hash)
        ).scalar_one_or_none()
        if row is None:
            return None
        if row.revoked_at is not None:
            raise AuthError("api key revoked")
        if row.expires_at is not None and row.expires_at <= now:
            raise AuthError("api key expired")
        # Per-workspace dormancy auto-disable. When the workspace policy
        # sets max_dormant_days and this key has been idle for longer
        # than that window we revoke it in-place (with an audit row) and
        # surface AuthError so the caller cannot transparently fall back
        # to env keys. Reference age is the most recent of created_at /
        # rotated_at / last_used_at so a freshly minted key always gets
        # at least its first dormancy window of usable time.
        _auto_revoke_if_dormant(s, row, now)
        rid = row.id
        ip_raw = (row.ip_allowlist_csv or "")
        ip_list = tuple(
            s.strip() for s in ip_raw.split(",") if s.strip()
        )
        resolved = ResolvedKey(
            name=row.name, role=row.role,
            scopes=_parse_scopes(row.scopes_csv), record_id=rid,
            tenant_id=(row.tenant_id or "default"),
            ip_allowlist=ip_list,
            rate_limit_capacity=(
                int(row.rate_limit_capacity)
                if row.rate_limit_capacity is not None else None
            ),
            rate_limit_refill_per_sec=(
                float(row.rate_limit_refill_per_sec)
                if row.rate_limit_refill_per_sec is not None else None
            ),
        )
    # best-effort last_used_at; ignore failures
    try:
        with session() as s2:
            s2.execute(
                update(APIKeyRecord)
                .where(APIKeyRecord.id == rid)
                .values(last_used_at=now)
            )
            s2.commit()
    except Exception:
        pass
    return resolved


def touch_last_seen(
    record_id: int,
    *,
    client_ip: str | None = None,
    user_agent: str | None = None,
    when: datetime | None = None,
) -> None:
    """Best-effort write of the last source IP and User-Agent for a key.

    Called from the FastAPI auth dependency once the principal has been
    resolved. Failures are swallowed; this is display-only telemetry and
    must never break an authenticated request. Empty / whitespace meta
    values are no-ops so we never clobber a previously recorded address
    with blanks (e.g. when the request arrives without an X-Forwarded-For
    header or User-Agent).
    """
    if not record_id:
        return
    ip = (client_ip or "").strip()[:64] or None
    ua = (user_agent or "").strip()[:256] or None
    if ip is None and ua is None:
        return
    ts = when or datetime.utcnow()
    values: dict[str, object] = {"last_used_at": ts}
    if ip is not None:
        values["last_used_ip"] = ip
    if ua is not None:
        values["last_used_user_agent"] = ua
    try:
        with session() as s2:
            s2.execute(
                update(APIKeyRecord)
                .where(APIKeyRecord.id == record_id)
                .values(**values)
            )
            s2.commit()
    except Exception:
        pass

# ---- Per-key IP/CIDR allowlist -------------------------------------------

import ipaddress as _ipaddress


def parse_cidrs(values: Iterable[str]) -> list[str]:
    """Validate and normalize CIDRs / bare IPs. Raises ValueError on bad input.

    Returns a deduplicated, sorted list of canonical strings ready to persist.
    Bare IPs are pinned to a single-host network ("/32" or "/128").
    """
    out: set[str] = set()
    for raw in values:
        s = (raw or "").strip()
        if not s:
            continue
        if "/" not in s:
            try:
                addr = _ipaddress.ip_address(s)
            except ValueError as exc:
                raise ValueError(f"invalid ip: {s}") from exc
            net = _ipaddress.ip_network(
                f"{addr}/{32 if addr.version == 4 else 128}",
                strict=True,
            )
        else:
            try:
                net = _ipaddress.ip_network(s, strict=False)
            except ValueError as exc:
                raise ValueError(f"invalid cidr: {s}") from exc
        out.add(str(net))
    return sorted(out)


def ip_matches_allowlist(ip: str, cidrs: Iterable[str]) -> bool:
    """Return True if ``ip`` is inside any CIDR in ``cidrs``.

    Empty ``cidrs`` means no restriction (caller should treat as allowed).
    Malformed entries are skipped defensively so a bad row cannot lock out
    every caller.
    """
    items = [c for c in cidrs if c]
    if not items:
        return True
    try:
        addr = _ipaddress.ip_address((ip or "").strip())
    except ValueError:
        return False
    for c in items:
        try:
            net = _ipaddress.ip_network(c, strict=False)
        except ValueError:
            continue
        if addr in net:
            return True
    return False


def set_key_ip_allowlist(name: str, cidrs: Iterable[str]) -> APIKeyRecord:
    """Replace the per-key IP allowlist. Empty list clears the restriction.

    Raises ValueError on bad input (caller surfaces 400). Raises LookupError
    if the named key does not exist.
    """
    cleaned = parse_cidrs(cidrs)
    csv = ",".join(cleaned) if cleaned else None
    init_db()
    with session() as s:
        row = s.execute(
            select(APIKeyRecord).where(APIKeyRecord.name == name)
        ).scalar_one_or_none()
        if row is None:
            raise LookupError(f"api key {name!r} not found")
        row.ip_allowlist_csv = csv
        s.commit()
        s.refresh(row)
        return row


# ---- Per-key rate-limit overrides ---------------------------------------


def set_key_rate_limit(
    name: str,
    *,
    capacity: int | None,
    refill_per_sec: float | None,
) -> APIKeyRecord:
    """Set or clear the per-key rate-limit override.

    Pass both ``capacity`` and ``refill_per_sec`` to install an override.
    Pass both as ``None`` to clear the override (key falls back to the
    role-tier defaults). Mixed (one None, one set) is rejected because
    the middleware needs both to compute a bucket.

    Raises ValueError on invalid input, LookupError if the key is unknown.
    """
    if (capacity is None) != (refill_per_sec is None):
        raise ValueError(
            "capacity and refill_per_sec must both be set or both be cleared"
        )
    if capacity is not None:
        if int(capacity) <= 0 or int(capacity) > 1_000_000:
            raise ValueError("capacity must be in [1, 1_000_000]")
        if not (float(refill_per_sec) > 0.0 and float(refill_per_sec) <= 100_000.0):
            raise ValueError("refill_per_sec must be in (0, 100_000]")
    init_db()
    with session() as s:
        row = s.execute(
            select(APIKeyRecord).where(APIKeyRecord.name == name)
        ).scalar_one_or_none()
        if row is None:
            raise LookupError(f"api key {name!r} not found")
        if capacity is None:
            row.rate_limit_capacity = None
            row.rate_limit_refill_per_sec = None
        else:
            row.rate_limit_capacity = int(capacity)
            row.rate_limit_refill_per_sec = f"{float(refill_per_sec):.6f}"
        s.commit()
        s.refresh(row)
        return row


def get_key_rate_limit(name: str) -> tuple[int | None, float | None]:
    init_db()
    with session() as s:
        row = s.execute(
            select(APIKeyRecord).where(APIKeyRecord.name == name)
        ).scalar_one_or_none()
        if row is None:
            raise LookupError(f"api key {name!r} not found")
        cap = row.rate_limit_capacity
        refill_raw = row.rate_limit_refill_per_sec
        try:
            refill = float(refill_raw) if refill_raw is not None else None
        except (TypeError, ValueError):
            refill = None
        return (int(cap) if cap is not None else None, refill)


def get_key_ip_allowlist(name: str) -> list[str]:
    init_db()
    with session() as s:
        row = s.execute(
            select(APIKeyRecord).where(APIKeyRecord.name == name)
        ).scalar_one_or_none()
        if row is None:
            raise LookupError(f"api key {name!r} not found")
        return [c for c in (row.ip_allowlist_csv or "").split(",") if c]
