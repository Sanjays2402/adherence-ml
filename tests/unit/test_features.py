"""Feature engineering correctness tests."""
import numpy as np
import pandas as pd

from adherence_features.engineering import FEATURE_COLUMNS, build_training_frame, featurize_schedule


def test_features_columns_present(tiny_features):
    for c in FEATURE_COLUMNS:
        assert c in tiny_features.columns
    assert "label" in tiny_features.columns


def test_no_leakage_first_row_has_zero_history(tiny_events):
    feats = build_training_frame(tiny_events.head(200))
    first = feats.groupby("user_id").head(1)
    assert (first["streak_taken"] == 0).all()
    assert (first["streak_missed"] == 0).all()
    assert (first["user_n_doses_history"] == 0).all()


def test_recent_miss_rate_bounded(tiny_features):
    for c in ("recent_miss_rate_7d", "recent_miss_rate_24h", "recent_late_rate_7d"):
        s = tiny_features[c].dropna()
        assert (s >= 0).all() and (s <= 1).all()


def test_featurize_schedule_aligned():
    from datetime import datetime, timezone, timedelta
    hist = pd.DataFrame()
    now = datetime(2026, 1, 5, 8, 0, tzinfo=timezone.utc)
    sched = [
        {"dose_id": "d1", "scheduled_at": now, "dose_class": "cardio", "dose_strength_mg": 10.0},
        {"dose_id": "d2", "scheduled_at": now + timedelta(hours=6), "dose_class": "psych", "dose_strength_mg": 5.0},
    ]
    out = featurize_schedule("u_test", hist, sched)
    assert len(out) == 2
    assert out.loc[0, "dose_id"] == "d1"
    assert out.loc[1, "dose_id"] == "d2"
