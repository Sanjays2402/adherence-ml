"""SQLAlchemy engine + ORM models (users, predictions, runs)."""
from __future__ import annotations

from datetime import datetime
from functools import lru_cache

from sqlalchemy import JSON, Column, DateTime, Float, Integer, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from adherence_common.settings import get_settings


class Base(DeclarativeBase):
    pass


class PredictionRow(Base):
    __tablename__ = "predictions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String(64), index=True, nullable=False)
    dose_id = Column(String(64), index=True, nullable=False)
    scheduled_at = Column(DateTime, nullable=False)
    miss_probability = Column(Float, nullable=False)
    risk_tier = Column(String(16), nullable=False)
    model_version = Column(String(64), nullable=False)
    reasons = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class PredictionAudit(Base):
    """One row per /v1/predict (or batch item) call.

    Stores enough to debug regressions, compute online metrics later (when
    ground-truth `taken/missed` events arrive via webhook), and trace a
    response back to the caller and model version that produced it.
    """
    __tablename__ = "prediction_audit"
    id = Column(Integer, primary_key=True, autoincrement=True)
    request_id = Column(String(32), index=True, nullable=False)
    route = Column(String(64), nullable=False)
    user_id = Column(String(64), index=True, nullable=False)
    caller = Column(String(64), index=True, nullable=False)
    caller_role = Column(String(16), nullable=False)
    model_name = Column(String(64), nullable=False)
    model_version = Column(String(64), nullable=False)
    shadow_model_name = Column(String(64), nullable=True)
    shadow_model_version = Column(String(64), nullable=True)
    n_doses = Column(Integer, nullable=False)
    mean_miss_prob = Column(Float, nullable=True)
    max_miss_prob = Column(Float, nullable=True)
    high_risk_count = Column(Integer, nullable=False, default=0)
    shadow_max_divergence = Column(Float, nullable=True)
    latency_ms = Column(Float, nullable=True)
    ok = Column(Integer, nullable=False, default=1)
    error = Column(Text, nullable=True)
    response_summary = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


class DoseOutcome(Base):
    """Ground-truth dose event reported by a partner (e.g. Med-Tracker).

    One row per scheduled dose with the observed outcome. Joined against
    PredictionAudit (via user_id + dose_id) to compute online metrics such
    as AUC/Brier/calibration on live traffic.
    """
    __tablename__ = "dose_outcomes"
    id = Column(Integer, primary_key=True, autoincrement=True)
    source = Column(String(32), nullable=False, default="medtracker")
    external_event_id = Column(String(64), unique=True, nullable=True, index=True)
    user_id = Column(String(64), index=True, nullable=False)
    dose_id = Column(String(64), index=True, nullable=False)
    scheduled_at = Column(DateTime, nullable=False, index=True)
    observed_at = Column(DateTime, nullable=True)
    outcome = Column(String(16), nullable=False)  # "taken" | "missed" | "late"
    delay_minutes = Column(Float, nullable=True)
    notes = Column(Text, nullable=True)
    received_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


class IdempotencyRecord(Base):
    """Stores cached responses keyed by Idempotency-Key + caller + route.

    Lets webhook callers safely retry POST /v1/predict and friends without
    causing duplicate audit rows or non-deterministic re-scoring. Replays
    return the original status code and body for `ttl_seconds`.
    """
    __tablename__ = "idempotency_records"
    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(128), nullable=False, index=True)
    caller = Column(String(64), nullable=False, index=True)
    route = Column(String(64), nullable=False)
    request_hash = Column(String(64), nullable=False)
    status_code = Column(Integer, nullable=False)
    response_json = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    expires_at = Column(DateTime, nullable=False, index=True)


class UserRiskPolicy(Base):
    """Per-user (or per-dose-class) overrides for risk-tier cutoffs.

    Default tiering uses global thresholds (low<0.3, medium<0.7, else high).
    Clinicians can store overrides so e.g. a transplant patient gets `high`
    at p>=0.4. `scope_type` is one of 'user' or 'dose_class'; `scope_id` is
    the user_id or dose_class string. Most-specific match wins (user beats
    class beats global).
    """
    __tablename__ = "user_risk_policies"
    id = Column(Integer, primary_key=True, autoincrement=True)
    scope_type = Column(String(16), nullable=False, index=True)
    scope_id = Column(String(64), nullable=False, index=True)
    low_max = Column(Float, nullable=False)
    medium_max = Column(Float, nullable=False)
    note = Column(Text, nullable=True)
    updated_by = Column(String(64), nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class QuietHoursPolicy(Base):
    """Per-user quiet-hours window during which interventions are suppressed
    or shifted to a non-disruptive channel.

    `start_hour` and `end_hour` are local-time hours (0..23) in `tz`. If
    `end_hour < start_hour` the window wraps midnight. Channels in
    `allowed_channels_csv` are still delivered during quiet hours (e.g.
    'email' only); everything else is deferred to `end_hour`.
    """
    __tablename__ = "quiet_hours_policies"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String(64), nullable=False, unique=True, index=True)
    tz = Column(String(64), nullable=False, default="UTC")
    start_hour = Column(Integer, nullable=False)
    end_hour = Column(Integer, nullable=False)
    allowed_channels_csv = Column(String(128), nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class TrainingRun(Base):
    __tablename__ = "training_runs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String(64), unique=True, nullable=False)
    model_version = Column(String(64), nullable=False)
    auc = Column(Float, nullable=True)
    pr_auc = Column(Float, nullable=True)
    brier = Column(Float, nullable=True)
    ece = Column(Float, nullable=True)
    n_rows = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    metadata_json = Column("metadata", JSON, nullable=True)


@lru_cache(maxsize=1)
def _engine():
    s = get_settings()
    return create_engine(s.db_url, future=True, pool_pre_ping=True)


@lru_cache(maxsize=1)
def _session_factory():
    return sessionmaker(bind=_engine(), expire_on_commit=False, future=True)


def init_db() -> None:
    Base.metadata.create_all(_engine())


def session() -> Session:
    return _session_factory()()
