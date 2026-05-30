"""Quiet-hours (do-not-disturb) policies for intervention delivery.

Each user can have one ``QuietHoursPolicy`` row that defines a daily
window in their local timezone where most channels are suppressed. Calls
to :func:`apply` take a list of intervention dicts and:

  * drop interventions whose channel is *not* in ``allowed_channels`` if
    the scheduled fire time falls inside the quiet window;
  * for everything else, defer the fire time to the next end_hour edge
    and surface a ``deferred_until`` field on the intervention.

The "scheduled fire time" is derived from each intervention's
``lead_time_minutes`` and the earliest ``scheduled_at`` of its target
doses (passed in as ``dose_times``). If we cannot compute it (e.g.
missing dose_times) we leave the intervention alone.

Pure-Python, stdlib zoneinfo only. No DB calls (the caller loads the
policy once and hands it in).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from typing import Any, Iterable

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - py<3.9
    ZoneInfo = None  # type: ignore


@dataclass(frozen=True)
class QuietHours:
    user_id: str
    tz: str
    start_hour: int
    end_hour: int
    allowed_channels: tuple[str, ...] = ()

    def __post_init__(self):
        if not (0 <= self.start_hour <= 23):
            raise ValueError("start_hour must be 0..23")
        if not (0 <= self.end_hour <= 23):
            raise ValueError("end_hour must be 0..23")
        if self.start_hour == self.end_hour:
            raise ValueError("start_hour must differ from end_hour")

    def _tzinfo(self):
        if ZoneInfo is None:
            return timezone.utc
        try:
            return ZoneInfo(self.tz)
        except Exception:
            return timezone.utc

    def contains(self, when: datetime) -> bool:
        """True if `when` (UTC or aware) falls inside the quiet window."""
        local = when.astimezone(self._tzinfo()) if when.tzinfo else when.replace(tzinfo=timezone.utc).astimezone(self._tzinfo())
        h = local.hour + local.minute / 60.0
        if self.start_hour < self.end_hour:
            return self.start_hour <= h < self.end_hour
        # wrap midnight
        return h >= self.start_hour or h < self.end_hour

    def next_end(self, when: datetime) -> datetime:
        """Return the next UTC datetime at which the window ends."""
        tz = self._tzinfo()
        local = when.astimezone(tz) if when.tzinfo else when.replace(tzinfo=timezone.utc).astimezone(tz)
        candidate = local.replace(hour=self.end_hour, minute=0, second=0, microsecond=0)
        if candidate <= local:
            candidate = candidate + timedelta(days=1)
        return candidate.astimezone(timezone.utc)


def _parse_dt(s: Any) -> datetime | None:
    if isinstance(s, datetime):
        return s if s.tzinfo else s.replace(tzinfo=timezone.utc)
    if not isinstance(s, str):
        return None
    try:
        # accept ...Z
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def apply(
    interventions: list[dict[str, Any]],
    policy: QuietHours | None,
    *,
    dose_times: dict[str, str] | None = None,
    now: datetime | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Filter / defer interventions per the policy.

    Returns (new_interventions, info). ``info`` is a small dict suitable
    for inclusion in API responses describing what changed.
    """
    if policy is None:
        return interventions, {"applied": False, "reason": "no quiet-hours policy"}

    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    dose_times = dose_times or {}
    allowed = set(policy.allowed_channels)

    kept: list[dict[str, Any]] = []
    n_deferred = 0
    n_suppressed = 0

    for iv in interventions:
        target_ids = iv.get("target_dose_ids") or []
        # earliest scheduled time among targets
        sched_times = [
            _parse_dt(dose_times.get(d)) for d in target_ids
        ]
        sched_times = [t for t in sched_times if t is not None]
        if not sched_times:
            # cannot compute fire time -> pass through unchanged
            kept.append(iv)
            continue
        earliest = min(sched_times)
        lead = int(iv.get("lead_time_minutes", 0) or 0)
        fire_at = earliest - timedelta(minutes=lead)
        # if fire time has already passed (relative to now), bump to now
        if fire_at < now:
            fire_at = now
        if not policy.contains(fire_at):
            kept.append(iv)
            continue
        channel = str(iv.get("channel", ""))
        if channel in allowed:
            kept.append(iv)
            continue
        # defer to end-of-window unless that pushes us past the scheduled
        # dose itself (then suppress).
        deferred_to = policy.next_end(fire_at)
        if deferred_to >= earliest:
            n_suppressed += 1
            continue
        new = dict(iv)
        new["deferred_until"] = deferred_to.isoformat()
        new["deferred_reason"] = (
            f"quiet hours {policy.start_hour:02d}-{policy.end_hour:02d} {policy.tz}"
        )
        kept.append(new)
        n_deferred += 1

    info = {
        "applied": True,
        "tz": policy.tz,
        "start_hour": policy.start_hour,
        "end_hour": policy.end_hour,
        "allowed_channels": sorted(allowed),
        "n_deferred": n_deferred,
        "n_suppressed": n_suppressed,
    }
    return kept, info


def from_row(row) -> QuietHours:
    """Build a QuietHours dataclass from a SQLAlchemy QuietHoursPolicy row."""
    chans = (row.allowed_channels_csv or "").strip()
    allowed = tuple(c.strip() for c in chans.split(",") if c.strip()) if chans else ()
    return QuietHours(
        user_id=row.user_id, tz=row.tz or "UTC",
        start_hour=int(row.start_hour), end_hour=int(row.end_hour),
        allowed_channels=allowed,
    )
