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


VALID_ROLES = {"admin", "service", "viewer"}


@dataclass
class ResolvedKey:
    name: str
    role: str
    scopes: frozenset[str]
    record_id: int
    tenant_id: str = "default"


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
        rid = row.id
        resolved = ResolvedKey(
            name=row.name, role=row.role,
            scopes=_parse_scopes(row.scopes_csv), record_id=rid,
            tenant_id=(row.tenant_id or "default"),
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
