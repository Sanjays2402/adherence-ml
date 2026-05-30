"""A/B experiment assignment, exposure logging, and results analysis.

Designed for evaluating intervention variants (e.g. ``sms_short`` vs
``sms_long`` vs ``email``) but generic: any caller can define an
experiment, assign users, log conversions, and pull aggregate results
with a 95% Wilson confidence interval on the conversion rate and a
two-proportion z-test for lift vs the control variant.

Assignment is **deterministic** per user: ``sha256(salt + user_id)``
mapped onto the cumulative variant weight range. This means

  * the same user always lands in the same bucket without any state
    lookup, and
  * the salt makes a re-run of the same user across two different
    experiments effectively independent.

Exposures are deduplicated per (experiment_key, user_id) so multiple
calls to :func:`assign` only insert once.
"""
from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from adherence_common.db import (
    Experiment,
    ExperimentEvent,
    ExperimentExposure,
    init_db,
    session,
)
from adherence_common.logging import get_logger

log = get_logger(__name__)

VALID_STATES = {"draft", "running", "paused", "stopped"}


class ExperimentError(ValueError):
    """Validation / state errors raised by this module."""


@dataclass
class Variant:
    name: str
    weight: int

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "weight": self.weight}


def _validate_variants(raw: list[dict[str, Any]]) -> list[Variant]:
    if not raw or len(raw) < 2:
        raise ExperimentError("experiment requires at least 2 variants")
    seen: set[str] = set()
    out: list[Variant] = []
    for v in raw:
        name = str(v.get("name", "")).strip()
        weight = int(v.get("weight", 0))
        if not name:
            raise ExperimentError("variant.name is required")
        if name in seen:
            raise ExperimentError(f"duplicate variant name: {name}")
        seen.add(name)
        if weight <= 0:
            raise ExperimentError(f"variant.weight must be > 0 (got {weight} for {name})")
        out.append(Variant(name=name, weight=weight))
    return out


def create_experiment(
    *,
    key: str,
    variants: list[dict[str, Any]],
    description: str | None = None,
    salt: str | None = None,
    state: str = "running",
    created_by: str | None = None,
) -> Experiment:
    if not key or not key.replace("_", "").replace("-", "").isalnum():
        raise ExperimentError("key must be alphanumeric/underscore/dash, non-empty")
    if state not in VALID_STATES:
        raise ExperimentError(f"state must be one of {sorted(VALID_STATES)}")
    parsed = _validate_variants(variants)
    init_db()
    salt = salt or key
    now = datetime.utcnow()
    with session() as s:
        existing = s.execute(
            select(Experiment).where(Experiment.key == key)
        ).scalar_one_or_none()
        if existing is not None:
            raise ExperimentError(f"experiment {key!r} already exists")
        row = Experiment(
            key=key,
            description=description,
            variants_json=[v.to_dict() for v in parsed],
            salt=salt,
            state=state,
            created_by=created_by,
            created_at=now,
            updated_at=now,
        )
        s.add(row)
        s.commit()
        s.refresh(row)
        return row


def get_experiment(key: str) -> Experiment | None:
    init_db()
    with session() as s:
        return s.execute(
            select(Experiment).where(Experiment.key == key)
        ).scalar_one_or_none()


def list_experiments() -> list[Experiment]:
    init_db()
    with session() as s:
        return list(s.execute(select(Experiment).order_by(Experiment.created_at.desc())).scalars())


def set_state(key: str, state: str) -> Experiment:
    if state not in VALID_STATES:
        raise ExperimentError(f"state must be one of {sorted(VALID_STATES)}")
    init_db()
    with session() as s:
        row = s.execute(select(Experiment).where(Experiment.key == key)).scalar_one_or_none()
        if row is None:
            raise ExperimentError(f"experiment {key!r} not found")
        row.state = state
        row.updated_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return row


def _assign_variant(salt: str, user_id: str, variants: list[dict[str, Any]]) -> str:
    """Deterministic per-user variant pick weighted by ``weight``."""
    total = sum(int(v["weight"]) for v in variants)
    if total <= 0:
        raise ExperimentError("variant weights sum to zero")
    digest = hashlib.sha256(f"{salt}:{user_id}".encode("utf-8")).digest()
    # Use the first 8 bytes as an unsigned int and mod the total weight.
    bucket = int.from_bytes(digest[:8], "big") % total
    acc = 0
    for v in variants:
        acc += int(v["weight"])
        if bucket < acc:
            return str(v["name"])
    # Numerically unreachable, but guard anyway.
    return str(variants[-1]["name"])


def assign(
    key: str,
    user_id: str,
    *,
    context: dict[str, Any] | None = None,
    record: bool = True,
) -> dict[str, Any]:
    """Return ``{variant, state, recorded}`` for a user.

    A paused/stopped experiment short-circuits to the *control* variant
    (first variant in the definition) without logging an exposure. A
    running experiment logs the first exposure per user and is idempotent
    on subsequent calls.
    """
    init_db()
    now = datetime.utcnow()
    with session() as s:
        exp = s.execute(select(Experiment).where(Experiment.key == key)).scalar_one_or_none()
        if exp is None:
            raise ExperimentError(f"experiment {key!r} not found")
        variants = list(exp.variants_json or [])
        if not variants:
            raise ExperimentError(f"experiment {key!r} has no variants")
        if exp.state != "running":
            return {
                "experiment_key": key,
                "variant": str(variants[0]["name"]),
                "state": exp.state,
                "recorded": False,
            }
        variant = _assign_variant(exp.salt, user_id, variants)
        recorded = False
        if record:
            existing = s.execute(
                select(ExperimentExposure)
                .where(ExperimentExposure.experiment_key == key)
                .where(ExperimentExposure.user_id == user_id)
            ).scalar_one_or_none()
            if existing is None:
                s.add(ExperimentExposure(
                    experiment_key=key, user_id=user_id, variant=variant,
                    context_json=context, created_at=now,
                ))
                try:
                    s.commit()
                    recorded = True
                except IntegrityError:
                    # Concurrent insert; treat as already-recorded.
                    s.rollback()
        return {
            "experiment_key": key,
            "variant": variant,
            "state": exp.state,
            "recorded": recorded,
        }


def log_event(
    key: str,
    *,
    user_id: str,
    event_name: str,
    value: float | None = None,
    metadata: dict[str, Any] | None = None,
) -> ExperimentEvent:
    """Record a conversion / metric event for a user already exposed.

    The user's variant is read from the most recent exposure row. Calls
    referencing an un-exposed user raise ``ExperimentError``; this is by
    design so analytics never silently attribute the wrong arm.
    """
    if not event_name:
        raise ExperimentError("event_name required")
    init_db()
    now = datetime.utcnow()
    with session() as s:
        exp = s.execute(select(Experiment).where(Experiment.key == key)).scalar_one_or_none()
        if exp is None:
            raise ExperimentError(f"experiment {key!r} not found")
        expo = s.execute(
            select(ExperimentExposure)
            .where(ExperimentExposure.experiment_key == key)
            .where(ExperimentExposure.user_id == user_id)
            .order_by(ExperimentExposure.created_at.desc())
        ).scalars().first()
        if expo is None:
            raise ExperimentError(
                f"user {user_id!r} has no exposure for experiment {key!r}"
            )
        row = ExperimentEvent(
            experiment_key=key,
            user_id=user_id,
            variant=expo.variant,
            event_name=event_name,
            value=value,
            metadata_json=metadata,
            created_at=now,
        )
        s.add(row)
        s.commit()
        s.refresh(row)
        return row


def _wilson(successes: int, n: int, z: float = 1.96) -> tuple[float, float, float]:
    """Wilson score interval for a binomial proportion."""
    if n == 0:
        return (0.0, 0.0, 0.0)
    p = successes / n
    denom = 1.0 + (z * z) / n
    centre = (p + (z * z) / (2 * n)) / denom
    margin = (z * math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / denom
    return (p, max(0.0, centre - margin), min(1.0, centre + margin))


def _two_proportion_z(p_t: float, n_t: int, p_c: float, n_c: int) -> float | None:
    """Return p-value (two-sided) of a two-proportion z-test, or None."""
    if n_t == 0 or n_c == 0:
        return None
    s_t = p_t * n_t
    s_c = p_c * n_c
    pool = (s_t + s_c) / (n_t + n_c)
    se = math.sqrt(pool * (1 - pool) * (1 / n_t + 1 / n_c))
    if se == 0:
        return None
    z = (p_t - p_c) / se
    # Two-sided p via complementary error function.
    return math.erfc(abs(z) / math.sqrt(2))


def results(
    key: str,
    *,
    event_name: str,
) -> dict[str, Any]:
    """Aggregate exposures and conversions for ``event_name``.

    The first variant in the definition is treated as the control. For
    every other variant we compute the conversion rate, Wilson 95% CI,
    absolute lift vs control, and a two-proportion z-test p-value.
    """
    init_db()
    with session() as s:
        exp = s.execute(select(Experiment).where(Experiment.key == key)).scalar_one_or_none()
        if exp is None:
            raise ExperimentError(f"experiment {key!r} not found")
        variants = list(exp.variants_json or [])
        if not variants:
            raise ExperimentError(f"experiment {key!r} has no variants")
        control_name = str(variants[0]["name"])

        exposures = dict(
            s.execute(
                select(ExperimentExposure.variant, func.count(ExperimentExposure.id))
                .where(ExperimentExposure.experiment_key == key)
                .group_by(ExperimentExposure.variant)
            ).all()
        )
        # Count distinct converting users per variant for this event.
        conv_rows = s.execute(
            select(
                ExperimentEvent.variant,
                func.count(func.distinct(ExperimentEvent.user_id)),
            )
            .where(ExperimentEvent.experiment_key == key)
            .where(ExperimentEvent.event_name == event_name)
            .group_by(ExperimentEvent.variant)
        ).all()
        conversions = {variant: int(n) for variant, n in conv_rows}

    arms: list[dict[str, Any]] = []
    for v in variants:
        name = str(v["name"])
        n = int(exposures.get(name, 0))
        k = int(conversions.get(name, 0))
        rate, lo, hi = _wilson(k, n)
        arms.append({
            "variant": name,
            "weight": int(v["weight"]),
            "exposures": n,
            "conversions": k,
            "rate": rate,
            "rate_ci_low": lo,
            "rate_ci_high": hi,
            "is_control": name == control_name,
        })
    control = next(a for a in arms if a["is_control"])
    for arm in arms:
        if arm["is_control"]:
            arm["lift_vs_control"] = 0.0
            arm["p_value"] = None
            continue
        arm["lift_vs_control"] = arm["rate"] - control["rate"]
        arm["p_value"] = _two_proportion_z(
            arm["rate"], arm["exposures"],
            control["rate"], control["exposures"],
        )
    return {
        "experiment_key": key,
        "state": exp.state,
        "event_name": event_name,
        "control": control_name,
        "arms": arms,
    }
