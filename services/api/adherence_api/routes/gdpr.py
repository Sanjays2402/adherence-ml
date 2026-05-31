"""/v1/users/{user_id}/data: GDPR data-subject export and erasure.

* ``GET    /v1/users/{user_id}/data``  returns every row that references
  the user across predictions, audit, outcomes, deliveries, mutes,
  policies, budgets, and experiments. JSON only; large exports are
  streamed by the client (no server-side pagination at this size).
* ``DELETE /v1/users/{user_id}/data``  hard-deletes the same set inside
  a single transaction and returns per-table delete counts.

Both endpoints are gated behind ``require_admin`` because the data
subject's identity verification happens outside this service (e.g. via
the partner med-tracker app). Service principals can request exports on
behalf of a user only if the API key carries the ``gdpr:read`` or
``gdpr:erase`` scope.
"""
from __future__ import annotations

from adherence_common import gdpr as gdpr_mod
from adherence_common.admin_audit import record_admin_action
from adherence_common.logging import get_logger
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel

from adherence_api.deps import current_principal

log = get_logger(__name__)

router = APIRouter(prefix="/v1", tags=["gdpr"])


class ExportResponse(BaseModel):
    user_id: str
    generated_at: str
    counts: dict[str, int]
    tables: dict[str, list[dict]]


class EraseResponse(BaseModel):
    user_id: str
    erased_at: str
    deleted: dict[str, int]
    total: int


def _is_admin(p: dict) -> bool:
    return p.get("role") == "admin"


def _has_scope(p: dict, scope: str) -> bool:
    raw = p.get("scopes", "")
    if not raw:
        # env-keyed principals don't carry scopes; fall back to role gate.
        return False
    return scope in {s for s in raw.split(",") if s}


@router.get("/users/{user_id}/data", response_model=ExportResponse)
def export_user_data(
    user_id: str,
    request: Request,
    p: dict = Depends(current_principal),
) -> ExportResponse:
    if not (_is_admin(p) or _has_scope(p, "gdpr:read")):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="requires admin role or gdpr:read scope",
        )
    try:
        result = gdpr_mod.export_user(user_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    rid = getattr(request.state, "request_id", None)
    log.info(
        "gdpr_export",
        user_id=user_id,
        caller=p.get("sub"),
        role=p.get("role"),
        request_id=rid,
        counts=result.counts,
    )
    return ExportResponse(
        user_id=result.user_id,
        generated_at=result.generated_at,
        counts=result.counts,
        tables=result.tables,
    )


@router.delete("/users/{user_id}/data")
def erase_user_data(
    user_id: str,
    request: Request,
    dry_run: bool = Query(
        False,
        description=(
            "Preview erasure without deleting any rows. Returns per-table "
            "candidate counts and a ``dry_run`` flag. Recommended as a "
            "two-step confirmation flow before hard-delete."
        ),
    ),
    p: dict = Depends(current_principal),
):
    if not (_is_admin(p) or _has_scope(p, "gdpr:erase")):
        record_admin_action(
            action="gdpr.erase", principal=p, target=user_id,
            details={"dry_run": dry_run},
            ok=False, error="forbidden",
            request_id=getattr(request.state, "request_id", None),
        )
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="requires admin role or gdpr:erase scope",
        )
    rid = getattr(request.state, "request_id", None)
    if dry_run:
        try:
            preview = gdpr_mod.export_user(user_id)
        except ValueError as exc:
            record_admin_action(
                action="gdpr.erase", principal=p, target=user_id,
                details={"dry_run": True},
                ok=False, error=str(exc), request_id=rid,
            )
            raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        total = sum(preview.counts.values())
        log.warning(
            "gdpr_erase_preview",
            user_id=user_id, caller=p.get("sub"), role=p.get("role"),
            request_id=rid, candidates=preview.counts, total=total,
        )
        record_admin_action(
            action="gdpr.erase", principal=p, target=user_id,
            details={"dry_run": True, "candidates": preview.counts, "total": total},
            request_id=rid,
        )
        return {
            "dry_run": True,
            "would_erase": True,
            "user_id": user_id,
            "candidates": preview.counts,
            "total": total,
        }
    try:
        result = gdpr_mod.erase_user(user_id)
    except ValueError as exc:
        record_admin_action(
            action="gdpr.erase", principal=p, target=user_id,
            ok=False, error=str(exc),
            request_id=rid,
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    log.warning(
        "gdpr_erase_request",
        user_id=user_id,
        caller=p.get("sub"),
        role=p.get("role"),
        request_id=rid,
        deleted=result.deleted,
        total=result.total,
    )
    record_admin_action(
        action="gdpr.erase", principal=p, target=user_id,
        details={"deleted": result.deleted, "total": result.total},
        request_id=rid,
    )
    return EraseResponse(
        user_id=result.user_id,
        erased_at=result.erased_at,
        deleted=result.deleted,
        total=result.total,
    )
