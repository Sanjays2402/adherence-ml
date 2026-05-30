"""Intervention recommender.

Given a list of dose predictions (with risk_tier and reason codes), produce
a ranked list of suggested actions for the care team / app to take. The
recommender combines:

- Risk tier (high doses get more aggressive nudges).
- Reason-code features (late history, weekend pattern, refill gap, etc.)
  map to specific intervention types.
- Dose class (antibiotic missed dose is more time-critical than a
  supplement; cardio/psych get caregiver loops on repeated high-risk).
- Schedule density (multiple high-risk doses same day flips to a
  daily-plan intervention instead of per-dose pings).

Output is deterministic, scored 0..1, and small (<=5 actions per
recommendation set) so the API consumer can act on it directly.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal

ActionType = Literal[
    "push_reminder",
    "sms_reminder",
    "refill_nudge",
    "caregiver_alert",
    "schedule_review",
    "education_card",
    "telehealth_followup",
    "pharmacist_call",
]


@dataclass(frozen=True)
class Intervention:
    action: ActionType
    score: float
    target_dose_ids: tuple[str, ...]
    reason: str
    channel: Literal["app", "sms", "phone", "email"]
    lead_time_minutes: int  # how many minutes before scheduled_at to fire

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "score": round(self.score, 4),
            "target_dose_ids": list(self.target_dose_ids),
            "reason": self.reason,
            "channel": self.channel,
            "lead_time_minutes": self.lead_time_minutes,
        }


@dataclass
class _DoseView:
    dose_id: str
    miss_probability: float
    risk_tier: str
    dose_class: str
    reason_features: set[str] = field(default_factory=set)


def _coerce_dose(p: dict[str, Any]) -> _DoseView:
    reasons = p.get("reasons") or []
    feats = {str(r.get("feature", "")) for r in reasons if r.get("feature")}
    return _DoseView(
        dose_id=str(p.get("dose_id", "")),
        miss_probability=float(p.get("miss_probability", 0.0)),
        risk_tier=str(p.get("risk_tier", "low")),
        dose_class=str(p.get("dose_class", "other")),
        reason_features=feats,
    )


def _has_any(features: set[str], substrings: Iterable[str]) -> bool:
    return any(any(sub in f for f in features) for sub in substrings)


_REFILL_HINTS = ("refill", "supply", "days_remaining", "out_of_stock")
_LATE_HINTS = ("late", "delay", "minutes_late", "hours_late")
_WEEKEND_HINTS = ("weekend", "saturday", "sunday", "day_of_week")
_NIGHT_HINTS = ("night", "evening", "hour_of_day", "time_bucket")
_STREAK_HINTS = ("missed_streak", "consec", "missed_last", "miss_rate")
_TRAVEL_HINTS = ("timezone", "tz_change", "location")


def recommend(
    predictions: list[dict[str, Any]],
    *,
    max_actions: int = 5,
    caregiver_threshold_high_doses: int = 3,
) -> list[Intervention]:
    """Return up to `max_actions` interventions, sorted by score desc.

    `predictions` is the list from PredictResponse.predictions
    (i.e. each item has dose_id, miss_probability, risk_tier, reasons[]).
    """
    if not predictions:
        return []

    doses = [_coerce_dose(p) for p in predictions]
    high = [d for d in doses if d.risk_tier == "high"]
    medium = [d for d in doses if d.risk_tier == "medium"]
    out: list[Intervention] = []

    # 1. Per-dose reminders for any medium+ risk dose.
    for d in high + medium:
        base = 0.55 if d.risk_tier == "medium" else 0.75
        score = min(0.99, base + 0.20 * d.miss_probability)
        out.append(Intervention(
            action="push_reminder",
            score=score,
            target_dose_ids=(d.dose_id,),
            reason=f"{d.risk_tier} risk dose (p={d.miss_probability:.2f})",
            channel="app",
            lead_time_minutes=30 if d.risk_tier == "high" else 15,
        ))

    # 2. SMS fallback for high-risk doses where the reason hints at
    # ignored app notifications (night-time or chronic missed streak).
    for d in high:
        if _has_any(d.reason_features, _NIGHT_HINTS + _STREAK_HINTS):
            out.append(Intervention(
                action="sms_reminder",
                score=min(0.95, 0.70 + 0.25 * d.miss_probability),
                target_dose_ids=(d.dose_id,),
                reason="high risk dose with night/streak signal (app push may be ignored)",
                channel="sms",
                lead_time_minutes=20,
            ))

    # 3. Refill nudge if any dose's reasons mention supply.
    refill_targets = tuple(d.dose_id for d in doses if _has_any(d.reason_features, _REFILL_HINTS))
    if refill_targets:
        out.append(Intervention(
            action="refill_nudge",
            score=0.85,
            target_dose_ids=refill_targets,
            reason="model attributes risk to low supply / refill gap",
            channel="app",
            lead_time_minutes=240,  # fire 4h ahead so user can act
        ))

    # 4. Caregiver alert when 3+ high-risk doses in this batch, or when
    # safety-critical classes (cardio/psych/antibiotic) hit high risk.
    safety_classes = {"cardio", "psych", "antibiotic"}
    safety_high = [d for d in high if d.dose_class in safety_classes]
    if len(high) >= caregiver_threshold_high_doses or safety_high:
        targets = tuple((d.dose_id for d in (safety_high or high)))
        score = 0.80 + min(0.15, 0.03 * len(high))
        out.append(Intervention(
            action="caregiver_alert",
            score=round(score, 4),
            target_dose_ids=targets,
            reason=(
                f"{len(high)} high-risk doses (safety class: {len(safety_high)})"
            ),
            channel="phone",
            lead_time_minutes=60,
        ))

    # 5. Schedule review if late-history reason fires across many doses,
    # or weekend pattern dominates.
    late_count = sum(1 for d in doses if _has_any(d.reason_features, _LATE_HINTS))
    weekend_count = sum(1 for d in doses if _has_any(d.reason_features, _WEEKEND_HINTS))
    travel_count = sum(1 for d in doses if _has_any(d.reason_features, _TRAVEL_HINTS))
    if late_count >= max(2, len(doses) // 3) or weekend_count >= 2 or travel_count >= 1:
        causes = []
        if late_count:
            causes.append(f"chronic late ({late_count})")
        if weekend_count:
            causes.append(f"weekend pattern ({weekend_count})")
        if travel_count:
            causes.append("timezone change")
        out.append(Intervention(
            action="schedule_review",
            score=0.65,
            target_dose_ids=tuple(d.dose_id for d in doses),
            reason="; ".join(causes) or "schedule pattern",
            channel="app",
            lead_time_minutes=1440,
        ))

    # 6. Antibiotic-specific telehealth follow-up: missing antibiotic doses
    # is clinically serious; nudge a telehealth check when high-risk.
    abx_high = [d for d in high if d.dose_class == "antibiotic"]
    if abx_high:
        out.append(Intervention(
            action="telehealth_followup",
            score=0.78,
            target_dose_ids=tuple(d.dose_id for d in abx_high),
            reason="high-risk antibiotic dose (course completion matters)",
            channel="phone",
            lead_time_minutes=720,
        ))

    # 7. Pharmacist call when refill + safety class combine.
    if refill_targets and safety_high:
        out.append(Intervention(
            action="pharmacist_call",
            score=0.82,
            target_dose_ids=refill_targets,
            reason="refill gap on safety-class medication",
            channel="phone",
            lead_time_minutes=360,
        ))

    # 8. Education card for psych class on first-pass high risk (gentle).
    psych_high = [d for d in high if d.dose_class == "psych"]
    if psych_high and not any(o.action == "education_card" for o in out):
        out.append(Intervention(
            action="education_card",
            score=0.45,
            target_dose_ids=tuple(d.dose_id for d in psych_high),
            reason="psychiatric medication adherence education",
            channel="app",
            lead_time_minutes=120,
        ))

    # Dedupe (action, target_dose_ids) keeping max score, then top-N.
    best: dict[tuple, Intervention] = {}
    for iv in out:
        key = (iv.action, iv.target_dose_ids)
        cur = best.get(key)
        if cur is None or iv.score > cur.score:
            best[key] = iv
    ranked = sorted(best.values(), key=lambda x: (-x.score, x.action))
    return ranked[:max_actions]


def summary(interventions: list[Intervention]) -> dict[str, Any]:
    counts = Counter(iv.action for iv in interventions)
    return {
        "n_actions": len(interventions),
        "by_action": dict(counts),
        "top_score": max((iv.score for iv in interventions), default=0.0),
    }
