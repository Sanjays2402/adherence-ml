"""Sanity tests for the synthetic generator."""
import pandas as pd

from adherence_data import SyntheticConfig, generate_events


def test_synth_shape_and_columns():
    df = generate_events(SyntheticConfig(n_users=50, n_days=10, seed=3))
    assert len(df) > 100
    for c in ("user_id", "dose_id", "scheduled_at", "status", "dose_class"):
        assert c in df.columns
    assert df["status"].isin({"taken", "missed", "skipped", "late"}).all()


def test_synth_personas_have_distinct_miss_rates():
    df = generate_events(SyntheticConfig(n_users=400, n_days=20, seed=11))
    rate = df.assign(miss=df["status"].isin(["missed", "skipped"]).astype(int)) \
        .groupby("persona")["miss"].mean()
    assert rate.max() - rate.min() > 0.15
    assert rate.loc["well_managed"] < 0.20
    assert rate.loc["antibiotic_dropout"] > 0.25


def test_synth_determinism():
    a = generate_events(SyntheticConfig(n_users=30, n_days=5, seed=99))
    b = generate_events(SyntheticConfig(n_users=30, n_days=5, seed=99))
    pd.testing.assert_frame_equal(a, b)
