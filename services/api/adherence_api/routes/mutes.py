"""/v1/users/{user_id}/mute: set, clear, inspect per-user intervention mutes.

A mute pauses outbound intervention delivery for a user without removing
predictions or other endpoints. Admins can list all currently active
mutes for ops review.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import require_admin, require_service
from adherence_api.dry_run import dry_run_response
from adherence_common import mutes as mutes_mod
from adherence_common.admin_audit import record_admin_action


def _rid(request: Request) -> str | None:
    return getattr(request.state, "request_id", None)

router = APIRouter(prefix="/v1", tags=["mutes"])


class MuteIn(BaseModel):
    duration_minutes: int = Field(..., ge=1, le=60 * 24 * 90)
    reason: str | None = Field(None, max_length=512)


class MuteOut(BaseModel):
    user_id: str
    muted_until: str
    reason: str | None
    set_by: str | None
    active: bool


def _to_out(st) -> MuteOut:
    return MuteOut(
        user_id=st.user_id,
        muted_until=st.muted_until.isoformat(),
        reason=st.reason,
        set_by=st.set_by,
        active=st.active,
    )


@router.put("/users/{user_id}/mute", response_model=MuteOut)
def set_mute(
    user_id: str,
    body: MuteIn,
    request: Request,
    p=Depends(require_service),
) -> MuteOut:
    try:
        st = mutes_mod.set_mute(
            user_id,
            duration_minutes=body.duration_minutes,
            reason=body.reason,
            set_by=p.get("sub"),
        )
    except ValueError as exc:
        record_admin_action(
            action="user.mute.set",
            principal=p,
            target=user_id,
            details={
                "duration_minutes": body.duration_minutes,
                "reason": body.reason,
            },
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc))
    record_admin_action(
        action="user.mute.set",
        principal=p,
        target=user_id,
        details={
            "duration_minutes": body.duration_minutes,
            "reason": body.reason,
            "muted_until": st.muted_until.isoformat(),
        },
        request_id=_rid(request),
    )
    return _to_out(st)


@router.delete("/users/{user_id}/mute")
def clear_mute(
    user_id: str,
    request: Request,
    dry_run: bool = Query(
        False,
        description="Preview without clearing. Returns 404 if no mute exists.",
    ),
    p=Depends(require_service),
) -> dict:
    if dry_run:
        existing = mutes_mod.get_mute(user_id)
        if existing is None or not existing.active:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no mute set")
        record_admin_action(
            action="user.mute.clear",
            principal=p,
            target=user_id,
            details={"dry_run": True},
            request_id=_rid(request),
        )
        return dry_run_response(would="clear", user_id=user_id)
    cleared = mutes_mod.clear_mute(user_id)
    if not cleared:
        record_admin_action(
            action="user.mute.clear",
            principal=p,
            target=user_id,
            ok=False,
            error="no mute set",
            request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no mute set")
    record_admin_action(
        action="user.mute.clear",
        principal=p,
        target=user_id,
        request_id=_rid(request),
    )
    return {"cleared": True, "user_id": user_id}


@router.get("/users/{user_id}/mute", response_model=MuteOut | None)
def get_mute(user_id: str, _p=Depends(require_service)) -> MuteOut | None:
    st = mutes_mod.get_mute(user_id)
    if st is None:
        return None
    return _to_out(st)


@router.get("/admin/mutes", response_model=list[MuteOut])
def list_active_mutes(_p=Depends(require_admin)) -> list[MuteOut]:
    return [_to_out(s) for s in mutes_mod.list_active()]
