"""Inbound webhook receivers (e.g. from Med-Tracker)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from adherence_api.deps import require_service
from adherence_common.logging import get_logger

router = APIRouter(prefix="/v1/webhooks", tags=["webhooks"])
log = get_logger(__name__)


@router.post("/medtracker/event")
def medtracker_event(payload: dict[str, Any], _p=Depends(require_service)) -> dict:
    log.info("medtracker webhook received", keys=list(payload.keys()))
    return {"accepted": True, "received": len(payload)}
