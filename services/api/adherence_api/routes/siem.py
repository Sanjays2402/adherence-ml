"""/v1/admin/siem: per-tenant SIEM audit drain configuration and delivery log.

Admin-only and tenant-scoped. Every read and mutation is bound to the
caller's own tenant: there is no cross-tenant surface. Every mutation
is recorded in the admin audit log. The drain ships subsequent audit
events to the configured HTTPS endpoint with an HMAC-SHA256 signature
in ``X-Adherence-Signature``.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import require_admin
from adherence_api.dry_run import dry_run_response
from adherence_common import siem
from adherence_common.admin_audit import record_admin_action

router = APIRouter(prefix="/v1/admin/siem", tags=["admin"])


class DrainOut(BaseModel):
    tenant_id: str
    url: str
    enabled: bool
    secret_preview: str
    # secret is never returned in full


class DrainPutIn(BaseModel):
    url: str = Field(..., min_length=1, max_length=siem.MAX_URL_LEN)
    secret: str = Field(..., min_length=16, max_length=siem.MAX_SECRET_LEN)
    enabled: bool = True


class DrainPatchIn(BaseModel):
    enabled: bool


class DeliveryOut(BaseModel):
    id: int
    tenant_id: str
    event_type: str
    audit_id: int | None
    request_id: str | None
    url: str
    status: str
    http_code: int | None
    attempts: int
    duration_ms: int | None
    response_snippet: str | None
    error: str | None
    created_at: str | None


class DeliveryDetailOut(DeliveryOut):
    payload: str


class DeliveryListOut(BaseModel):
    tenant_id: str
    n: int
    items: list[DeliveryOut]


class StatsOut(BaseModel):
    tenant_id: str
    configured: bool
    enabled: bool
    n_total: int
    n_ok: int
    n_failed: int


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _secret_preview(secret: str) -> str:
    if not secret:
        return ""
    if len(secret) <= 8:
        return "***"
    return secret[:4] + "***" + secret[-2:]


def _drain_out(d: siem.DrainConfig) -> DrainOut:
    return DrainOut(
        tenant_id=d.tenant_id,
        url=d.url,
        enabled=d.enabled,
        secret_preview=_secret_preview(d.secret),
    )


@router.get("", response_model=DrainOut | None)
def get_drain(p=Depends(require_admin)) -> DrainOut | None:
    tid = str(p.get("tenant") or "default")
    cfg = siem.get_drain(tid)
    if cfg is None:
        return None
    return _drain_out(cfg)


@router.put("")
def put_drain(
    body: DrainPutIn,
    request: Request,
    p=Depends(require_admin),
    dry_run: bool = Query(False),
) -> Any:
    tid = str(p.get("tenant") or "default")
    if dry_run:
        return dry_run_response(would="configure", tenant_id=tid, url=body.url)
    try:
        cfg = siem.upsert_drain(
            tenant_id=tid,
            url=body.url,
            secret=body.secret,
            enabled=body.enabled,
            actor=str(p.get("sub") or p.get("key_name") or "unknown"),
        )
    except siem.SiemConfigError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc))
    record_admin_action(
        action="siem.drain.upsert",
        principal=p,
        target=tid,
        details={"url": cfg.url, "enabled": cfg.enabled},
        request_id=_rid(request),
        tenant_id=tid,
    )
    return _drain_out(cfg).model_dump()


@router.patch("", response_model=DrainOut)
def patch_drain(
    body: DrainPatchIn,
    request: Request,
    p=Depends(require_admin),
) -> DrainOut:
    tid = str(p.get("tenant") or "default")
    cur = siem.get_drain(tid)
    if cur is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no drain configured")
    cfg = siem.upsert_drain(
        tenant_id=tid,
        url=cur.url,
        secret=cur.secret,
        enabled=body.enabled,
        actor=str(p.get("sub") or p.get("key_name") or "unknown"),
    )
    record_admin_action(
        action="siem.drain.patch",
        principal=p,
        target=tid,
        details={"enabled": cfg.enabled},
        request_id=_rid(request),
        tenant_id=tid,
    )
    return _drain_out(cfg)


@router.delete("")
def delete_drain(
    request: Request,
    p=Depends(require_admin),
    dry_run: bool = Query(False),
) -> Any:
    tid = str(p.get("tenant") or "default")
    if dry_run:
        return dry_run_response(would="delete", tenant_id=tid)
    deleted = siem.delete_drain(tid)
    record_admin_action(
        action="siem.drain.delete",
        principal=p,
        target=tid,
        details={"deleted": deleted},
        request_id=_rid(request),
        tenant_id=tid,
    )
    from fastapi import Response
    return Response(status_code=204)


@router.get("/stats", response_model=StatsOut)
def drain_stats(p=Depends(require_admin)) -> StatsOut:
    tid = str(p.get("tenant") or "default")
    cfg = siem.get_drain(tid)
    s = siem.stats(tid)
    return StatsOut(
        tenant_id=tid,
        configured=cfg is not None,
        enabled=bool(cfg and cfg.enabled),
        n_total=s["n_total"],
        n_ok=s["n_ok"],
        n_failed=s["n_failed"],
    )


@router.get("/deliveries", response_model=DeliveryListOut)
def list_deliveries(
    p=Depends(require_admin),
    limit: int = Query(100, ge=1, le=500),
    status_filter: str | None = Query(None, alias="status"),
    event_type: str | None = Query(None),
) -> DeliveryListOut:
    tid = str(p.get("tenant") or "default")
    items = siem.list_deliveries(
        tid, limit=limit, status=status_filter, event_type=event_type
    )
    return DeliveryListOut(
        tenant_id=tid,
        n=len(items),
        items=[DeliveryOut(**i) for i in items],
    )


@router.get("/deliveries/{delivery_id}", response_model=DeliveryDetailOut)
def get_delivery(delivery_id: int, p=Depends(require_admin)) -> DeliveryDetailOut:
    tid = str(p.get("tenant") or "default")
    row = siem.get_delivery(tid, delivery_id)
    if row is None:
        # 404 covers both "not found" and "wrong tenant" so we never
        # leak the existence of another tenant's delivery row.
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="delivery not found")
    return DeliveryDetailOut(**row)


class ReplayOut(BaseModel):
    id: int | None
    status: str
    http_code: int | None
    attempts: int
    duration_ms: int | None
    error: str | None


@router.post("/deliveries/{delivery_id}/replay", response_model=ReplayOut)
def replay_delivery(
    delivery_id: int,
    request: Request,
    p=Depends(require_admin),
    dry_run: bool = Query(False),
) -> Any:
    tid = str(p.get("tenant") or "default")
    row = siem.get_delivery(tid, delivery_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="delivery not found")
    if dry_run:
        return dry_run_response(
            would="replay",
            delivery_id=delivery_id,
            event_type=row["event_type"],
        )
    import json

    try:
        event = json.loads(row["payload"])
    except Exception:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="payload not valid json"
        )
    result = siem.deliver_event(
        tenant_id=tid,
        event_type=row["event_type"],
        event=event,
        audit_id=row.get("audit_id"),
        request_id=row.get("request_id"),
    )
    if result is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="no drain configured for tenant"
        )
    record_admin_action(
        action="siem.delivery.replay",
        principal=p,
        target=str(delivery_id),
        details={"status": result.get("status"), "new_id": result.get("id")},
        request_id=_rid(request),
        tenant_id=tid,
    )
    return ReplayOut(
        id=result.get("id"),
        status=str(result.get("status", "")),
        http_code=result.get("http_code"),
        attempts=int(result.get("attempts", 0) or 0),
        duration_ms=result.get("duration_ms"),
        error=result.get("error"),
    )


class TestFireIn(BaseModel):
    message: str | None = Field(None, max_length=512)


@router.post("/test", response_model=ReplayOut)
def test_fire(
    body: TestFireIn,
    request: Request,
    p=Depends(require_admin),
) -> ReplayOut:
    tid = str(p.get("tenant") or "default")
    event = {
        "event": "audit.test",
        "tenant_id": tid,
        "actor": str(p.get("sub") or p.get("key_name") or "unknown"),
        "request_id": _rid(request),
        "message": body.message or "test",
    }
    result = siem.deliver_event(
        tenant_id=tid,
        event_type="audit.test",
        event=event,
        request_id=_rid(request),
    )
    if result is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="no drain configured for tenant"
        )
    record_admin_action(
        action="siem.drain.test",
        principal=p,
        target=tid,
        details={"status": result.get("status")},
        request_id=_rid(request),
        tenant_id=tid,
    )
    return ReplayOut(
        id=result.get("id"),
        status=str(result.get("status", "")),
        http_code=result.get("http_code"),
        attempts=int(result.get("attempts", 0) or 0),
        duration_ms=result.get("duration_ms"),
        error=result.get("error"),
    )
