"""Admin session revocation endpoints.

Lets a workspace admin invalidate JWTs without waiting for ``exp``.
Two flows are supported:

* ``POST /v1/admin/sessions/revoke``: revoke a single token by ``jti``
  (returned to clients in the ``jti`` claim of every JWT, and surfaced in
  the admin console).
* ``POST /v1/admin/sessions/revoke-all``: revoke every outstanding JWT
  for a principal, optionally scoped to a tenant. The new "min issued
  at" cutoff defaults to the moment the request is processed.

Both are admin-only, MFA-gated (matching the rest of the admin mutation
surface), and persisted via ``record_admin_action`` so SOC2 reviewers can
trace who killed which session and why.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from adherence_api.deps import require_admin, require_tenant_access
from adherence_api.routes.admin_mfa import require_admin_mfa
from adherence_common.admin_audit import record_admin_action
from adherence_common.revocation import revoke_all_for, revoke_jti

router = APIRouter(prefix="/v1/admin/sessions", tags=["admin-sessions"])


def _rid(request: Request) -> Optional[str]:
    return getattr(request.state, "request_id", None)


class RevokeJtiIn(BaseModel):
    jti: str = Field(..., min_length=1, max_length=64)
    sub: Optional[str] = Field(None, max_length=128)
    tenant: Optional[str] = Field(None, max_length=64)
    reason: Optional[str] = Field(None, max_length=128)


class RevokeAllIn(BaseModel):
    sub: str = Field(..., min_length=1, max_length=128)
    tenant: Optional[str] = Field(None, max_length=64)
    cutoff_iat: Optional[int] = Field(
        None,
        description=(
            "Unix seconds. Tokens issued at or before this value are "
            "rejected. Defaults to the current request time."
        ),
    )
    reason: Optional[str] = Field(None, max_length=128)


class RevocationOut(BaseModel):
    id: int
    kind: str
    target_jti: Optional[str] = None
    target_sub: Optional[str] = None
    target_tenant: Optional[str] = None
    not_before_iat: Optional[int] = None
    revoked_at: str


@router.post("/revoke", response_model=RevocationOut)
def revoke_one(
    body: RevokeJtiIn,
    request: Request,
    dry_run: bool = False,
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
) -> RevocationOut:
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    if dry_run:
        record_admin_action(
            action="session.revoke", principal=p, target=body.jti,
            details={
                "sub": body.sub, "tenant": body.tenant,
                "reason": body.reason, "dry_run": True,
            },
            request_id=_rid(request),
        )
        return JSONResponse(  # type: ignore[return-value]
            {
                "dry_run": True,
                "would_revoke": True,
                "jti": body.jti,
                "sub": body.sub,
                "tenant": body.tenant,
            }
        )
    try:
        rid = revoke_jti(
            body.jti,
            sub=body.sub,
            tenant=body.tenant,
            reason=body.reason,
            revoked_by=caller,
        )
    except ValueError as exc:
        record_admin_action(
            action="session.revoke", principal=p, target=body.jti,
            details={"sub": body.sub, "tenant": body.tenant, "reason": body.reason},
            ok=False, error=str(exc), request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    record_admin_action(
        action="session.revoke", principal=p, target=body.jti,
        details={"sub": body.sub, "tenant": body.tenant, "reason": body.reason},
        request_id=_rid(request),
    )
    return RevocationOut(
        id=rid,
        kind="jti",
        target_jti=body.jti,
        target_sub=body.sub,
        target_tenant=body.tenant,
        revoked_at=datetime.now(tz=timezone.utc).isoformat(),
    )


@router.post("/revoke-all", response_model=RevocationOut)
def revoke_all(
    body: RevokeAllIn,
    request: Request,
    dry_run: bool = False,
    p=Depends(require_admin),
    _mfa=Depends(require_admin_mfa),
) -> RevocationOut:
    caller = str(p.get("sub") or p.get("key_name") or "unknown")
    # Non-admins cannot cross-tenant; admins can but we still record it.
    if body.tenant:
        require_tenant_access(body.tenant, p)
    if dry_run:
        cutoff = body.cutoff_iat
        if cutoff is None:
            cutoff = int(datetime.now(tz=timezone.utc).timestamp())
        record_admin_action(
            action="session.revoke_all", principal=p, target=body.sub,
            details={
                "tenant": body.tenant,
                "cutoff_iat": cutoff,
                "reason": body.reason,
                "dry_run": True,
            },
            request_id=_rid(request),
        )
        return JSONResponse(  # type: ignore[return-value]
            {
                "dry_run": True,
                "would_revoke_all": True,
                "sub": body.sub,
                "tenant": body.tenant,
                "cutoff_iat": cutoff,
            }
        )
    try:
        rid = revoke_all_for(
            body.sub,
            tenant=body.tenant,
            cutoff_iat=body.cutoff_iat,
            reason=body.reason,
            revoked_by=caller,
        )
    except ValueError as exc:
        record_admin_action(
            action="session.revoke_all", principal=p, target=body.sub,
            details={
                "tenant": body.tenant,
                "cutoff_iat": body.cutoff_iat,
                "reason": body.reason,
            },
            ok=False, error=str(exc), request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    cutoff = body.cutoff_iat
    if cutoff is None:
        cutoff = int(datetime.now(tz=timezone.utc).timestamp())
    record_admin_action(
        action="session.revoke_all", principal=p, target=body.sub,
        details={
            "tenant": body.tenant,
            "cutoff_iat": cutoff,
            "reason": body.reason,
        },
        request_id=_rid(request),
    )
    return RevocationOut(
        id=rid,
        kind="all",
        target_sub=body.sub,
        target_tenant=body.tenant,
        not_before_iat=cutoff,
        revoked_at=datetime.now(tz=timezone.utc).isoformat(),
    )
