"""Quota enforcement helpers + headers."""
from __future__ import annotations

from fastapi import HTTPException, Response, status

from adherence_common.logging import get_logger
from adherence_common.quota import QuotaDecision, check_and_consume

log = get_logger(__name__)


def _apply_headers(resp_or_headers, d: QuotaDecision) -> None:
    h = resp_or_headers.headers if isinstance(resp_or_headers, Response) else resp_or_headers
    h["X-RateLimit-Limit"] = str(d.limit)
    h["X-RateLimit-Remaining"] = str(max(0, d.remaining))
    h["X-RateLimit-Reset"] = str(int(d.reset_at.timestamp()))
    h["X-Quota-Plan"] = d.plan
    h["X-Quota-Used"] = str(d.used)


def enforce_prediction_quota(
    tenant_id: str,
    response: Response,
    *,
    cost: int = 1,
) -> QuotaDecision:
    """Reserve ``cost`` predictions for ``tenant_id`` or raise 429.

    On allow: sets X-RateLimit-* headers on ``response`` and returns the
    decision. On block: raises HTTPException(429) with Retry-After and
    the same headers so the response body is consistent.
    """
    decision = check_and_consume(tenant_id, cost=cost)
    if not decision.allowed:
        log.warning(
            "quota_exceeded",
            tenant_id=tenant_id, plan=decision.plan,
            used=decision.used, limit=decision.limit,
            retry_after=decision.retry_after,
        )
        headers = {
            "Retry-After": str(decision.retry_after),
            "X-RateLimit-Limit": str(decision.limit),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": str(int(decision.reset_at.timestamp())),
            "X-Quota-Plan": decision.plan,
            "X-Quota-Used": str(decision.used),
        }
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "error": "quota_exceeded",
                "plan": decision.plan,
                "limit": decision.limit,
                "used": decision.used,
                "resets_at": decision.reset_at.isoformat(),
            },
            headers=headers,
        )
    _apply_headers(response, decision)
    return decision
