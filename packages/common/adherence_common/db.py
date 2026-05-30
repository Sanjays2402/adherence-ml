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
