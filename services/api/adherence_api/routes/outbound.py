"""/v1/webhooks/outbound: manage outbound webhook subscriptions and view
delivery attempts.

Subscriptions are admin-managed. When a high-risk intervention is
recommended (or other registered events fire), every active subscription
whose ``event_types`` allowlist matches receives a signed POST to its URL.
Each attempt is recorded in WebhookDelivery for audit and replay.
"""
from __future__ import annotations

import secrets
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field, HttpUrl
from sqlalchemy import select

from adherence_api.deps import require_admin
from adherence_api.dry_run import dry_run_response
from adherence_api.routes.predict import _caller_id
from adherence_common import outbound as outbound_mod
from adherence_common.db import (
    WebhookDelivery, WebhookSubscription, init_db, session,
)

router = APIRouter(prefix="/v1/webhooks/outbound", tags=["webhooks"])


class SubscriptionIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    url: HttpUrl
    event_types: list[str] = Field(
        default_factory=list,
        description="Allowlist of event types. Empty means all events.",
    )
    secret: str | None = Field(
        None, min_length=16, max_length=128,
        description="HMAC secret. Auto-generated if omitted.",
    )
    active: bool = True


class SubscriptionOut(BaseModel):
    id: int
    name: str
    url: str
    event_types: list[str]
    secret: str
    active: bool
    created_by: str | None
    created_at: str
    updated_at: str


def _row_to_out(row: WebhookSubscription) -> SubscriptionOut:
    return SubscriptionOut(
        id=row.id, name=row.name, url=row.url,
        event_types=[t for t in (row.event_types_csv or "").split(",") if t],
        secret=row.secret,
        active=bool(row.active),
        created_by=row.created_by,
        created_at=row.created_at.isoformat(),
        updated_at=row.updated_at.isoformat(),
    )


@router.put("/subscriptions", response_model=SubscriptionOut)
def upsert_subscription(
    body: SubscriptionIn, request: Request, p=Depends(require_admin),
) -> SubscriptionOut:
    init_db()
    caller = _caller_id(request, p)
    secret_val = body.secret or secrets.token_urlsafe(32)
    csv = ",".join(sorted({e.strip() for e in body.event_types if e.strip()}))
    with session() as s:
        row = s.execute(
            select(WebhookSubscription).where(WebhookSubscription.name == body.name)
        ).scalar_one_or_none()
        if row is None:
            row = WebhookSubscription(
                name=body.name, url=str(body.url), secret=secret_val,
                event_types_csv=csv, active=1 if body.active else 0,
                created_by=caller,
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow(),
            )
            s.add(row)
        else:
            row.url = str(body.url)
            if body.secret:
                row.secret = secret_val
            row.event_types_csv = csv
            row.active = 1 if body.active else 0
            row.updated_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return _row_to_out(row)


@router.get("/subscriptions", response_model=list[SubscriptionOut])
def list_subscriptions(p=Depends(require_admin)) -> list[SubscriptionOut]:
    init_db()
    with session() as s:
        rows = list(s.scalars(
            select(WebhookSubscription).order_by(WebhookSubscription.id.asc())
        ))
    return [_row_to_out(r) for r in rows]


@router.delete("/subscriptions/{name}")
def delete_subscription(
    name: str,
    dry_run: bool = Query(
        False,
        description="Preview without deleting. Returns 404 if subscription is missing.",
    ),
    p=Depends(require_admin),
):
    from sqlalchemy import delete as _del
    init_db()
    if dry_run:
        with session() as s:
            row = s.execute(
                select(WebhookSubscription).where(WebhookSubscription.name == name)
            ).scalar_one_or_none()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="subscription not found")
        return dry_run_response(
            would="delete", name=name, subscription_id=row.id, url=row.url,
        )
    with session() as s:
        res = s.execute(_del(WebhookSubscription).where(WebhookSubscription.name == name))
        s.commit()
    if res.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="subscription not found")
    return {"deleted": True, "name": name}


class DeliveryOut(BaseModel):
    id: int
    subscription_id: int
    event_type: str
    attempt: int
    status_code: int | None
    latency_ms: float | None
    error: str | None
    state: str
    created_at: str


@router.get("/deliveries", response_model=list[DeliveryOut])
def list_deliveries(
    limit: int = Query(100, ge=1, le=1000),
    state: str | None = None,
    subscription_id: int | None = None,
    p=Depends(require_admin),
) -> list[DeliveryOut]:
    init_db()
    with session() as s:
        q = (
            select(WebhookDelivery)
            .order_by(WebhookDelivery.id.desc())
            .limit(limit)
        )
        if state:
            q = q.where(WebhookDelivery.state == state)
        if subscription_id is not None:
            q = q.where(WebhookDelivery.subscription_id == subscription_id)
        rows = list(s.scalars(q))
    return [
        DeliveryOut(
            id=r.id, subscription_id=r.subscription_id,
            event_type=r.event_type, attempt=r.attempt,
            status_code=r.status_code, latency_ms=r.latency_ms,
            error=r.error, state=r.state,
            created_at=r.created_at.isoformat(),
        )
        for r in rows
    ]


class ReplayOut(BaseModel):
    new_delivery_id: int | None
    replayed: bool


@router.post("/deliveries/{delivery_id}/replay", response_model=ReplayOut)
def replay_delivery(delivery_id: int, p=Depends(require_admin)) -> ReplayOut:
    new_id = outbound_mod.replay(delivery_id)
    if new_id is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail="delivery not found or subscription inactive",
        )
    return ReplayOut(new_delivery_id=new_id, replayed=True)


class TestSendIn(BaseModel):
    name: str
    event_type: str = "test.ping"
    payload: dict[str, Any] = Field(default_factory=dict)


class TestSendOut(BaseModel):
    delivery_ids: list[int]


@router.post("/test-send", response_model=TestSendOut)
def test_send(body: TestSendIn, p=Depends(require_admin)) -> TestSendOut:
    """Send a test event to all subscriptions matching ``event_type``."""
    ids = outbound_mod.dispatch(body.event_type, body.payload)
    return TestSendOut(delivery_ids=ids)
