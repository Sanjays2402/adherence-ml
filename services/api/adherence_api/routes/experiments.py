"""/v1/experiments: define, assign, log, and analyze A/B experiments.

Endpoints:
  POST   /v1/experiments                       create (admin)
  GET    /v1/experiments                       list  (service)
  GET    /v1/experiments/{key}                 get   (service)
  PATCH  /v1/experiments/{key}/state           change state (admin)
  POST   /v1/experiments/{key}/assign          deterministic per-user assignment
  POST   /v1/experiments/{key}/events          log a conversion / metric event
  GET    /v1/experiments/{key}/results         aggregate with Wilson CI + p-value
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from adherence_api.deps import require_admin, require_service
from adherence_common import experiments as exp_mod

router = APIRouter(prefix="/v1/experiments", tags=["experiments"])


class VariantIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    weight: int = Field(..., ge=1, le=10_000)


class ExperimentIn(BaseModel):
    key: str = Field(..., min_length=1, max_length=64)
    description: str | None = Field(None, max_length=512)
    variants: list[VariantIn] = Field(..., min_length=2)
    salt: str | None = Field(None, max_length=64)
    state: str = "running"


class ExperimentOut(BaseModel):
    key: str
    description: str | None
    variants: list[dict[str, Any]]
    salt: str
    state: str
    created_by: str | None
    created_at: str


def _to_out(exp) -> ExperimentOut:
    return ExperimentOut(
        key=exp.key,
        description=exp.description,
        variants=list(exp.variants_json or []),
        salt=exp.salt,
        state=exp.state,
        created_by=exp.created_by,
        created_at=exp.created_at.isoformat(),
    )


@router.post("", response_model=ExperimentOut, status_code=status.HTTP_201_CREATED)
def create_experiment(body: ExperimentIn, p=Depends(require_admin)) -> ExperimentOut:
    try:
        row = exp_mod.create_experiment(
            key=body.key,
            description=body.description,
            variants=[v.model_dump() for v in body.variants],
            salt=body.salt,
            state=body.state,
            created_by=p.get("sub"),
        )
    except exp_mod.ExperimentError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return _to_out(row)


@router.get("", response_model=list[ExperimentOut])
def list_experiments(_p=Depends(require_service)) -> list[ExperimentOut]:
    return [_to_out(r) for r in exp_mod.list_experiments()]


@router.get("/{key}", response_model=ExperimentOut)
def get_experiment(key: str, _p=Depends(require_service)) -> ExperimentOut:
    row = exp_mod.get_experiment(key)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")
    return _to_out(row)


class StateIn(BaseModel):
    state: str = Field(..., description="draft | running | paused | stopped")


@router.patch("/{key}/state", response_model=ExperimentOut)
def patch_state(key: str, body: StateIn, _p=Depends(require_admin)) -> ExperimentOut:
    try:
        row = exp_mod.set_state(key, body.state)
    except exp_mod.ExperimentError as exc:
        # 404 when missing, 400 otherwise.
        code = status.HTTP_404_NOT_FOUND if "not found" in str(exc) else status.HTTP_400_BAD_REQUEST
        raise HTTPException(code, detail=str(exc))
    return _to_out(row)


class AssignIn(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=64)
    context: dict[str, Any] | None = None
    record: bool = True


class AssignOut(BaseModel):
    experiment_key: str
    variant: str
    state: str
    recorded: bool


@router.post("/{key}/assign", response_model=AssignOut)
def assign(key: str, body: AssignIn, _p=Depends(require_service)) -> AssignOut:
    try:
        out = exp_mod.assign(key, body.user_id, context=body.context, record=body.record)
    except exp_mod.ExperimentError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=str(exc))
    return AssignOut(**out)


class EventIn(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=64)
    event_name: str = Field(..., min_length=1, max_length=64)
    value: float | None = None
    metadata: dict[str, Any] | None = None


class EventOut(BaseModel):
    id: int
    experiment_key: str
    user_id: str
    variant: str
    event_name: str


@router.post("/{key}/events", response_model=EventOut, status_code=status.HTTP_201_CREATED)
def log_event(key: str, body: EventIn, _p=Depends(require_service)) -> EventOut:
    try:
        row = exp_mod.log_event(
            key,
            user_id=body.user_id,
            event_name=body.event_name,
            value=body.value,
            metadata=body.metadata,
        )
    except exp_mod.ExperimentError as exc:
        code = status.HTTP_404_NOT_FOUND if "not found" in str(exc) or "no exposure" in str(exc) else status.HTTP_400_BAD_REQUEST
        raise HTTPException(code, detail=str(exc))
    return EventOut(
        id=row.id, experiment_key=row.experiment_key,
        user_id=row.user_id, variant=row.variant, event_name=row.event_name,
    )


class ArmOut(BaseModel):
    variant: str
    weight: int
    exposures: int
    conversions: int
    rate: float
    rate_ci_low: float
    rate_ci_high: float
    is_control: bool
    lift_vs_control: float
    p_value: float | None


class ResultsOut(BaseModel):
    experiment_key: str
    state: str
    event_name: str
    control: str
    arms: list[ArmOut]


@router.get("/{key}/results", response_model=ResultsOut)
def results(
    key: str,
    event_name: str = Query(..., min_length=1, max_length=64),
    _p=Depends(require_service),
) -> ResultsOut:
    try:
        out = exp_mod.results(key, event_name=event_name)
    except exp_mod.ExperimentError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=str(exc))
    return ResultsOut(**out)
