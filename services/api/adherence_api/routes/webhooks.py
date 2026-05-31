"""Inbound webhook receivers (e.g. from Med-Tracker).

The medtracker outcome webhook persists ground-truth dose events to the
`dose_outcomes` table. These rows are later joined against `prediction_audit`
to compute online AUC/Brier/calibration in /v1/metrics/online and to gate
challenger model promotion.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy.exc import IntegrityError

from adherence_api.deps import SettingsDep, require_service
from adherence_common.db import DoseOutcome, init_db, session
from adherence_common.inbound_webhook import verify as verify_inbound
from adherence_common.inbound_webhook_ip import check as check_inbound_ip
from adherence_common.logging import get_logger
from adherence_common.pii_policy import scrub_text


def _source_tenant(mapping_csv: str, source: str) -> str | None:
    """Resolve ``source`` to a workspace tenant via the operator-provided
    ``inbound_source_tenants`` mapping. Returns ``None`` when no mapping
    is configured for the source, in which case the caller should skip
    value-level scrubbing."""
    if not mapping_csv or not source:
        return None
    for entry in mapping_csv.split(","):
        if ":" not in entry:
            continue
        src, tid = entry.split(":", 1)
        if src.strip() == source.strip():
            tid = tid.strip()
            return tid or None
    return None

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
async def medtracker_event(
    request: Request,
    settings: SettingsDep,
    _p=Depends(require_service),
    x_webhook_signature: str | None = Header(default=None),
    x_webhook_timestamp: str | None = Header(default=None),
) -> OutcomeBatchResponse:
    """Persist one batch of dose outcomes.

    `event_id` is used for idempotency; duplicate posts are counted but do
    not error so partners can safely retry.

    When ``ADHERENCE_INBOUND_WEBHOOK_SECRETS`` contains an entry for
    ``medtracker``, this endpoint requires an HMAC envelope via
    ``X-Webhook-Signature`` + ``X-Webhook-Timestamp`` (see
    ``adherence_common.inbound_webhook``). Without it, requests are
    rejected with 401. Unsigned partners are accepted only while no
    secret is configured for them, and a warning is logged.
    """
    raw = await request.body()
    # Network-layer pre-check: per-source IP / CIDR allowlist. Runs
    # before HMAC verification so a leaked secret cannot mint forged
    # outcome rows from an arbitrary egress IP. Sources with no rules
    # configured pass through (back-compat).
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        client_ip = xff.split(",")[0].strip()
    else:
        client_ip = (
            request.headers.get("x-real-ip", "").strip()
            or (request.client.host if request.client else "")
        )
    ip_chk = check_inbound_ip(
        source="medtracker",
        client_ip=client_ip,
        allowlist_csv=settings.inbound_webhook_ip_allowlist,
    )
    if not ip_chk.ok:
        log.warning(
            "inbound_webhook_ip_block",
            source="medtracker",
            client_ip=client_ip,
            reason=ip_chk.reason,
        )
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail=f"inbound webhook ip: {ip_chk.reason}",
        )
    result = verify_inbound(
        source="medtracker",
        body=raw,
        signature_header=x_webhook_signature,
        timestamp_header=x_webhook_timestamp,
        settings=settings,
    )
    if not result.ok:
        log.warning(
            "medtracker webhook signature rejected",
            reason=result.reason,
        )
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail=f"webhook signature: {result.reason}",
        )
    try:
        payload = OutcomeBatchRequest.model_validate_json(raw)
    except ValidationError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.errors())
    init_db()
    pii_tenant = _source_tenant(
        settings.inbound_source_tenants, payload.source,
    )
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
                notes=(
                    scrub_text(pii_tenant, ev.notes)
                    if (pii_tenant and ev.notes) else ev.notes
                ),
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
                 source=payload.source, n=len(payload.events),
                 signed=result.signed)
    else:
        log.info("medtracker webhook persisted",
                 source=payload.source, accepted=accepted, dupes=dupes,
                 signed=result.signed)
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


@router.get("/inbound/config")
def inbound_config(settings: SettingsDep, _p=Depends(require_service)) -> dict:
    """Return inbound webhook security posture per source.

    Used by the admin dashboard so an operator can see at a glance which
    partner sources require HMAC and which are IP-restricted, without
    grepping environment variables. Secrets themselves are never echoed
    back, only their presence.
    """
    from adherence_common.inbound_webhook import parse_secrets
    from adherence_common.inbound_webhook_ip import summary as ip_summary
    secrets_map = parse_secrets(settings.inbound_webhook_secrets)
    ip_map = ip_summary(settings.inbound_webhook_ip_allowlist)
    sources = sorted(set(secrets_map) | set(ip_map) | {"medtracker"})
    return {
        "require_signed": bool(settings.inbound_webhook_require_signed),
        "max_skew_seconds": int(settings.inbound_webhook_max_skew_seconds),
        "sources": [
            {
                "source": s,
                "signed": s in secrets_map,
                "ip_restricted": s in ip_map,
                "allowed_cidrs": ip_map.get(s, []),
            }
            for s in sources
        ],
    }
