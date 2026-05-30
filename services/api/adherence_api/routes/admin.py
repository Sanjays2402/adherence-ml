"""Admin endpoints: token mint, model listing."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from adherence_api.deps import SettingsDep, require_admin
from adherence_common import api_keys as ak
from adherence_common.auth import mint_jwt

router = APIRouter(prefix="/v1/admin", tags=["admin"])


class TokenRequest(BaseModel):
    subject: str
    role: str = "viewer"


class TokenResponse(BaseModel):
    token: str
    expires_in: int


@router.post("/token", response_model=TokenResponse)
def mint_token(req: TokenRequest, settings: SettingsDep, _p=Depends(require_admin)) -> TokenResponse:
    if req.role not in {"admin", "service", "viewer"}:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid role")
    tok = mint_jwt(req.subject, req.role, settings)  # type: ignore[arg-type]
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


class APIKeyCreateOut(BaseModel):
    id: int
    name: str
    role: str
    scopes: list[str]
    key: str = Field(..., description="Plaintext. Shown ONCE. Not recoverable.")
    key_prefix: str
    expires_at: str | None
    created_at: str


class APIKeyOut(BaseModel):
    id: int
    name: str
    role: str
    scopes: list[str]
    key_prefix: str
    note: str | None
    created_by: str | None
    created_at: str
    expires_at: str | None
    revoked_at: str | None
    last_used_at: str | None


def _key_row_to_out(row) -> APIKeyOut:
    scopes = sorted(s for s in (row.scopes_csv or "").split(",") if s)
    return APIKeyOut(
        id=row.id, name=row.name, role=row.role, scopes=scopes,
        key_prefix=row.key_prefix, note=row.note,
        created_by=row.created_by,
        created_at=row.created_at.isoformat(),
        expires_at=row.expires_at.isoformat() if row.expires_at else None,
        revoked_at=row.revoked_at.isoformat() if row.revoked_at else None,
        last_used_at=row.last_used_at.isoformat() if row.last_used_at else None,
    )


@router.post("/api-keys", response_model=APIKeyCreateOut, status_code=201)
def create_api_key(body: APIKeyCreateIn, p=Depends(require_admin)) -> APIKeyCreateOut:
    try:
        plain, row = ak.create_key(
            name=body.name, role=body.role, scopes=body.scopes,
            note=body.note, created_by=p.get("sub"), ttl_seconds=body.ttl_seconds,
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc))
    scopes = sorted(s for s in (row.scopes_csv or "").split(",") if s)
    return APIKeyCreateOut(
        id=row.id, name=row.name, role=row.role, scopes=scopes,
        key=plain, key_prefix=row.key_prefix,
        expires_at=row.expires_at.isoformat() if row.expires_at else None,
        created_at=row.created_at.isoformat(),
    )


@router.get("/api-keys", response_model=list[APIKeyOut])
def list_api_keys(_p=Depends(require_admin)) -> list[APIKeyOut]:
    return [_key_row_to_out(r) for r in ak.list_keys()]


@router.post("/api-keys/{name}/revoke")
def revoke_api_key(name: str, p=Depends(require_admin)) -> dict:
    ok = ak.revoke_key(name, by=p.get("sub"))
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="api key not found")
    return {"revoked": True, "name": name}


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
def rollback_model(name: str, body: RollbackIn, p=Depends(require_admin)) -> RollbackOut:
    """Revert a model alias to a previously registered version.

    Cheap inverse of promote: re-appends the chosen prior entry so it
    becomes the latest, bumps the version stamp in notes, and busts the
    in-process inference cache so the next /v1/predict call serves the
    rolled-back model.
    """
    from adherence_models.registry import ModelRegistry
    from adherence_common.errors import ModelNotFoundError

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
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc))
    # Bust the inference cache so the rollback is immediately effective.
    try:
        from adherence_worker.inference import load_model as _lm
        _lm.cache_clear()
    except Exception:  # pragma: no cover
        pass
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
    _p=Depends(require_admin),
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
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc))
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
