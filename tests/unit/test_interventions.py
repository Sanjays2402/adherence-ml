"""Unit tests for the intervention recommender."""
from __future__ import annotations

from adherence_common.interventions import Intervention, recommend, summary


def _pred(dose_id, prob, tier, dose_class="other", reasons=()):
    return {
        "dose_id": dose_id,
        "miss_probability": prob,
        "risk_tier": tier,
        "dose_class": dose_class,
        "reasons": [{"feature": f, "contribution": 0.1, "human": f} for f in reasons],
    }


def test_empty_input_returns_no_actions():
    assert recommend([]) == []
    assert summary([])["n_actions"] == 0


def test_low_risk_doses_yield_nothing():
    out = recommend([_pred("d1", 0.05, "low"), _pred("d2", 0.10, "low")])
    assert out == []


def test_medium_risk_emits_app_push():
    out = recommend([_pred("d1", 0.40, "medium")])
    actions = [iv.action for iv in out]
    assert "push_reminder" in actions
    push = next(iv for iv in out if iv.action == "push_reminder")
    assert push.channel == "app"
    assert push.target_dose_ids == ("d1",)
    assert push.lead_time_minutes == 15


def test_high_risk_uses_longer_lead_time():
    out = recommend([_pred("d1", 0.80, "high")])
    push = next(iv for iv in out if iv.action == "push_reminder")
    assert push.lead_time_minutes == 30
    assert push.score > 0.7


def test_night_signal_adds_sms_fallback():
    out = recommend([_pred("d1", 0.85, "high", reasons=("hour_of_day", "night_dose"))])
    assert any(iv.action == "sms_reminder" for iv in out)


def test_streak_signal_adds_sms_fallback():
    out = recommend([_pred("d1", 0.85, "high", reasons=("missed_streak_7d",))])
    assert any(iv.action == "sms_reminder" for iv in out)


def test_refill_reason_triggers_refill_nudge_with_all_targets():
    preds = [
        _pred("d1", 0.50, "medium", reasons=("days_remaining",)),
        _pred("d2", 0.65, "high", reasons=("refill_gap_days",)),
        _pred("d3", 0.10, "low"),
    ]
    out = recommend(preds, max_actions=10)
    refill = next(iv for iv in out if iv.action == "refill_nudge")
    assert set(refill.target_dose_ids) == {"d1", "d2"}
    assert refill.lead_time_minutes >= 60


def test_three_high_doses_triggers_caregiver_alert():
    preds = [_pred(f"d{i}", 0.8, "high") for i in range(3)]
    out = recommend(preds, max_actions=10)
    assert any(iv.action == "caregiver_alert" for iv in out)


def test_safety_class_high_triggers_caregiver_even_if_single():
    out = recommend([_pred("d1", 0.85, "high", dose_class="cardio")], max_actions=10)
    alert = next(iv for iv in out if iv.action == "caregiver_alert")
    assert "d1" in alert.target_dose_ids


def test_antibiotic_high_triggers_telehealth_followup():
    out = recommend([_pred("d1", 0.9, "high", dose_class="antibiotic")], max_actions=10)
    assert any(iv.action == "telehealth_followup" for iv in out)


def test_refill_plus_safety_class_calls_pharmacist():
    preds = [_pred("d1", 0.9, "high", dose_class="cardio", reasons=("refill_gap",))]
    out = recommend(preds, max_actions=10)
    assert any(iv.action == "pharmacist_call" for iv in out)


def test_psych_high_emits_education_card():
    preds = [_pred("d1", 0.75, "high", dose_class="psych")]
    out = recommend(preds, max_actions=10)
    assert any(iv.action == "education_card" for iv in out)


def test_schedule_review_on_chronic_late_signal():
    preds = [
        _pred("d1", 0.55, "medium", reasons=("hours_late_mean",)),
        _pred("d2", 0.65, "high", reasons=("minutes_late_p75",)),
        _pred("d3", 0.62, "high", reasons=("delay_count_7d",)),
    ]
    out = recommend(preds, max_actions=10)
    assert any(iv.action == "schedule_review" for iv in out)


def test_results_are_capped_and_sorted_descending():
    preds = [_pred(f"d{i}", 0.9, "high", dose_class="cardio",
                   reasons=("refill_gap", "night", "missed_streak")) for i in range(5)]
    out = recommend(preds, max_actions=3)
    assert len(out) == 3
    scores = [iv.score for iv in out]
    assert scores == sorted(scores, reverse=True)


def test_recommender_is_deterministic():
    preds = [_pred("d1", 0.7, "high", dose_class="cardio", reasons=("refill_gap",))]
    a = recommend(preds, max_actions=10)
    b = recommend(preds, max_actions=10)
    assert [iv.to_dict() for iv in a] == [iv.to_dict() for iv in b]


def test_intervention_to_dict_round_trip():
    iv = Intervention(
        action="push_reminder", score=0.8, target_dose_ids=("d1",),
        reason="x", channel="app", lead_time_minutes=15,
    )
    d = iv.to_dict()
    assert d["action"] == "push_reminder"
    assert d["target_dose_ids"] == ["d1"]
    assert d["score"] == 0.8


def test_summary_aggregates_counts():
    preds = [_pred(f"d{i}", 0.9, "high", dose_class="cardio") for i in range(3)]
    out = recommend(preds, max_actions=10)
    s = summary(out)
    assert s["n_actions"] == len(out)
    assert s["top_score"] == max(iv.score for iv in out)
    assert sum(s["by_action"].values()) == len(out)
