"""Per-user / per-dose-class risk tier policies.

The default tiering (low<medium<high cutoffs) lives in
``adherence_common.constants.DEFAULT_RISK_THRESHOLDS``. Operators can
override it for specific users or dose classes by writing a
``UserRiskPolicy`` row. Resolution order at predict time:

    1. scope_type='user' and scope_id=<user_id>           (most specific)
    2. scope_type='dose_class' and scope_id=<dose_class>
    3. global defaults                                    (fallback)

A simple in-process cache (TTL 30s) keeps the hot path off the DB.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional

from sqlalchemy import delete, select

from adherence_common.constants import DEFAULT_RISK_THRESHOLDS
from adherence_common.db import UserRiskPolicy, init_db, session


@dataclass(frozen=True)
class Thresholds:
    low_max: float
    medium_max: float

    def tier(self, p: float) -> str:
        if p < self.low_max:
            return "low"
        if p < self.medium_max:
            return "medium"
        return "high"


GLOBAL = Thresholds(
    low_max=float(DEFAULT_RISK_THRESHOLDS["medium"]),
    medium_max=float(DEFAULT_RISK_THRESHOLDS["high"]),
)


_CACHE: dict[tuple[str, str], tuple[float, Thresholds]] = {}
_CACHE_TTL_S = 30.0


def _cache_get(scope_type: str, scope_id: str) -> Optional[Thresholds]:
    hit = _CACHE.get((scope_type, scope_id))
    if hit is None:
        return None
    expires, t = hit
    if expires < time.monotonic():
        _CACHE.pop((scope_type, scope_id), None)
        return None
    return t


def _cache_put(scope_type: str, scope_id: str, t: Thresholds | None) -> None:
    if t is None:
        # cache misses too, with a shorter TTL via sentinel
        _CACHE[(scope_type, scope_id)] = (time.monotonic() + 5.0, GLOBAL)
    else:
        _CACHE[(scope_type, scope_id)] = (time.monotonic() + _CACHE_TTL_S, t)


def clear_cache() -> None:
    _CACHE.clear()


def _load(scope_type: str, scope_id: str) -> Thresholds | None:
    cached = _cache_get(scope_type, scope_id)
    if cached is not None:
        return cached if cached is not GLOBAL else None
    init_db()
    with session() as s:
        row = s.execute(
            select(UserRiskPolicy)
            .where(UserRiskPolicy.scope_type == scope_type)
            .where(UserRiskPolicy.scope_id == scope_id)
        ).scalar_one_or_none()
    t = Thresholds(low_max=float(row.low_max), medium_max=float(row.medium_max)) if row else None
    _cache_put(scope_type, scope_id, t)
    return t


def resolve(user_id: str, dose_class: str | None) -> Thresholds:
    """Return the effective tier thresholds for this user+dose_class."""
    t = _load("user", user_id)
    if t is not None:
        return t
    if dose_class:
        t = _load("dose_class", dose_class)
        if t is not None:
            return t
    return GLOBAL


def upsert(
    *, scope_type: str, scope_id: str,
    low_max: float, medium_max: float,
    note: str | None = None, updated_by: str | None = None,
) -> dict:
    if scope_type not in ("user", "dose_class"):
        raise ValueError("scope_type must be 'user' or 'dose_class'")
    if not (0.0 < low_max < medium_max < 1.0):
        raise ValueError("require 0 < low_max < medium_max < 1")
    init_db()
    from datetime import datetime
    with session() as s:
        existing = s.execute(
            select(UserRiskPolicy)
            .where(UserRiskPolicy.scope_type == scope_type)
            .where(UserRiskPolicy.scope_id == scope_id)
        ).scalar_one_or_none()
        if existing is None:
            row = UserRiskPolicy(
                scope_type=scope_type, scope_id=scope_id,
                low_max=low_max, medium_max=medium_max,
                note=note, updated_by=updated_by,
                updated_at=datetime.utcnow(),
            )
            s.add(row)
        else:
            existing.low_max = low_max
            existing.medium_max = medium_max
            existing.note = note
            existing.updated_by = updated_by
            existing.updated_at = datetime.utcnow()
            row = existing
        s.commit()
        s.refresh(row)
        out = {
            "id": row.id, "scope_type": row.scope_type, "scope_id": row.scope_id,
            "low_max": float(row.low_max), "medium_max": float(row.medium_max),
            "note": row.note, "updated_by": row.updated_by,
            "updated_at": row.updated_at.isoformat(),
        }
    clear_cache()
    return out


def delete_policy(scope_type: str, scope_id: str) -> bool:
    init_db()
    with session() as s:
        res = s.execute(
            delete(UserRiskPolicy)
            .where(UserRiskPolicy.scope_type == scope_type)
            .where(UserRiskPolicy.scope_id == scope_id)
        )
        s.commit()
    clear_cache()
    return res.rowcount > 0


def list_policies() -> list[dict]:
    init_db()
    with session() as s:
        rows = s.execute(select(UserRiskPolicy)).scalars().all()
        return [{
            "id": r.id, "scope_type": r.scope_type, "scope_id": r.scope_id,
            "low_max": float(r.low_max), "medium_max": float(r.medium_max),
            "note": r.note, "updated_by": r.updated_by,
            "updated_at": r.updated_at.isoformat(),
        } for r in rows]
