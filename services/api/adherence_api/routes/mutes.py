"""/v1/users/{user_id}/mute: set, clear, inspect per-user intervention mutes.

A mute pauses outbound intervention delivery for a user without removing
predictions or other endpoints. Admins can list all currently active
mutes for ops review.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from adherence_api.deps import require_admin, require_service
from adherence_common import mutes as mutes_mod

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
def set_mute(user_id: str, body: MuteIn, p=Depends(require_service)) -> MuteOut:
    try:
        st = mutes_mod.set_mute(
            user_id,
            duration_minutes=body.duration_minutes,
            reason=body.reason,
            set_by=p.get("sub"),
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return _to_out(st)


@router.delete("/users/{user_id}/mute")
def clear_mute(user_id: str, _p=Depends(require_service)) -> dict:
    cleared = mutes_mod.clear_mute(user_id)
    if not cleared:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no mute set")
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
