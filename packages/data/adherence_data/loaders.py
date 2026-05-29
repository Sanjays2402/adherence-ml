"""CSV / Parquet I/O for dose events."""
from __future__ import annotations

from pathlib import Path

import pandas as pd


EVENT_COLUMNS = [
    "user_id",
    "dose_id",
    "scheduled_at",
    "taken_at",
    "status",
    "dose_class",
    "dose_strength_mg",
]


def _coerce(df: pd.DataFrame) -> pd.DataFrame:
    for col in ("scheduled_at", "taken_at"):
        if col in df.columns:
            df[col] = pd.to_datetime(df[col], utc=True, errors="coerce")
    return df


def load_events_csv(path: str | Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    return _coerce(df)


def load_events_parquet(path: str | Path) -> pd.DataFrame:
    df = pd.read_parquet(path)
    return _coerce(df)


def save_events(df: pd.DataFrame, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix == ".csv":
        df.to_csv(path, index=False)
    else:
        df.to_parquet(path, index=False)
    return path
