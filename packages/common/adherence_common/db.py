"""SQLAlchemy engine + ORM models (users, predictions, runs)."""
from __future__ import annotations

from datetime import datetime
from functools import lru_cache

from sqlalchemy import JSON, Column, DateTime, Float, Integer, String, create_engine
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
