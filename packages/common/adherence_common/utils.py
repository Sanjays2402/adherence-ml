"""Small pure utilities."""
from __future__ import annotations

import hashlib
from datetime import datetime
from typing import Iterable


def time_bucket(dt: datetime) -> str:
    h = dt.hour
    if h < 6:
        return "early_morning"
    if h < 10:
        return "morning"
    if h < 13:
        return "midday"
    if h < 17:
        return "afternoon"
    if h < 21:
        return "evening"
    return "night"


def stable_hash(*parts: str | int) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(str(p).encode())
        h.update(b"|")
    return h.hexdigest()[:16]


def chunked(seq: Iterable, size: int) -> Iterable[list]:
    buf: list = []
    for x in seq:
        buf.append(x)
        if len(buf) >= size:
            yield buf
            buf = []
    if buf:
        yield buf
