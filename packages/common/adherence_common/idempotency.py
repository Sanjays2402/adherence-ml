"""Idempotency-Key cache backed by the app DB.

Lets webhook callers safely retry POST endpoints without causing duplicate
work or audit rows. Replays return the original status code and body for
``ttl_seconds``. Reusing the same key with a *different* request payload
raises ``IdempotencyConflict`` (HTTP 409 by convention).
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete, select

from adherence_common.db import IdempotencyRecord, init_db, session


class IdempotencyConflict(Exception):
    """Same key + caller + route but a different request payload."""


def hash_body(body: Any) -> str:
    raw = json.dumps(body, sort_keys=True, default=str).encode()
    return hashlib.sha256(raw).hexdigest()


def _gc(s, now: datetime) -> None:
    s.execute(delete(IdempotencyRecord).where(IdempotencyRecord.expires_at < now))


def lookup(
    key: str, *, caller: str, route: str, request_hash: str,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    init_db()
    now = now or datetime.utcnow()
    with session() as s:
        _gc(s, now)
        s.commit()
        row = s.execute(
            select(IdempotencyRecord)
            .where(IdempotencyRecord.key == key)
            .where(IdempotencyRecord.caller == caller)
            .where(IdempotencyRecord.route == route)
            .where(IdempotencyRecord.expires_at >= now)
        ).scalar_one_or_none()
        if row is None:
            return None
        if row.request_hash != request_hash:
            raise IdempotencyConflict(
                f"Idempotency-Key '{key}' was previously used with a different payload"
            )
        return {
            "status_code": int(row.status_code),
            "response": row.response_json,
            "created_at": row.created_at,
        }


def store(
    key: str, *, caller: str, route: str, request_hash: str,
    status_code: int, response: Any, ttl_seconds: int = 86400,
    now: datetime | None = None,
) -> None:
    init_db()
    now = now or datetime.utcnow()
    expires = now + timedelta(seconds=max(1, int(ttl_seconds)))
    with session() as s:
        existing = s.execute(
            select(IdempotencyRecord)
            .where(IdempotencyRecord.key == key)
            .where(IdempotencyRecord.caller == caller)
            .where(IdempotencyRecord.route == route)
        ).scalar_one_or_none()
        if existing is not None:
            return
        s.add(IdempotencyRecord(
            key=key, caller=caller, route=route, request_hash=request_hash,
            status_code=int(status_code), response_json=response,
            created_at=now, expires_at=expires,
        ))
        s.commit()
