"""Admin endpoints: token mint, model listing."""
from __future__ import annotations

from adherence_common import api_keys as ak
from adherence_common.admin_audit import list_admin_actions, record_admin_action
from adherence_common.auth import mint_jwt
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import SettingsDep, require_admin
from adherence_api.dry_run import dry_run_response
from adherence_api.routes.admin_mfa import require_admin_mfa

router = APIRouter(prefix="/v1/admin", tags=["admin"])


class TokenRequest(BaseModel):
    subject: str
    role: str = "viewer"
    tenant: str | None = Field(
        None,
        description="Tenant id to embed in the JWT 'tenant' claim. Defaults to deployment default.",
        max_length=64,
    )


class TokenResponse(BaseModel):
    token: str
    expires_in: int


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


@router.post("/token", response_model=TokenResponse)
def mint_token(
    req: TokenRequest,
    settings: SettingsDep,
    request: Request,
    p=Depends(require_admin),
) -> TokenResponse:
    if req.role not in {"admin", "service", "viewer"}:
        record_admin_action(
            action="token.mint", principal=p, target=req.subject,
            details={"role": req.role, "tenant": req.tenant},
            ok=False, error="invalid role", request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid role")
    tok = mint_jwt(req.subject, req.role, settings, tenant=req.tenant)  # type: ignore[arg-type]
    record_admin_action(
        action="token.mint", principal=p, target=req.subject,
        details={
            "role": req.role,
            "tenant": req.tenant or settings.default_tenant,
            "ttl_seconds": settings.jwt_ttl_seconds,
        },
        request_id=_rid(request),
    )
    return TokenResponse(token=tok, expires_in=settings.jwt_ttl_seconds)


@router.get("/models")
def list_models(_p=Depends(require_admin)) -> dict:
    from adherence_models.registry import ModelRegistry
    items = ModelRegistry().list()
    return {"models": [
        {
            "name": i.name,
            "version": i.version,
            "auc": i.metrics.get("auc_calibrated", i.metrics.get("auc", 0.0)),
            "metrics": i.metrics,
            "path": i.path,
        }
        for i in items
    ]}


# ---- API key management ---------------------------------------------------

class APIKeyCreateIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    role: str = Field(..., description="admin | service | viewer")
    scopes: list[str] = Field(default_factory=list)
    note: str | None = Field(None, max_length=512)
    ttl_seconds: int | None = Field(None, ge=60, le=60 * 60 * 24 * 365 * 5)
    tenant_id: str = Field(
        "default", min_length=1, max_length=64,
        description="Tenant the key may operate within. Stamped on every row the key writes.",
    )


class APIKeyCreateOut(BaseModel):
    id: int
    name: str
    role: str
    scopes: list[str]
    tenant_id: str
    key: str = Field(..., description="Plaintext. Shown ONCE. Not recoverable.")
    key_prefix: str
    expires_at: str | None
    created_at: str


class APIKeyOut(BaseModel):
    id: int
    name: str
    role: str
    scopes: list[str]
    tenant_id: str
    key_prefix: str
    note: str | None
    created_by: str | None
    created_at: str
    expires_at: str | None
    revoked_at: str | None
    last_used_at: str | None
    rotated_at: str | None = None
    rotation_count: int = 0
    ip_allowlist: list[str] = Field(default_factory=list)
    rate_limit_capacity: int | None = None
    rate_limit_refill_per_sec: float | None = None


def _key_row_to_out(row) -> APIKeyOut:
    scopes = sorted(s for s in (row.scopes_csv or "") .split(",") if s)
    ip_allowlist = [c for c in (getattr(row, "ip_allowlist_csv", "") or "").split(",") if c]
    cap = getattr(row, "rate_limit_capacity", None)
    refill_raw = getattr(row, "rate_limit_refill_per_sec", None)
    try:
        refill = float(refill_raw) if refill_raw is not None else None
    except (TypeError, ValueError):
        refill = None
    return APIKeyOut(
        id=row.id, name=row.name, role=row.role, scopes=scopes,
        tenant_id=(row.tenant_id or "default"),
        key_prefix=row.key_prefix, note=row.note,
        created_by=row.created_by,
        created_at=row.created_at.isoformat(),
        expires_at=row.expires_at.isoformat() if row.expires_at else None,
        revoked_at=row.revoked_at.isoformat() if row.revoked_at else None,
        last_used_at=row.last_used_at.isoformat() if row.last_used_at else None,
        rotated_at=row.rotated_at.isoformat() if getattr(row, "rotated_at", None) else None,
        rotation_count=int(getattr(row, "rotation_count", 0) or 0),
        ip_allowlist=ip_allowlist,
        rate_limit_capacity=int(cap) if cap is not None else None,
        rate_limit_refill_per_sec=refill,
    )


@router.post("/api-keys", response_model=APIKeyCreateOut, status_code=201)
def create_api_key(
    body: APIKeyCreateIn,
    request: Request,
    p=Depends(require_admin_mfa),
) -> APIKeyCreateOut:
    try:
        plain, row = ak.create_key(
            name=body.name, role=body.role, scopes=body.scopes,
            note=body.note, created_by=p.get("sub"), ttl_seconds=body.ttl_seconds,
            tenant_id=body.tenant_id,
        )
    except ValueError as exc:
        record_admin_action(
            action="api_key.create", principal=p, target=body.name,
            details={"role": body.role, "scopes": body.scopes, "tenant_id": body.tenant_id},
            ok=False, error=str(exc), request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    scopes = sorted(s for s in (row.scopes_csv or "").split(",") if s)
    record_admin_action(
        action="api_key.create", principal=p, target=row.name,
        details={
            "role": row.role, "scopes": scopes,
            "tenant_id": (row.tenant_id or "default"),
            "key_prefix": row.key_prefix,
            "expires_at": row.expires_at.isoformat() if row.expires_at else None,
        },
        request_id=_rid(request),
    )
    return APIKeyCreateOut(
        id=row.id, name=row.name, role=row.role, scopes=scopes,
        tenant_id=(row.tenant_id or "default"),
        key=plain, key_prefix=row.key_prefix,
        expires_at=row.expires_at.isoformat() if row.expires_at else None,
        created_at=row.created_at.isoformat(),
    )


@router.get("/api-keys", response_model=list[APIKeyOut])
def list_api_keys(_p=Depends(require_admin)) -> list[APIKeyOut]:
    return [_key_row_to_out(r) for r in ak.list_keys()]


@router.post("/api-keys/{name}/revoke")
def revoke_api_key(
    name: str,
    request: Request,
    dry_run: bool = Query(
        False,
        description="Preview without revoking. Returns 404 if the key does not exist.",
    ),
    p=Depends(require_admin_mfa),
) -> dict:
    if dry_run:
        match = next((k for k in ak.list_keys() if k.name == name), None)
        if match is None:
            record_admin_action(
                action="api_key.revoke", principal=p, target=name,
                details={"dry_run": True},
                ok=False, error="api key not found", request_id=_rid(request),
            )
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="api key not found")
        already = match.revoked_at is not None
        record_admin_action(
            action="api_key.revoke", principal=p, target=name,
            details={"dry_run": True, "already_revoked": already},
            request_id=_rid(request),
        )
        return dry_run_response(
            would="revoke", name=name, already_revoked=already,
        )
    ok = ak.revoke_key(name, by=p.get("sub"))
    if not ok:
        record_admin_action(
            action="api_key.revoke", principal=p, target=name,
            ok=False, error="api key not found", request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="api key not found")
    record_admin_action(
        action="api_key.revoke", principal=p, target=name,
        request_id=_rid(request),
    )
    return {"revoked": True, "name": name}


# ---- API key rotation ----------------------------------------------------

class APIKeyRotateIn(BaseModel):
    extend_ttl_seconds: int | None = Field(
        None, ge=60, le=60 * 60 * 24 * 365 * 5,
        description=(
            "Optional. If set, the rotated key's ``expires_at`` is reset to "
            "now + extend_ttl_seconds. Omit to leave the existing expiry intact."
        ),
    )


class APIKeyRotateOut(BaseModel):
    name: str
    role: str
    scopes: list[str]
    tenant_id: str
    key: str = Field(..., description="Plaintext. Shown ONCE. Not recoverable.")
    key_prefix: str
    expires_at: str | None
    rotated_at: str
    rotation_count: int


@router.post("/api-keys/{name}/rotate")
def rotate_api_key(
    name: str,
    body: APIKeyRotateIn | None,
    request: Request,
    dry_run: bool = Query(
        False,
        description="Preview without rotating. Returns 404 if the key does not exist, 409 if revoked or expired.",
    ),
    p=Depends(require_admin_mfa),
) -> dict:
    """Rotate the secret on an existing API key in place.

    Identity, role, scopes, tenant, and IP allowlist are preserved so
    downstream RBAC and tenant scoping keep applying without operator
    intervention. The previous secret is invalidated atomically and the
    new plaintext is returned ONCE in the response body.
    """
    extend_ttl = body.extend_ttl_seconds if body else None
    if dry_run:
        match = next((k for k in ak.list_keys() if k.name == name), None)
        if match is None:
            record_admin_action(
                action="api_key.rotate", principal=p, target=name,
                details={"dry_run": True}, ok=False, error="api key not found",
                request_id=_rid(request),
            )
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="api key not found")
        if match.revoked_at is not None:
            record_admin_action(
                action="api_key.rotate", principal=p, target=name,
                details={"dry_run": True}, ok=False, error="key revoked",
                request_id=_rid(request),
            )
            raise HTTPException(status.HTTP_409_CONFLICT, detail="cannot rotate a revoked key")
        record_admin_action(
            action="api_key.rotate", principal=p, target=name,
            details={
                "dry_run": True,
                "current_prefix": match.key_prefix,
                "rotation_count": int(getattr(match, "rotation_count", 0) or 0),
                "extend_ttl_seconds": extend_ttl,
            },
            request_id=_rid(request),
        )
        return dry_run_response(
            would="rotate",
            name=name,
            current_prefix=match.key_prefix,
            current_rotation_count=int(getattr(match, "rotation_count", 0) or 0),
            extend_ttl_seconds=extend_ttl,
        )
    try:
        plain, row = ak.rotate_key(
            name, by=p.get("sub"), extend_ttl_seconds=extend_ttl,
        )
    except LookupError as exc:
        record_admin_action(
            action="api_key.rotate", principal=p, target=name,
            ok=False, error=str(exc), request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="api key not found") from exc
    except ValueError as exc:
        record_admin_action(
            action="api_key.rotate", principal=p, target=name,
            ok=False, error=str(exc), request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    scopes = sorted(s for s in (row.scopes_csv or "").split(",") if s)
    record_admin_action(
        action="api_key.rotate", principal=p, target=row.name,
        details={
            "new_prefix": row.key_prefix,
            "rotation_count": int(row.rotation_count or 0),
            "tenant_id": (row.tenant_id or "default"),
            "role": row.role,
            "scopes": scopes,
            "expires_at": row.expires_at.isoformat() if row.expires_at else None,
        },
        request_id=_rid(request),
    )
    return APIKeyRotateOut(
        name=row.name, role=row.role, scopes=scopes,
        tenant_id=(row.tenant_id or "default"),
        key=plain, key_prefix=row.key_prefix,
        expires_at=row.expires_at.isoformat() if row.expires_at else None,
        rotated_at=row.rotated_at.isoformat(),
        rotation_count=int(row.rotation_count or 0),
    ).model_dump()


# ---- Model rollback -------------------------------------------------------

class RollbackIn(BaseModel):
    to_version: str | None = Field(
        None,
        description="Specific prior version to roll back to. "
                    "Defaults to the second-most-recent registered version.",
    )
    reason: str | None = Field(None, max_length=512)


class RollbackOut(BaseModel):
    name: str
    rolled_back_to: str
    previous_version: str
    notes: str
    artifact_path: str


@router.post("/models/{name}/rollback", response_model=RollbackOut)
def rollback_model(
    name: str,
    body: RollbackIn,
    request: Request,
    p=Depends(require_admin_mfa),
) -> RollbackOut:
    """Revert a model alias to a previously registered version.

    Cheap inverse of promote: re-appends the chosen prior entry so it
    becomes the latest, bumps the version stamp in notes, and busts the
    in-process inference cache so the next /v1/predict call serves the
    rolled-back model.
    """
    from adherence_common.errors import ModelNotFoundError
    from adherence_models.registry import ModelRegistry

    reg = ModelRegistry()
    items = reg.list(name)
    if not items:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            detail=f"no models under {name!r}")
    prev = items[-1].version
    try:
        art = reg.rollback(
            name,
            to_version=body.to_version,
            by=p.get("sub"),
            reason=body.reason,
        )
    except ModelNotFoundError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    # Bust the inference cache so the rollback is immediately effective.
    try:
        from adherence_worker.inference import load_model as _lm
        _lm.cache_clear()
    except Exception:  # pragma: no cover
        pass
    record_admin_action(
        action="model.rollback", principal=p, target=name,
        details={
            "requested_to_version": body.to_version,
            "rolled_back_to": art.version,
            "previous_version": prev,
            "reason": body.reason,
        },
        request_id=_rid(request),
    )
    return RollbackOut(
        name=name,
        rolled_back_to=art.version,
        previous_version=prev,
        notes=art.notes,
        artifact_path=art.path,
    )


# ---- Audit retention -----------------------------------------------------

class RetentionSweepIn(BaseModel):
    ttls_days: dict[str, int] | None = Field(
        None,
        description=(
            "Optional per-table override map. Keys: prediction_audit, "
            "dose_outcomes, webhook_deliveries, idempotency_records."
        ),
    )
    tables: list[str] | None = Field(
        None,
        description="Restrict the sweep to this subset of tables.",
    )
    dry_run: bool = Field(
        False, description="Count candidates without deleting."
    )


class RetentionSweepRow(BaseModel):
    table: str
    cutoff: str
    candidates: int
    deleted: int


class RetentionSweepOut(BaseModel):
    dry_run: bool
    results: list[RetentionSweepRow]


@router.post("/audit/retention", response_model=RetentionSweepOut)
def sweep_retention(
    body: RetentionSweepIn,
    request: Request,
    p=Depends(require_admin_mfa),
) -> RetentionSweepOut:
    """Delete rows past TTL across audit / outcome / delivery tables.

    Run this from cron or trigger ad-hoc before a backup window. Use
    ``dry_run=true`` first on a new deployment to see candidate volume.
    """
    from adherence_common import retention
    try:
        rows = retention.sweep(
            ttls_days=body.ttls_days,
            tables=body.tables,
            dry_run=body.dry_run,
        )
    except ValueError as exc:
        record_admin_action(
            action="retention.sweep", principal=p, target=None,
            details={"ttls_days": body.ttls_days, "tables": body.tables, "dry_run": body.dry_run},
            ok=False, error=str(exc), request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    record_admin_action(
        action="retention.sweep", principal=p, target=None,
        details={
            "ttls_days": body.ttls_days,
            "tables": body.tables,
            "dry_run": body.dry_run,
            "results": [
                {"table": r.table, "candidates": r.candidates, "deleted": r.deleted}
                for r in rows
            ],
        },
        request_id=_rid(request),
    )
    return RetentionSweepOut(
        dry_run=body.dry_run,
        results=[
            RetentionSweepRow(
                table=r.table,
                cutoff=r.cutoff.isoformat(),
                candidates=r.candidates,
                deleted=r.deleted,
            )
            for r in rows
        ],
    )


# ---- Admin audit log reader ---------------------------------------------

class AdminAuditRow(BaseModel):
    id: int
    tenant_id: str
    request_id: str | None
    action: str
    target: str | None
    caller: str
    caller_role: str
    ok: bool
    error: str | None
    details: dict | list | str | int | float | bool | None = None
    created_at: str | None


@router.get("/audit/admin", response_model=list[AdminAuditRow])
def read_admin_audit(
    p=Depends(require_admin),
    action: str | None = None,
    caller: str | None = None,
    tenant: str | None = None,
    limit: int = 100,
) -> list[AdminAuditRow]:
    """Return recent admin-plane audit rows for the caller's tenant.

    Admins may pass ``tenant=*`` for a cross-tenant read; any other value
    is honoured as-is. Non-admin roles cannot reach this route (gated by
    ``require_admin``).
    """
    caller_tenant = p.get("tenant") or "default"
    if tenant is None:
        tenant_filter: str | None = caller_tenant
    elif tenant == "*":
        tenant_filter = "*"
    else:
        if tenant != caller_tenant and p.get("role") != "admin":
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail="tenant mismatch")
        tenant_filter = tenant
    rows = list_admin_actions(
        tenant_id=tenant_filter, action=action, caller=caller, limit=limit
    )
    return [AdminAuditRow(**r) for r in rows]


# ---- Per-key IP/CIDR allowlist -------------------------------------------

class APIKeyIpAllowlistIn(BaseModel):
    cidrs: list[str] = Field(
        default_factory=list,
        max_length=64,
        description=(
            "Source IPs or CIDRs (IPv4 or IPv6) this key is allowed to "
            "call from. Empty list clears the restriction."
        ),
    )


class APIKeyIpAllowlistOut(BaseModel):
    name: str
    cidrs: list[str]


@router.get("/api-keys/{name}/ip-allowlist", response_model=APIKeyIpAllowlistOut)
def get_api_key_ip_allowlist(
    name: str,
    p=Depends(require_admin),
) -> APIKeyIpAllowlistOut:
    try:
        cidrs = ak.get_key_ip_allowlist(name)
    except LookupError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return APIKeyIpAllowlistOut(name=name, cidrs=cidrs)


@router.put("/api-keys/{name}/ip-allowlist", response_model=APIKeyIpAllowlistOut)
def put_api_key_ip_allowlist(
    name: str,
    body: APIKeyIpAllowlistIn,
    request: Request,
    p=Depends(require_admin_mfa),
) -> APIKeyIpAllowlistOut:
    """Replace the per-key source IP allowlist.

    Empty list clears the restriction (key may be used from any IP that
    the tenant-level allowlist permits). Each entry is validated as a
    CIDR or bare IP; bare IPs are pinned to /32 or /128.
    """
    try:
        row = ak.set_key_ip_allowlist(name, body.cidrs)
    except LookupError as exc:
        record_admin_action(
            action="api_key.ip_allowlist.set", principal=p, target=name,
            details={"cidrs": body.cidrs}, ok=False, error="not found",
            request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        record_admin_action(
            action="api_key.ip_allowlist.set", principal=p, target=name,
            details={"cidrs": body.cidrs}, ok=False, error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    cidrs = [c for c in (row.ip_allowlist_csv or "").split(",") if c]
    record_admin_action(
        action="api_key.ip_allowlist.set", principal=p, target=name,
        details={"cidrs": cidrs, "count": len(cidrs)},
        request_id=_rid(request),
    )
    return APIKeyIpAllowlistOut(name=name, cidrs=cidrs)


# ---- Per-key rate-limit overrides ---------------------------------------

class APIKeyRateLimitIn(BaseModel):
    capacity: int | None = Field(
        None, ge=1, le=1_000_000,
        description=(
            "Token-bucket capacity for this key. Set both ``capacity`` and "
            "``refill_per_sec`` to install an override. Set both to null to "
            "clear the override and inherit the role-tier default."
        ),
    )
    refill_per_sec: float | None = Field(
        None, gt=0.0, le=100_000.0,
        description="Refill rate in tokens per second.",
    )


class APIKeyRateLimitOut(BaseModel):
    name: str
    capacity: int | None
    refill_per_sec: float | None
    inherited: bool = Field(
        ..., description="True when no per-key override is installed."
    )


@router.get(
    "/api-keys/{name}/rate-limit", response_model=APIKeyRateLimitOut,
)
def get_api_key_rate_limit(
    name: str,
    p=Depends(require_admin),
) -> APIKeyRateLimitOut:
    try:
        cap, refill = ak.get_key_rate_limit(name)
    except LookupError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return APIKeyRateLimitOut(
        name=name,
        capacity=cap,
        refill_per_sec=refill,
        inherited=(cap is None or refill is None),
    )


@router.put(
    "/api-keys/{name}/rate-limit", response_model=APIKeyRateLimitOut,
)
def put_api_key_rate_limit(
    name: str,
    body: APIKeyRateLimitIn,
    request: Request,
    dry_run: bool = Query(
        False,
        description="Preview without persisting. Validates the override.",
    ),
    p=Depends(require_admin_mfa),
) -> APIKeyRateLimitOut:
    """Set or clear the per-key token-bucket override.

    Both fields must be set together to install an override, or both
    cleared (null) to inherit the role-tier defaults. Validated and
    audit-logged. On dry_run=true the request returns what would be
    applied and no row is modified.
    """
    if (body.capacity is None) != (body.refill_per_sec is None):
        record_admin_action(
            action="api_key.rate_limit.set", principal=p, target=name,
            details={
                "capacity": body.capacity,
                "refill_per_sec": body.refill_per_sec,
                "dry_run": dry_run,
            },
            ok=False, error="must set both or clear both",
            request_id=_rid(request),
        )
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="capacity and refill_per_sec must both be set or both null",
        )
    if dry_run:
        try:
            cur_cap, cur_refill = ak.get_key_rate_limit(name)
        except LookupError as exc:
            record_admin_action(
                action="api_key.rate_limit.set", principal=p, target=name,
                details={"dry_run": True}, ok=False, error="not found",
                request_id=_rid(request),
            )
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
        record_admin_action(
            action="api_key.rate_limit.set", principal=p, target=name,
            details={
                "dry_run": True,
                "from": {"capacity": cur_cap, "refill_per_sec": cur_refill},
                "to": {
                    "capacity": body.capacity,
                    "refill_per_sec": body.refill_per_sec,
                },
            },
            request_id=_rid(request),
        )
        return APIKeyRateLimitOut(
            name=name,
            capacity=body.capacity,
            refill_per_sec=body.refill_per_sec,
            inherited=(body.capacity is None),
        )
    try:
        row = ak.set_key_rate_limit(
            name,
            capacity=body.capacity,
            refill_per_sec=body.refill_per_sec,
        )
    except LookupError as exc:
        record_admin_action(
            action="api_key.rate_limit.set", principal=p, target=name,
            details={"capacity": body.capacity, "refill_per_sec": body.refill_per_sec},
            ok=False, error="not found", request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        record_admin_action(
            action="api_key.rate_limit.set", principal=p, target=name,
            details={"capacity": body.capacity, "refill_per_sec": body.refill_per_sec},
            ok=False, error=str(exc), request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    cap = row.rate_limit_capacity
    refill_raw = row.rate_limit_refill_per_sec
    refill = float(refill_raw) if refill_raw is not None else None
    record_admin_action(
        action="api_key.rate_limit.set", principal=p, target=name,
        details={
            "capacity": int(cap) if cap is not None else None,
            "refill_per_sec": refill,
            "cleared": cap is None,
        },
        request_id=_rid(request),
    )
    return APIKeyRateLimitOut(
        name=name,
        capacity=int(cap) if cap is not None else None,
        refill_per_sec=refill,
        inherited=(cap is None),
    )
