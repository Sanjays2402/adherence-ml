"""Deployment-wide API deprecation registry (RFC 8594 + draft-ietf-httpapi-deprecation-header).

Procurement reviewers ask: "what is your API lifecycle policy and how
do customers know when an endpoint goes away?" This registry is the
machine-readable answer. Operators register a route prefix + HTTP
method along with:

* ``deprecated_at`` (IMF-fixdate, becomes the ``Deprecation`` header)
* ``sunset_at`` (IMF-fixdate, becomes the ``Sunset`` header per RFC 8594)
* ``successor_link`` (becomes ``Link: <url>; rel="successor-version"``)
* ``reason`` (human-readable changelog blurb)

The registry is deployment-wide because endpoints are part of the
product, not per-tenant. Per-tenant *usage* of deprecated endpoints
is tracked separately in :class:`DeprecatedRouteUsage` so each
workspace can see "are we still calling anything that is going
away?" without leaking cross-tenant traffic patterns.

The middleware reads from this table on every response and stamps
the standard headers, so SDKs and infra teams can spot sunsets
automatically without polling a changelog.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from threading import Lock
from typing import Iterable

from sqlalchemy import Column, DateTime, Integer, String, Text, UniqueConstraint, select, func

from adherence_common.db import Base, session
from adherence_common.logging import get_logger

log = get_logger(__name__)


# IMF-fixdate per RFC 7231 section 7.1.1.1, required by RFC 8594.
_IMF_FMT = "%a, %d %b %Y %H:%M:%S GMT"


def to_imf_fixdate(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime(_IMF_FMT)


def parse_iso(value: str) -> datetime:
    """Parse a caller-supplied ISO 8601 datetime, return tz-aware UTC."""
    s = value.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


class DeprecationError(ValueError):
    """Raised when a registry write would produce an invalid row."""


class ApiDeprecation(Base):
    """A deployment-wide deprecation entry for one route prefix + method.

    ``method = "*"`` matches every HTTP verb. ``path_prefix`` matches by
    string prefix so a single row can cover a whole router (e.g.
    ``/v1/predict``) or one specific path (``/v1/predict/batch``).
    """
    __tablename__ = "api_deprecation"
    __table_args__ = (UniqueConstraint("method", "path_prefix", name="uq_api_dep_route"),)
    id = Column(Integer, primary_key=True, autoincrement=True)
    method = Column(String(8), nullable=False, default="*")
    path_prefix = Column(String(255), nullable=False)
    deprecated_at = Column(DateTime, nullable=False)
    sunset_at = Column(DateTime, nullable=False)
    successor_link = Column(String(500), nullable=True)
    reason = Column(Text, nullable=True)
    created_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class DeprecatedRouteUsage(Base):
    """Per-tenant counter for calls hitting a deprecated route entry.

    Rows are upserted by the middleware on each request so an admin
    page can show "you called this 142 times last week, sunset is
    in 17 days". Tenant isolation: every query is filtered by the
    caller's resolved ``tenant_id``, mirroring the rest of the app's
    multi-tenant model.
    """
    __tablename__ = "deprecated_route_usage"
    __table_args__ = (
        UniqueConstraint("tenant_id", "deprecation_id", name="uq_dep_usage_tenant"),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    deprecation_id = Column(Integer, nullable=False, index=True)
    hits = Column(Integer, default=0, nullable=False)
    last_seen_at = Column(DateTime, nullable=True)


@dataclass(frozen=True)
class DeprecationOut:
    id: int
    method: str
    path_prefix: str
    deprecated_at: str
    sunset_at: str
    successor_link: str | None
    reason: str | None
    created_by: str | None
    created_at: str

    def to_public(self) -> dict:
        return {
            "method": self.method,
            "path_prefix": self.path_prefix,
            "deprecated_at": self.deprecated_at,
            "sunset_at": self.sunset_at,
            "successor_link": self.successor_link,
            "reason": self.reason,
        }


# In-process cache of (method, prefix, id, deprecated_imf, sunset_imf,
# successor_link). Refreshed at most every CACHE_TTL_SECONDS so the
# middleware path stays cheap.
CACHE_TTL_SECONDS = 30
_cache: tuple[float, tuple[tuple, ...]] | None = None
_cache_lock = Lock()


def _now_monotonic() -> float:
    import time
    return time.monotonic()


def _row_to_out(r: ApiDeprecation) -> DeprecationOut:
    return DeprecationOut(
        id=int(r.id),
        method=str(r.method),
        path_prefix=str(r.path_prefix),
        deprecated_at=to_imf_fixdate(r.deprecated_at),
        sunset_at=to_imf_fixdate(r.sunset_at),
        successor_link=(str(r.successor_link) if r.successor_link else None),
        reason=(str(r.reason) if r.reason else None),
        created_by=(str(r.created_by) if r.created_by else None),
        created_at=r.created_at.isoformat() + "Z",
    )


def invalidate_cache() -> None:
    global _cache
    with _cache_lock:
        _cache = None


def _validated_method(method: str) -> str:
    m = (method or "*").strip().upper()
    if m == "*":
        return "*"
    if m not in {"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"}:
        raise DeprecationError(f"unsupported method: {method!r}")
    return m


def _validated_prefix(prefix: str) -> str:
    p = (prefix or "").strip()
    if not p.startswith("/"):
        raise DeprecationError("path_prefix must start with '/'")
    if len(p) > 255:
        raise DeprecationError("path_prefix too long")
    return p


def list_entries() -> list[DeprecationOut]:
    with session() as s:
        rows = s.execute(select(ApiDeprecation).order_by(ApiDeprecation.id.asc())).scalars().all()
        return [_row_to_out(r) for r in rows]


def get_entry(entry_id: int) -> DeprecationOut | None:
    with session() as s:
        row = s.get(ApiDeprecation, entry_id)
        return _row_to_out(row) if row else None


def add_entry(
    *,
    method: str,
    path_prefix: str,
    deprecated_at: str,
    sunset_at: str,
    successor_link: str | None = None,
    reason: str | None = None,
    created_by: str | None = None,
) -> DeprecationOut:
    m = _validated_method(method)
    p = _validated_prefix(path_prefix)
    try:
        d = parse_iso(deprecated_at)
        su = parse_iso(sunset_at)
    except ValueError as exc:
        raise DeprecationError(f"invalid datetime: {exc}") from exc
    if su <= d:
        raise DeprecationError("sunset_at must be strictly after deprecated_at")
    if successor_link is not None:
        sl = successor_link.strip()
        if sl and not (sl.startswith("http://") or sl.startswith("https://") or sl.startswith("/")):
            raise DeprecationError("successor_link must be an http(s) URL or absolute path")
        successor_link = sl or None
    if reason is not None and len(reason) > 2000:
        raise DeprecationError("reason too long")
    with session() as s:
        existing = s.execute(
            select(ApiDeprecation).where(
                ApiDeprecation.method == m, ApiDeprecation.path_prefix == p
            )
        ).scalar_one_or_none()
        if existing is not None:
            raise DeprecationError(
                f"a deprecation already exists for {m} {p} (id={existing.id})"
            )
        row = ApiDeprecation(
            method=m,
            path_prefix=p,
            deprecated_at=d.replace(tzinfo=None),
            sunset_at=su.replace(tzinfo=None),
            successor_link=successor_link,
            reason=reason,
            created_by=created_by,
        )
        s.add(row)
        s.commit()
        s.refresh(row)
        out = _row_to_out(row)
    invalidate_cache()
    return out


def remove_entry(entry_id: int) -> bool:
    with session() as s:
        row = s.get(ApiDeprecation, entry_id)
        if row is None:
            return False
        s.delete(row)
        # Drop tenant usage rows so the FK-less relation stays clean.
        s.query(DeprecatedRouteUsage).filter(
            DeprecatedRouteUsage.deprecation_id == entry_id
        ).delete()
        s.commit()
    invalidate_cache()
    return True


def lookup_for_request(method: str, path: str) -> DeprecationOut | None:
    """Return the matching entry for a request, or None.

    The longest matching ``path_prefix`` wins so a specific override
    can shadow a router-wide deprecation. Method ``*`` matches any
    verb but loses ties to an exact method match.
    """
    global _cache
    now = _now_monotonic()
    with _cache_lock:
        snapshot = _cache
    if snapshot is None or (now - snapshot[0]) > CACHE_TTL_SECONDS:
        rows = list_entries()
        snap_tuple = tuple(
            (r.id, r.method, r.path_prefix, r.deprecated_at, r.sunset_at, r.successor_link, r.reason)
            for r in rows
        )
        with _cache_lock:
            _cache = (now, snap_tuple)
        items = snap_tuple
    else:
        items = snapshot[1]
    if not items:
        return None
    m_up = (method or "").upper()
    best: tuple | None = None
    best_score = (-1, -1)
    for item in items:
        _id, m, prefix, d_at, su_at, link, reason = item
        if m != "*" and m != m_up:
            continue
        if not path.startswith(prefix):
            continue
        score = (1 if m != "*" else 0, len(prefix))
        if score > best_score:
            best = item
            best_score = score
    if best is None:
        return None
    _id, m, prefix, d_at, su_at, link, reason = best
    return DeprecationOut(
        id=_id, method=m, path_prefix=prefix,
        deprecated_at=d_at, sunset_at=su_at,
        successor_link=link, reason=reason,
        created_by=None, created_at="",
    )


def record_usage(*, tenant_id: str, deprecation_id: int) -> None:
    """Increment the per-tenant usage counter. Best-effort, never raises."""
    try:
        now = datetime.utcnow()
        with session() as s:
            existing = s.execute(
                select(DeprecatedRouteUsage).where(
                    DeprecatedRouteUsage.tenant_id == tenant_id,
                    DeprecatedRouteUsage.deprecation_id == deprecation_id,
                )
            ).scalar_one_or_none()
            if existing is None:
                s.add(DeprecatedRouteUsage(
                    tenant_id=tenant_id,
                    deprecation_id=deprecation_id,
                    hits=1,
                    last_seen_at=now,
                ))
            else:
                existing.hits = int(existing.hits or 0) + 1
                existing.last_seen_at = now
            s.commit()
    except Exception as exc:  # pragma: no cover
        log.warning("api_deprecation usage record failed: %s", exc)


@dataclass(frozen=True)
class UsageOut:
    deprecation_id: int
    method: str
    path_prefix: str
    sunset_at: str
    hits: int
    last_seen_at: str | None


def list_usage_for_tenant(tenant_id: str) -> list[UsageOut]:
    """Per-tenant deprecated-route usage. Strict tenant scoping."""
    with session() as s:
        rows = s.execute(
            select(DeprecatedRouteUsage, ApiDeprecation)
            .join(
                ApiDeprecation,
                ApiDeprecation.id == DeprecatedRouteUsage.deprecation_id,
            )
            .where(DeprecatedRouteUsage.tenant_id == tenant_id)
            .order_by(DeprecatedRouteUsage.last_seen_at.desc())
        ).all()
        out: list[UsageOut] = []
        for usage, dep in rows:
            out.append(UsageOut(
                deprecation_id=int(dep.id),
                method=str(dep.method),
                path_prefix=str(dep.path_prefix),
                sunset_at=to_imf_fixdate(dep.sunset_at),
                hits=int(usage.hits or 0),
                last_seen_at=(usage.last_seen_at.isoformat() + "Z") if usage.last_seen_at else None,
            ))
        return out
