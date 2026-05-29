"""Admin endpoints: token mint, model listing."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from adherence_api.deps import SettingsDep, require_admin
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
