"""/v1/webhooks/outbound: manage outbound webhook subscriptions and view
delivery attempts.

Subscriptions are admin-managed. When a high-risk intervention is
recommended (or other registered events fire), every active subscription
whose ``event_types`` allowlist matches receives a signed POST to its URL.
Each attempt is recorded in WebhookDelivery for audit and replay.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field, HttpUrl
from sqlalchemy import select

from adherence_api.deps import require_admin
from adherence_api.dry_run import dry_run_response
from adherence_api.routes.predict import _caller_id
from adherence_common import outbound as outbound_mod
from adherence_common import outbound_headers
from adherence_common import outbound_policy
from adherence_common import webhook_events as webhook_catalog
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
    consecutive_failures: int = 0
    disabled_at: str | None = None
    disabled_reason: str | None = None
    # Custom HTTP headers merged into every outbound delivery for this
    # subscription. Sensitive values (Authorization, tokens, secrets)
    # are masked with "***" in this response; the dispatcher still
    # uses the unredacted value on the wire.
    extra_headers: dict[str, str] = Field(default_factory=dict)
    extra_headers_redacted_keys: list[str] = Field(default_factory=list)


def _previous_active(row: WebhookSubscription) -> bool:
    exp = getattr(row, "secret_previous_expires_at", None)
    prev = getattr(row, "secret_previous", None)
    if not prev or exp is None:
        return False
    return datetime.utcnow() < exp


def _row_to_out(row: WebhookSubscription) -> SubscriptionOut:
    exp = getattr(row, "secret_previous_expires_at", None)
    disabled_at = getattr(row, "disabled_at", None)
    stored_headers = outbound_headers.decode(
        getattr(row, "extra_headers_json", None),
    )
    visible_headers = outbound_headers.redact_for_display(stored_headers)
    redacted_keys = sorted(
        name for name in stored_headers
        if outbound_headers.is_sensitive_name(name)
    )
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
        consecutive_failures=int(getattr(row, "consecutive_failures", 0) or 0),
        disabled_at=disabled_at.isoformat() if disabled_at else None,
        disabled_reason=getattr(row, "disabled_reason", None),
        extra_headers=visible_headers,
        extra_headers_redacted_keys=redacted_keys,
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
    requested = sorted({e.strip() for e in body.event_types if e.strip()})
    # Validate every requested event_type against the canonical catalog.
    # Subscribing to an unknown event would silently never fire, which
    # masks integration bugs and breaks the contract introspection
    # endpoint. Reject up front with a structured 400.
    unknown = [e for e in requested if not webhook_catalog.is_known(e)]
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "unknown_event_type",
                "reason": (
                    "one or more event_types are not in the catalog; "
                    "see GET /v1/webhooks/event-catalog"
                ),
                "unknown": unknown,
                "known": sorted(webhook_catalog.known_event_types()),
            },
        )
    csv = ",".join(requested)
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


class ResetBreakerOut(BaseModel):
    name: str
    reset: bool
    previous_consecutive_failures: int
    was_disabled: bool


@router.post(
    "/subscriptions/{name}/reset-breaker",
    response_model=ResetBreakerOut,
)
def reset_breaker(
    name: str,
    request: Request,
    dry_run: bool = Query(
        False,
        description="Preview the reset without mutating the subscription.",
    ),
    p=Depends(require_admin),
) -> ResetBreakerOut:
    """Clear the circuit-breaker state on an outbound subscription.

    Zeroes ``consecutive_failures`` and (if the breaker had tripped)
    clears ``disabled_at`` / ``disabled_reason`` so dispatch resumes
    sending to this URL. The audit trail is preserved in WebhookDelivery.
    """
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
        prev_failures = int(getattr(row, "consecutive_failures", 0) or 0)
        was_disabled = getattr(row, "disabled_at", None) is not None
        if dry_run:
            return ResetBreakerOut(
                name=row.name,
                reset=False,
                previous_consecutive_failures=prev_failures,
                was_disabled=was_disabled,
            )
        row.consecutive_failures = 0
        row.disabled_at = None
        row.disabled_reason = None
        row.updated_at = datetime.utcnow()
        s.commit()
    try:
        from adherence_common.admin_audit import record_admin_action
        record_admin_action(
            action="webhook.circuit_breaker.reset",
            principal=p if isinstance(p, dict) else None,
            target=f"webhook_subscription:{name}",
            details={
                "actor": caller,
                "previous_consecutive_failures": prev_failures,
                "was_disabled": was_disabled,
            },
            request_id=getattr(request.state, "request_id", None),
        )
    except Exception:
        pass
    return ResetBreakerOut(
        name=name,
        reset=True,
        previous_consecutive_failures=prev_failures,
        was_disabled=was_disabled,
    )


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
    if not webhook_catalog.is_known(body.event_type):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "unknown_event_type",
                "reason": (
                    "event_type is not in the catalog; "
                    "see GET /v1/webhooks/event-catalog"
                ),
                "event_type": body.event_type,
            },
        )
    ids = outbound_mod.dispatch(body.event_type, body.payload)
    return TestSendOut(delivery_ids=ids)


class DeadLetterOut(BaseModel):
    count: int
    items: list[DeliveryOut]


@router.get("/deliveries/dead-letter", response_model=DeadLetterOut)
def list_dead_letter(
    limit: int = Query(100, ge=1, le=1000),
    p=Depends(require_admin),
) -> DeadLetterOut:
    """Tenant-scoped dead-letter queue.

    A delivery lands here once its retry budget has been exhausted
    without a 2xx response. Operators see exactly what the receiver
    dropped and can replay individual rows via
    ``POST /deliveries/{id}/replay`` once the downstream is healthy.

    Isolation is enforced twice: deliveries are filtered on the
    denormalised ``tenant_id`` column written at dispatch time, and the
    replay endpoint independently verifies tenant ownership of the
    owning subscription. A cross-tenant request returns an empty list,
    never another tenant's failures.
    """
    init_db()
    tenant_id = str(p.get("tenant") or "default")
    rows = outbound_mod.recent_deliveries(limit=limit, tenant_id=tenant_id)
    items = [
        DeliveryOut(
            id=r.id, subscription_id=r.subscription_id,
            event_type=r.event_type, attempt=r.attempt,
            status_code=r.status_code, latency_ms=r.latency_ms,
            error=r.error, state=r.state,
            created_at=r.created_at.isoformat(),
        )
        for r in rows if r.state == "dead_letter"
    ]
    return DeadLetterOut(
        count=outbound_mod.dead_letter_count(tenant_id),
        items=items,
    )


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


class DeliveryHealthOut(BaseModel):
    """Rolling-window delivery health for a single subscription.

    Computed on demand from ``webhook_deliveries``. Tenant-scoped: we
    only count rows whose denormalised ``tenant_id`` matches the caller,
    so cross-tenant requests can never see another workspace's numbers
    (and a typo'd subscription name in a foreign workspace returns 404,
    not zeros, so it can't be used as an existence oracle).
    """
    name: str
    subscription_id: int
    window_minutes: int
    window_started_at: str
    total: int
    success: int
    failed: int
    dead_letter: int
    queued: int
    blocked: int
    success_rate: float = Field(
        ..., description="success / total over the window, 0..1. 1.0 when no deliveries.",
    )
    p50_latency_ms: float | None
    p95_latency_ms: float | None
    last_status_code: int | None
    last_state: str | None
    last_error: str | None
    last_attempt_at: str | None
    last_success_at: str | None
    consecutive_failures: int
    active: bool
    disabled_at: str | None
    disabled_reason: str | None


def _percentile(sorted_vals: list[float], pct: float) -> float | None:
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return float(sorted_vals[0])
    # Nearest-rank: index = ceil(pct * N) - 1, clamped.
    import math
    k = max(0, min(len(sorted_vals) - 1, math.ceil(pct * len(sorted_vals)) - 1))
    return float(sorted_vals[k])


@router.get(
    "/subscriptions/{name}/health",
    response_model=DeliveryHealthOut,
)
def subscription_health(
    name: str,
    window_minutes: int = Query(
        1440, ge=1, le=10080,
        description=(
            "Lookback window in minutes. Default 24h, max 7 days. "
            "Counts every delivery attempt created within the window."
        ),
    ),
    p=Depends(require_admin),
) -> DeliveryHealthOut:
    """Return a rolling-window delivery health summary for ``name``.

    Lets operators answer "is this receiver healthy right now" without
    paging through individual delivery rows. Returns 404 if the named
    subscription does not belong to the caller's tenant so the endpoint
    cannot be used to enumerate another workspace's webhooks.
    """
    init_db()
    tenant_id = str(p.get("tenant") or "default")
    cutoff = datetime.utcnow() - timedelta(minutes=window_minutes)
    with session() as s:
        sub = s.execute(
            select(WebhookSubscription).where(
                WebhookSubscription.name == name,
                WebhookSubscription.tenant_id == tenant_id,
            )
        ).scalar_one_or_none()
        if sub is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, detail="subscription not found",
            )
        rows = list(s.scalars(
            select(WebhookDelivery)
            .where(
                WebhookDelivery.subscription_id == sub.id,
                WebhookDelivery.tenant_id == tenant_id,
                WebhookDelivery.created_at >= cutoff,
            )
            .order_by(WebhookDelivery.id.desc())
        ))
        # Last attempt (any state) across all history, not just the window,
        # so a quiet subscription still shows when it last fired.
        last_any = s.execute(
            select(WebhookDelivery)
            .where(
                WebhookDelivery.subscription_id == sub.id,
                WebhookDelivery.tenant_id == tenant_id,
            )
            .order_by(WebhookDelivery.id.desc())
            .limit(1)
        ).scalar_one_or_none()
        last_success = s.execute(
            select(WebhookDelivery)
            .where(
                WebhookDelivery.subscription_id == sub.id,
                WebhookDelivery.tenant_id == tenant_id,
                WebhookDelivery.state == "success",
            )
            .order_by(WebhookDelivery.id.desc())
            .limit(1)
        ).scalar_one_or_none()
        active = bool(sub.active)
        disabled_at = getattr(sub, "disabled_at", None)
        disabled_reason = getattr(sub, "disabled_reason", None)
        consecutive_failures = int(getattr(sub, "consecutive_failures", 0) or 0)

    by_state: dict[str, int] = {}
    latencies: list[float] = []
    for r in rows:
        by_state[r.state] = by_state.get(r.state, 0) + 1
        if r.latency_ms is not None and r.state == "success":
            latencies.append(float(r.latency_ms))
    latencies.sort()
    total = len(rows)
    success = by_state.get("success", 0)
    failed = by_state.get("failed", 0)
    dead_letter = by_state.get("dead_letter", 0)
    queued = by_state.get("queued", 0)
    blocked = by_state.get("blocked", 0)
    # success_rate over terminal-or-attempted rows; treat "no traffic" as
    # healthy (1.0) so a quiet receiver isn't flagged red.
    denom = total
    rate = 1.0 if denom == 0 else success / denom

    return DeliveryHealthOut(
        name=sub.name,
        subscription_id=sub.id,
        window_minutes=window_minutes,
        window_started_at=cutoff.isoformat(),
        total=total,
        success=success,
        failed=failed,
        dead_letter=dead_letter,
        queued=queued,
        blocked=blocked,
        success_rate=round(rate, 4),
        p50_latency_ms=_percentile(latencies, 0.50),
        p95_latency_ms=_percentile(latencies, 0.95),
        last_status_code=(last_any.status_code if last_any else None),
        last_state=(last_any.state if last_any else None),
        last_error=(last_any.error if last_any else None),
        last_attempt_at=(
            last_any.created_at.isoformat() if last_any else None
        ),
        last_success_at=(
            last_success.created_at.isoformat() if last_success else None
        ),
        consecutive_failures=consecutive_failures,
        active=active,
        disabled_at=disabled_at.isoformat() if disabled_at else None,
        disabled_reason=disabled_reason,
    )


# ---------------------------------------------------------------------------
# Per-subscription custom HTTP headers
# ---------------------------------------------------------------------------


class HeadersIn(BaseModel):
    """Replace the full custom-header map for a subscription.

    Pass an empty object to clear all custom headers. Sensitive values
    (Authorization, tokens, secrets) are stored as written but are
    redacted in any subsequent listing response. The dispatcher never
    lets these headers override the X-Adherence-* signature, timestamp,
    event, or attempt headers.
    """

    headers: dict[str, str] = Field(default_factory=dict)


class HeadersOut(BaseModel):
    name: str
    extra_headers: dict[str, str]
    extra_headers_redacted_keys: list[str]
    count: int


def _validate_or_400(raw: dict[str, str]) -> dict[str, str]:
    try:
        return outbound_headers.validate_headers(raw)
    except outbound_headers.HeaderValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": exc.code,
                "reason": str(exc),
                "field": exc.field,
            },
        )


def _headers_out(row: WebhookSubscription) -> HeadersOut:
    stored = outbound_headers.decode(getattr(row, "extra_headers_json", None))
    return HeadersOut(
        name=row.name,
        extra_headers=outbound_headers.redact_for_display(stored),
        extra_headers_redacted_keys=sorted(
            n for n in stored if outbound_headers.is_sensitive_name(n)
        ),
        count=len(stored),
    )


@router.get(
    "/subscriptions/{name}/headers",
    response_model=HeadersOut,
)
def get_custom_headers(name: str, p=Depends(require_admin)) -> HeadersOut:
    """Return the current custom-header map for ``name`` (sensitive
    values redacted). Refuses to read across tenants."""
    init_db()
    tenant_id = str(p.get("tenant") or "default")
    with session() as s:
        row = s.execute(
            select(WebhookSubscription).where(WebhookSubscription.name == name)
        ).scalar_one_or_none()
        if row is None or (getattr(row, "tenant_id", None) or "default") != tenant_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"code": "not_found", "reason": "subscription not found"},
            )
        return _headers_out(row)


@router.put(
    "/subscriptions/{name}/headers",
    response_model=HeadersOut,
)
def set_custom_headers(
    name: str,
    body: HeadersIn,
    request: Request,
    dry_run: bool = Query(
        False,
        description=(
            "Validate the proposed header set without persisting it. "
            "Returns the rendered (redacted) view that would be stored."
        ),
    ),
    p=Depends(require_admin),
) -> HeadersOut:
    """Replace the custom-header map for ``name``. Pass ``{}`` to clear.

    Validation: at most ten headers, names must be RFC 7230 tokens,
    reserved framing and ``X-Adherence-*`` are rejected, values may
    not contain CR/LF/NUL, each value <=1 KiB, total <=4 KiB.
    """
    init_db()
    tenant_id = str(p.get("tenant") or "default")
    caller = _caller_id(request, p)
    cleaned = _validate_or_400(body.headers or {})
    with session() as s:
        row = s.execute(
            select(WebhookSubscription).where(WebhookSubscription.name == name)
        ).scalar_one_or_none()
        if row is None or (getattr(row, "tenant_id", None) or "default") != tenant_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"code": "not_found", "reason": "subscription not found"},
            )
        before = outbound_headers.decode(getattr(row, "extra_headers_json", None))
        if dry_run:
            preview = WebhookSubscription(
                name=row.name,
                extra_headers_json=outbound_headers.encode(cleaned),
            )
            return _headers_out(preview)
        row.extra_headers_json = outbound_headers.encode(cleaned)
        row.updated_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        out = _headers_out(row)
    try:
        from adherence_common.admin_audit import record_admin_action
        record_admin_action(
            action="webhook.custom_headers.set",
            principal=p if isinstance(p, dict) else None,
            target=f"webhook_subscription:{name}",
            details={
                "actor": caller,
                "before_names": sorted(before.keys()),
                "after_names": sorted(cleaned.keys()),
                "before_count": len(before),
                "after_count": len(cleaned),
            },
            request_id=getattr(request.state, "request_id", None),
        )
    except Exception:
        pass
    return out
