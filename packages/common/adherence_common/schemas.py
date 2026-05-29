"""Shared pydantic schemas."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

DoseClass = Literal[
    "cardio", "neuro", "endocrine", "psych", "antibiotic", "supplement", "other"
]

EventStatus = Literal["taken", "missed", "skipped", "late"]


class DoseEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str
    dose_id: str
    scheduled_at: datetime
    taken_at: datetime | None = None
    status: EventStatus
    dose_class: DoseClass = "other"
    dose_strength_mg: float = 0.0


class ScheduledDose(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dose_id: str
    scheduled_at: datetime
    dose_class: DoseClass = "other"
    dose_strength_mg: float = 0.0


class PredictRequest(BaseModel):
    user_id: str
    schedule: list[ScheduledDose] = Field(default_factory=list)
    history: list[DoseEvent] | None = None
    top_k_reasons: int = 3


class ReasonCode(BaseModel):
    feature: str
    contribution: float
    human: str


class DosePrediction(BaseModel):
    dose_id: str
    scheduled_at: datetime
    miss_probability: float
    risk_tier: Literal["low", "medium", "high"]
    reasons: list[ReasonCode] = Field(default_factory=list)


class PredictResponse(BaseModel):
    user_id: str
    model_version: str
    predictions: list[DosePrediction]


class TrainRequest(BaseModel):
    synthetic: bool = True
    n_users: int = 5000
    n_days: int = 60
    seed: int = 42
    register_as: str = "default"


class TrainResponse(BaseModel):
    run_id: str
    model_version: str
    metrics: dict[str, float]


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded", "down"] = "ok"
    version: str
    model_loaded: bool
    redis_ok: bool
    db_ok: bool
