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
from adherence_common import outbound_policy
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
    secret_previous_active: bool = False
    secret_previous_expires_at: str | None = None


def _previous_active(row: WebhookSubscription) -> bool:
    exp = getattr(row, "secret_previous_expires_at", None)
    prev = getattr(row, "secret_previous", None)
    if not prev or exp is None:
        return False
    return datetime.utcnow() < exp


def _row_to_out(row: WebhookSubscription) -> SubscriptionOut:
    exp = getattr(row, "secret_previous_expires_at", None)
    return SubscriptionOut(
        id=row.id, name=row.name, url=row.url,
        event_types=[t for t in (row.event_types_csv or "").split(",") if t],
        secret=row.secret,
        active=bool(row.active),
        created_by=row.created_by,
        created_at=row.created_at.isoformat(),
        updated_at=row.updated_at.isoformat(),
        secret_previous_active=_previous_active(row),
        secret_previous_expires_at=exp.isoformat() if exp else None,
    )


@router.put("/subscriptions", response_model=SubscriptionOut)
def upsert_subscription(
    body: SubscriptionIn, request: Request, p=Depends(require_admin),
) -> SubscriptionOut:
    init_db()
    caller = _caller_id(request, p)
    tenant_id = str(p.get("tenant") or "default")
    try:
        decision = outbound_policy.ensure_allowed(
            str(body.url), tenant_id=tenant_id,
        )
    except outbound_policy.OutboundPolicyError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "outbound_blocked",
                "reason": str(exc),
                "url": str(body.url),
            },
        )
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
                tenant_id=tenant_id,
                created_by=caller,
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow(),
            )
            s.add(row)
        else:
            # Cross-tenant guard: a subscription name is global but
            # ownership is not transferrable. Refuse a hijack attempt
            # from a different tenant.
            if (getattr(row, "tenant_id", None) or "default") != tenant_id:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail={
                        "code": "cross_tenant_subscription",
                        "reason": "subscription is owned by another tenant",
                    },
                )
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
    tenant_id = str(p.get("tenant") or "default")
    with session() as s:
        rows = list(s.scalars(
            select(WebhookSubscription)
            .where(WebhookSubscription.tenant_id == tenant_id)
            .order_by(WebhookSubscription.id.asc())
        ))
    return [_row_to_out(r) for r in rows]


class RotateSecretIn(BaseModel):
    overlap_minutes: int = Field(
        60, ge=0, le=10080,
        description=(
            "How long the previous secret stays valid alongside the new one "
            "so receivers can roll over without a dropped delivery. 0 means "
            "hard cut. Max one week."
        ),
    )


class RotateSecretOut(BaseModel):
    name: str
    secret: str
    secret_previous_active: bool
    secret_previous_expires_at: str | None
    rotated_at: str


@router.post(
    "/subscriptions/{name}/rotate-secret",
    response_model=RotateSecretOut,
)
def rotate_secret(
    name: str,
    body: RotateSecretIn,
    request: Request,
    dry_run: bool = Query(
        False,
        description=(
            "Preview the rotation without changing the stored secret. "
            "Returns what the next secret + overlap window would be."
        ),
    ),
    p=Depends(require_admin),
) -> RotateSecretOut:
    """Generate a fresh HMAC secret for ``name`` and keep the current
    secret valid for ``overlap_minutes`` so receivers can roll over
    without dropped deliveries. During the overlap window, every signed
    POST also carries ``X-Adherence-Signature-Previous`` so receivers
    can verify against either secret.
    """
    from datetime import timedelta
    init_db()
    caller = _caller_id(request, p)
    tenant_id = str(p.get("tenant") or "default")
    with session() as s:
        row = s.execute(
            select(WebhookSubscription).where(
                WebhookSubscription.name == name,
                WebhookSubscription.tenant_id == tenant_id,
            )
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, detail="subscription not found",
            )
        new_secret = secrets.token_urlsafe(32)
        new_expires = (
            datetime.utcnow() + timedelta(minutes=body.overlap_minutes)
            if body.overlap_minutes > 0
            else None
        )
        if dry_run:
            return RotateSecretOut(
                name=row.name,
                secret=new_secret,
                secret_previous_active=body.overlap_minutes > 0,
                secret_previous_expires_at=(
                    new_expires.isoformat() if new_expires else None
                ),
                rotated_at=datetime.utcnow().isoformat(),
            )
        old_secret = row.secret
        row.secret = new_secret
        if body.overlap_minutes > 0:
            row.secret_previous = old_secret
            row.secret_previous_expires_at = new_expires
        else:
            row.secret_previous = None
            row.secret_previous_expires_at = None
        row.updated_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        result = RotateSecretOut(
            name=row.name,
            secret=row.secret,
            secret_previous_active=_previous_active(row),
            secret_previous_expires_at=(
                row.secret_previous_expires_at.isoformat()
                if row.secret_previous_expires_at else None
            ),
            rotated_at=row.updated_at.isoformat(),
        )
    try:
        from adherence_common.admin_audit import record_admin_action
        record_admin_action(
            action="webhook.secret.rotate",
            principal=p if isinstance(p, dict) else None,
            target=f"webhook_subscription:{name}",
            details={
                "actor": caller,
                "overlap_minutes": body.overlap_minutes,
                "previous_expires_at": result.secret_previous_expires_at,
            },
            request_id=getattr(request.state, "request_id", None),
        )
    except Exception:
        # Audit failures must not block rotation.
        pass
    return result


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
    tenant_id = str(p.get("tenant") or "default")
    if dry_run:
        with session() as s:
            row = s.execute(
                select(WebhookSubscription).where(
                    WebhookSubscription.name == name,
                    WebhookSubscription.tenant_id == tenant_id,
                )
            ).scalar_one_or_none()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="subscription not found")
        return dry_run_response(
            would="delete", name=name, subscription_id=row.id, url=row.url,
        )
    with session() as s:
        res = s.execute(_del(WebhookSubscription).where(
            WebhookSubscription.name == name,
            WebhookSubscription.tenant_id == tenant_id,
        ))
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
    tenant_id = str(p.get("tenant") or "default")
    with session() as s:
        # Only deliveries for subscriptions owned by the caller's tenant.
        sub_ids = [
            r for r in s.scalars(
                select(WebhookSubscription.id).where(
                    WebhookSubscription.tenant_id == tenant_id
                )
            )
        ]
        if not sub_ids:
            return []
        q = (
            select(WebhookDelivery)
            .where(WebhookDelivery.subscription_id.in_(sub_ids))
            .order_by(WebhookDelivery.id.desc())
            .limit(limit)
        )
        if state:
            q = q.where(WebhookDelivery.state == state)
        if subscription_id is not None:
            if subscription_id not in sub_ids:
                return []
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
    init_db()
    tenant_id = str(p.get("tenant") or "default")
    # Verify the delivery belongs to a subscription this tenant owns.
    with session() as s:
        delivery = s.get(WebhookDelivery, delivery_id)
        if delivery is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, detail="delivery not found",
            )
        sub = s.get(WebhookSubscription, delivery.subscription_id)
        if sub is None or (getattr(sub, "tenant_id", "default") or "default") != tenant_id:
            # Hide existence across tenants behind a 404.
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, detail="delivery not found",
            )
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


class PolicyOut(BaseModel):
    allow_http: bool
    allow_private: bool
    host_allowlist: list[str]
    tenant_host_allowlist: list[str] = Field(default_factory=list)


class PolicyCheckIn(BaseModel):
    url: str


class PolicyCheckOut(BaseModel):
    allowed: bool
    reason: str | None
    resolved_ips: list[str]


@router.get("/policy", response_model=PolicyOut)
def get_policy(p=Depends(require_admin)) -> PolicyOut:
    """Return the active outbound destination policy. Used by the
    webhook UI to explain why a URL was rejected."""
    from adherence_common.settings import get_settings
    from adherence_common import outbound_host_allowlist as _tha
    s = get_settings()
    allowlist = [
        e.strip()
        for e in (s.outbound_host_allowlist or "").split(",")
        if e.strip()
    ]
    tenant_id = str(p.get("tenant") or "default")
    tenant_rows = _tha.list_entries(tenant_id)
    return PolicyOut(
        allow_http=bool(s.outbound_allow_http),
        allow_private=bool(s.outbound_allow_private),
        host_allowlist=allowlist,
        tenant_host_allowlist=[r.host for r in tenant_rows],
    )


@router.post("/policy/check", response_model=PolicyCheckOut)
def check_policy(body: PolicyCheckIn, p=Depends(require_admin)) -> PolicyCheckOut:
    """Dry-run a URL against the policy without creating a subscription."""
    tenant_id = str(p.get("tenant") or "default")
    decision = outbound_policy.evaluate(body.url, tenant_id=tenant_id)
    return PolicyCheckOut(
        allowed=decision.allowed,
        reason=decision.reason,
        resolved_ips=list(decision.resolved_ips),
    )
