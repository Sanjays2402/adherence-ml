"""Feature engineering for dose-miss prediction.

We produce a one row per (user, scheduled dose) frame where the target is
whether the dose was missed/skipped. Features are causally derived only from
events strictly before scheduled_at to avoid leakage.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Iterable

import numpy as np
import pandas as pd

from adherence_common.constants import DOSE_CLASSES, TIME_BUCKETS
from adherence_common.utils import time_bucket


FEATURE_COLUMNS: list[str] = [
    "hour_sin",
    "hour_cos",
    "dow_sin",
    "dow_cos",
    "is_weekend",
    "time_bucket_idx",
    "dose_class_idx",
    "dose_strength_mg",
    "streak_taken",
    "streak_missed",
    "recent_miss_rate_7d",
    "recent_miss_rate_24h",
    "recent_late_rate_7d",
    "doses_today_so_far",
    "doses_yesterday",
    "minutes_since_last_dose",
    "minutes_since_last_taken",
    "sleep_window_proxy",
    "n_classes_user",
    "user_n_doses_history",
]


def _bucket_idx(s: pd.Series) -> pd.Series:
    return s.map({b: i for i, b in enumerate(TIME_BUCKETS)}).fillna(0).astype(int)


def _class_idx(s: pd.Series) -> pd.Series:
    m = {c: i for i, c in enumerate(DOSE_CLASSES)}
    return s.map(m).fillna(m["other"]).astype(int)


def _circular(values: np.ndarray, period: float) -> tuple[np.ndarray, np.ndarray]:
    theta = 2.0 * np.pi * values / period
    return np.sin(theta), np.cos(theta)


def _label_from_status(status: pd.Series) -> pd.Series:
    return status.isin(["missed", "skipped"]).astype(int)


def _per_user_features(events: pd.DataFrame) -> pd.DataFrame:
    """For one user's events (sorted by scheduled_at), build causal features.

    `events` must contain status, scheduled_at, taken_at, dose_class, dose_strength_mg.
    """
    events = events.sort_values("scheduled_at").reset_index(drop=True)
    sched = events["scheduled_at"]
    status = events["status"].astype(str)
    label = _label_from_status(status)

    # Streaks (strictly past)
    prev_label = label.shift(1).fillna(0).to_numpy()
    streak_taken = np.zeros(len(events), dtype=int)
    streak_missed = np.zeros(len(events), dtype=int)
    t, m = 0, 0
    for i in range(len(events)):
        streak_taken[i] = t
        streak_missed[i] = m
        if prev_label[i] == 0:
            t += 1
            m = 0
        else:
            m += 1
            t = 0

    # Recent miss rate windows: count events in (sched - W, sched)
    s_ts = sched.values.astype("datetime64[s]").astype(np.int64)
    miss_arr = label.to_numpy()
    late_arr = (status == "late").astype(int).to_numpy()

    def _window_rate(window_seconds: int, arr: np.ndarray) -> np.ndarray:
        out = np.zeros(len(events), dtype=float)
        j = 0
        for i in range(len(events)):
            cutoff = s_ts[i] - window_seconds
            while j < i and s_ts[j] < cutoff:
                j += 1
            denom = max(i - j, 1)
            out[i] = float(arr[j:i].sum()) / denom
        return out

    miss_7d = _window_rate(7 * 86400, miss_arr)
    miss_24h = _window_rate(86400, miss_arr)
    late_7d = _window_rate(7 * 86400, late_arr)

    # Doses today so far / yesterday
    day = sched.dt.floor("D")
    doses_today = day.groupby(day).cumcount().to_numpy()
    by_day_count = day.value_counts().sort_index()
    prev_day_lookup = {d: int(by_day_count.get(d - pd.Timedelta(days=1), 0)) for d in by_day_count.index}
    doses_yesterday = day.map(prev_day_lookup).fillna(0).astype(int).to_numpy()

    # Minutes since last (any) dose / last taken
    taken_at = pd.to_datetime(events["taken_at"], utc=True, errors="coerce")
    prev_sched = sched.shift(1)
    minutes_since_last = (sched - prev_sched).dt.total_seconds().fillna(7 * 86400) / 60.0

    # last taken: forward-fill taken_at among previous taken rows
    taken_only = taken_at.where(status == "taken")
    last_taken = taken_only.shift(1).ffill()
    minutes_since_last_taken = (sched - last_taken).dt.total_seconds().fillna(7 * 86400) / 60.0

    sleep_proxy = ((sched.dt.hour >= 23) | (sched.dt.hour < 6)).astype(int)
    n_classes_user = events["dose_class"].nunique()
    user_n_doses_history = np.arange(len(events))

    hour = sched.dt.hour.to_numpy().astype(float)
    dow = sched.dt.dayofweek.to_numpy().astype(float)
    h_sin, h_cos = _circular(hour, 24.0)
    d_sin, d_cos = _circular(dow, 7.0)
    is_weekend = (dow >= 5).astype(int)
    tb_idx = _bucket_idx(sched.dt.hour.map(lambda h: time_bucket(datetime(2026, 1, 1, int(h))))).to_numpy()
    cls_idx = _class_idx(events["dose_class"]).to_numpy()

    out = pd.DataFrame({
        "user_id": events["user_id"].values,
        "dose_id": events["dose_id"].values,
        "scheduled_at": sched.values,
        "hour_sin": h_sin,
        "hour_cos": h_cos,
        "dow_sin": d_sin,
        "dow_cos": d_cos,
        "is_weekend": is_weekend,
        "time_bucket_idx": tb_idx,
        "dose_class_idx": cls_idx,
        "dose_strength_mg": events["dose_strength_mg"].astype(float).to_numpy(),
        "streak_taken": streak_taken,
        "streak_missed": streak_missed,
        "recent_miss_rate_7d": miss_7d,
        "recent_miss_rate_24h": miss_24h,
        "recent_late_rate_7d": late_7d,
        "doses_today_so_far": doses_today,
        "doses_yesterday": doses_yesterday,
        "minutes_since_last_dose": minutes_since_last.to_numpy(),
        "minutes_since_last_taken": minutes_since_last_taken.to_numpy(),
        "sleep_window_proxy": sleep_proxy.to_numpy(),
        "n_classes_user": np.full(len(events), n_classes_user, dtype=int),
        "user_n_doses_history": user_n_doses_history,
        "label": label.to_numpy(),
    })
    return out


def build_training_frame(events: pd.DataFrame) -> pd.DataFrame:
    """Vectorized feature build across all users."""
    if events.empty:
        return pd.DataFrame(columns=["user_id", "dose_id", "scheduled_at", *FEATURE_COLUMNS, "label"])
    parts = [
        _per_user_features(g) for _, g in events.groupby("user_id", sort=False)
    ]
    df = pd.concat(parts, ignore_index=True)
    return df


def featurize_history(events: pd.DataFrame) -> pd.DataFrame:
    """Build full feature frame (with label) from past events. Alias."""
    return build_training_frame(events)


def featurize_schedule(
    user_id: str,
    history: pd.DataFrame,
    schedule: Iterable[dict],
) -> pd.DataFrame:
    """Produce feature rows for upcoming scheduled doses given user history.

    history: DataFrame of past DoseEvents for this user (any user_id ok).
    schedule: iterable of dicts with dose_id, scheduled_at, dose_class, dose_strength_mg.
    Returns: feature rows aligned with schedule, in input order. No label column.
    """
    hist = history.copy()
    if not hist.empty:
        hist = hist[hist["user_id"] == user_id].copy()
    fake_rows = []
    for s in schedule:
        fake_rows.append({
            "user_id": user_id,
            "dose_id": s["dose_id"],
            "scheduled_at": pd.to_datetime(s["scheduled_at"], utc=True),
            "taken_at": pd.NaT,
            "status": "pending",
            "dose_class": s.get("dose_class", "other"),
            "dose_strength_mg": float(s.get("dose_strength_mg", 0.0)),
        })
    fake = pd.DataFrame(fake_rows)
    combined = pd.concat([hist, fake], ignore_index=True, sort=False)
    feats = _per_user_features(combined)
    # take last len(fake) rows (these correspond to the schedule)
    out = feats.tail(len(fake)).reset_index(drop=True)
    # drop label (it's all 0 from "pending")
    return out.drop(columns=["label"], errors="ignore")
