"""Inbound webhook receivers (e.g. from Med-Tracker).

The medtracker outcome webhook persists ground-truth dose events to the
`dose_outcomes` table. These rows are later joined against `prediction_audit`
to compute online AUC/Brier/calibration in /v1/metrics/online and to gate
challenger model promotion.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError

from adherence_api.deps import require_service
from adherence_common.db import DoseOutcome, init_db, session
from adherence_common.logging import get_logger

router = APIRouter(prefix="/v1/webhooks", tags=["webhooks"])
log = get_logger(__name__)


class OutcomeEvent(BaseModel):
    event_id: str = Field(..., min_length=1, max_length=64,
                          description="Idempotency key from the source system.")
    user_id: str = Field(..., min_length=1, max_length=64)
    dose_id: str = Field(..., min_length=1, max_length=64)
    scheduled_at: datetime
    observed_at: datetime | None = None
    outcome: Literal["taken", "missed", "late"]
    delay_minutes: float | None = None
    notes: str | None = None


class OutcomeBatchRequest(BaseModel):
    source: str = Field("medtracker", max_length=32)
    events: list[OutcomeEvent] = Field(..., min_length=1, max_length=1000)


class OutcomeBatchResponse(BaseModel):
    accepted: int
    duplicates: int
    n: int


@router.post("/medtracker/event", response_model=OutcomeBatchResponse)
def medtracker_event(
    payload: OutcomeBatchRequest, _p=Depends(require_service)
) -> OutcomeBatchResponse:
    """Persist one batch of dose outcomes.

    `event_id` is used for idempotency; duplicate posts are counted but do
    not error so partners can safely retry.
    """
    init_db()
    accepted = 0
    dupes = 0
    with session() as s:
        for ev in payload.events:
            row = DoseOutcome(
                source=payload.source,
                external_event_id=ev.event_id,
                user_id=ev.user_id,
                dose_id=ev.dose_id,
                scheduled_at=ev.scheduled_at,
                observed_at=ev.observed_at,
                outcome=ev.outcome,
                delay_minutes=ev.delay_minutes,
                notes=ev.notes,
            )
            s.add(row)
            try:
                s.flush()
                accepted += 1
            except IntegrityError:
                s.rollback()
                dupes += 1
        s.commit()
    if accepted == 0 and dupes == len(payload.events):
        log.info("medtracker webhook all duplicates",
                 source=payload.source, n=len(payload.events))
    else:
        log.info("medtracker webhook persisted",
                 source=payload.source, accepted=accepted, dupes=dupes)
    return OutcomeBatchResponse(
        accepted=accepted, duplicates=dupes, n=len(payload.events)
    )


@router.get("/medtracker/recent")
def medtracker_recent(
    limit: int = 20, _p=Depends(require_service)
) -> dict:
    """Return the most recent persisted outcomes (debug helper)."""
    if limit < 1 or limit > 200:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "limit out of range")
    init_db()
    from sqlalchemy import select
    with session() as s:
        rows = list(s.scalars(
            select(DoseOutcome).order_by(DoseOutcome.received_at.desc()).limit(limit)
        ))
    return {
        "n": len(rows),
        "items": [
            {
                "id": r.id,
                "source": r.source,
                "user_id": r.user_id,
                "dose_id": r.dose_id,
                "outcome": r.outcome,
                "scheduled_at": r.scheduled_at.isoformat(),
                "observed_at": r.observed_at.isoformat() if r.observed_at else None,
                "received_at": r.received_at.isoformat(),
            }
            for r in rows
        ],
    }
