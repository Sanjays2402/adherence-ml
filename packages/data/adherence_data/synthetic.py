"""Realistic synthetic adherence event generator.

We model heterogeneous user personas with distinct miss patterns, then sample
dose events on a daily schedule for n_days. Output is a tidy DataFrame matching
the DoseEvent schema.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Iterable

import numpy as np
import pandas as pd

from adherence_common.constants import DOSE_CLASSES
from adherence_common.utils import time_bucket

PERSONAS = (
    "morning_person",       # crushes early doses, slips after 8pm
    "evening_forgetter",    # great mornings, fades after dinner
    "weekend_skipper",      # weekday adherent, Sat/Sun chaotic
    "night_shift_worker",   # inverted clock
    "polypharmacy_chaotic", # many meds, generally weaker adherence
    "well_managed",         # high adherence across the board
    "antibiotic_dropout",   # adherent at first then drops mid-course
)


@dataclass
class SyntheticConfig:
    n_users: int = 5000
    n_days: int = 60
    seed: int = 42
    start: datetime = field(
        default_factory=lambda: datetime(2026, 1, 1, tzinfo=timezone.utc)
    )
    persona_weights: dict[str, float] = field(
        default_factory=lambda: {
            "morning_person": 0.20,
            "evening_forgetter": 0.22,
            "weekend_skipper": 0.15,
            "night_shift_worker": 0.07,
            "polypharmacy_chaotic": 0.13,
            "well_managed": 0.18,
            "antibiotic_dropout": 0.05,
        }
    )


def _persona_miss_prob(persona: str, hour: int, dow: int, day_index: int) -> float:
    """Hand-tuned probability that this dose is missed."""
    base = 0.10
    if persona == "morning_person":
        if hour < 10:
            base = 0.03
        elif hour >= 20:
            base = 0.28
    elif persona == "evening_forgetter":
        if hour < 12:
            base = 0.04
        elif hour >= 19:
            base = 0.42
    elif persona == "weekend_skipper":
        base = 0.07 if dow < 5 else 0.45
    elif persona == "night_shift_worker":
        base = 0.06 if (hour >= 20 or hour < 6) else 0.32
    elif persona == "polypharmacy_chaotic":
        base = 0.25 + 0.05 * np.sin(day_index / 6.0)
    elif persona == "well_managed":
        base = 0.04
    elif persona == "antibiotic_dropout":
        if day_index < 4:
            base = 0.06
        elif day_index < 8:
            base = 0.22
        else:
            base = 0.55
    # Friday-night/weekend evening lift everyone
    if dow >= 4 and hour >= 19:
        base += 0.06
    return float(np.clip(base, 0.01, 0.95))


def _assign_personas(n: int, weights: dict[str, float], rng: np.random.Generator) -> np.ndarray:
    keys = list(weights.keys())
    p = np.array([weights[k] for k in keys], dtype=float)
    p = p / p.sum()
    return rng.choice(keys, size=n, p=p)


def _user_schedule(persona: str, rng: np.random.Generator) -> list[tuple[int, int, str, float]]:
    """Return list of (hour, minute, dose_class, strength_mg) per day."""
    n = int(rng.integers(1, 6))
    if persona == "polypharmacy_chaotic":
        n = int(rng.integers(4, 8))
    elif persona == "well_managed":
        n = int(rng.integers(1, 4))

    candidates = [
        (7, 30, "cardio", 25.0),
        (8, 0, "endocrine", 500.0),
        (9, 0, "supplement", 1000.0),
        (12, 30, "antibiotic", 250.0),
        (13, 0, "psych", 20.0),
        (17, 0, "neuro", 100.0),
        (20, 0, "cardio", 50.0),
        (21, 30, "psych", 10.0),
        (22, 0, "other", 5.0),
    ]
    idx = rng.choice(len(candidates), size=min(n, len(candidates)), replace=False)
    return [candidates[i] for i in sorted(idx)]


def generate_events(cfg: SyntheticConfig | None = None) -> pd.DataFrame:
    cfg = cfg or SyntheticConfig()
    rng = np.random.default_rng(cfg.seed)
    personas = _assign_personas(cfg.n_users, cfg.persona_weights, rng)

    rows: list[dict] = []
    for uid in range(cfg.n_users):
        persona = personas[uid]
        schedule = _user_schedule(persona, rng)
        user_id = f"u_{uid:06d}"
        for d in range(cfg.n_days):
            day = cfg.start + timedelta(days=d)
            dow = day.weekday()
            for (h, m, klass, mg) in schedule:
                sched = day.replace(hour=h, minute=m, second=0, microsecond=0)
                p_miss = _persona_miss_prob(persona, h, dow, d)
                missed = rng.random() < p_miss
                if missed:
                    status = "missed" if rng.random() < 0.75 else "skipped"
                    taken_at = None
                else:
                    # taken within window, sometimes late
                    jitter_min = float(rng.normal(0, 25))
                    taken_at = sched + timedelta(minutes=jitter_min)
                    status = "late" if abs(jitter_min) > 45 else "taken"
                rows.append(
                    dict(
                        user_id=user_id,
                        dose_id=f"{user_id}_{d}_{h:02d}{m:02d}_{klass}",
                        scheduled_at=sched,
                        taken_at=taken_at,
                        status=status,
                        dose_class=klass,
                        dose_strength_mg=mg,
                        persona=persona,
                        time_bucket=time_bucket(sched),
                        dow=dow,
                    )
                )
    df = pd.DataFrame(rows)
    df["scheduled_at"] = pd.to_datetime(df["scheduled_at"], utc=True)
    df["taken_at"] = pd.to_datetime(df["taken_at"], utc=True)
    return df


def stream_events(cfg: SyntheticConfig, chunk_users: int = 500) -> Iterable[pd.DataFrame]:
    """Memory-friendlier generator yielding per-user-batch DataFrames."""
    full_n = cfg.n_users
    for start in range(0, full_n, chunk_users):
        sub = SyntheticConfig(
            n_users=min(chunk_users, full_n - start),
            n_days=cfg.n_days,
            seed=cfg.seed + start,
            start=cfg.start,
            persona_weights=cfg.persona_weights,
        )
        df = generate_events(sub)
        df["user_id"] = df["user_id"].astype(str) + f"_b{start}"
        yield df
