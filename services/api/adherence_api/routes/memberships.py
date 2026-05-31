"""Workspace membership and invitation API.

Exposes the enterprise self-service flow for onboarding people into a
workspace:

* ``GET    /v1/workspace/members``                — list members in caller's tenant
* ``PATCH  /v1/workspace/members/{subject}``      — change role (admin)
* ``DELETE /v1/workspace/members/{subject}``      — remove member (admin)
* ``GET    /v1/workspace/invitations``            — list invitations (viewer)
* ``POST   /v1/workspace/invitations``            — issue an invite (admin)
* ``DELETE /v1/workspace/invitations/{id}``       — revoke pending invite (admin)
* ``GET    /v1/workspace/invitations/preview``    — anonymous preview by token
* ``POST   /v1/workspace/invitations/accept``     — accept an invite (any authed caller)

Every mutation is recorded in ``admin_audit_log`` with the caller, the
tenant, and a redacted payload. Tenants are strictly scoped: the
``current_tenant`` of the caller is the only workspace they can read or
mutate; admins never get to peek across workspaces through these
endpoints. ``preview`` is the single unauthenticated entry point so a
fresh user can see what they were invited to before signing up.
"""
from __future__ import annotations

from dataclasses import asdict
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
import re

from pydantic import BaseModel, Field, field_validator

_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")

from adherence_common.admin_audit import record_admin_action
from adherence_common import memberships as mem
from adherence_common.memberships import (
    DEFAULT_INVITE_TTL_HOURS,
    DuplicateInvitation,
    InvitationError,
    ROLES,
)

from adherence_api.deps import (
    current_principal,
    current_tenant,
    require_admin,
    require_viewer,
)
from adherence_api.dry_run import dry_run_response

router = APIRouter(prefix="/v1/workspace", tags=["workspace"])


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class MemberResponse(BaseModel):
    id: int
    tenant_id: str
    subject: str
    role: str
    added_by: Optional[str] = None
    added_at: str
    updated_at: str


class MemberListResponse(BaseModel):
    tenant_id: str
    count: int
    members: list[MemberResponse]


class InvitationResponse(BaseModel):
    id: int
    tenant_id: str
    email: str
    role: str
    state: str
    invited_by: Optional[str] = None
    expires_at: str
    created_at: str
    accepted_at: Optional[str] = None
    accepted_by: Optional[str] = None
    revoked_at: Optional[str] = None
    revoked_by: Optional[str] = None


class InvitationListResponse(BaseModel):
    tenant_id: str
    count: int
    invitations: list[InvitationResponse]


class CreateInvitationRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=256)
    role: str = Field("viewer", description="One of admin | service | viewer")

    @field_validator("email")
    @classmethod
    def _check_email(cls, v: str) -> str:
        v = (v or "").strip()
        if not _EMAIL_RE.match(v):
            raise ValueError("invalid email address")
        return v
    ttl_hours: int = Field(
        DEFAULT_INVITE_TTL_HOURS,
        ge=1,
        le=24 * 90,
        description="Hours until the invite expires; default 7 days, max 90.",
    )


class CreateInvitationResponse(BaseModel):
    invitation: InvitationResponse
    token: str = Field(
        ...,
        description=(
            "One-time accept token. Surfaced exactly once at creation; "
            "the server stores only its sha256 hash."
        ),
    )


class AcceptInvitationRequest(BaseModel):
    token: str = Field(..., min_length=8, max_length=256)


class AcceptInvitationResponse(BaseModel):
    invitation: InvitationResponse
    member: MemberResponse


class UpdateMemberRequest(BaseModel):
    role: str = Field(..., description="One of admin | service | viewer")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _iso(value) -> str:
    return value.isoformat() if value is not None else None  # type: ignore[return-value]


def _to_member_resp(view: mem.MemberView) -> MemberResponse:
    return MemberResponse(
        id=view.id,
        tenant_id=view.tenant_id,
        subject=view.subject,
        role=view.role,
        added_by=view.added_by,
        added_at=view.added_at.isoformat(),
        updated_at=view.updated_at.isoformat(),
    )


def _to_invite_resp(view: mem.InvitationView) -> InvitationResponse:
    return InvitationResponse(
        id=view.id,
        tenant_id=view.tenant_id,
        email=view.email,
        role=view.role,
        state=view.state,
        invited_by=view.invited_by,
        expires_at=view.expires_at.isoformat(),
        created_at=view.created_at.isoformat(),
        accepted_at=_iso(view.accepted_at),
        accepted_by=view.accepted_by,
        revoked_at=_iso(view.revoked_at),
        revoked_by=view.revoked_by,
    )


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _principal_subject(p: dict) -> str:
    return str(p.get("sub") or p.get("key_name") or "")


# ---------------------------------------------------------------------------
# Members
# ---------------------------------------------------------------------------

@router.get("/members", response_model=MemberListResponse)
def list_members(
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> MemberListResponse:
    rows = mem.list_members(tenant)
    return MemberListResponse(
        tenant_id=tenant,
        count=len(rows),
        members=[_to_member_resp(r) for r in rows],
    )


@router.patch("/members/{subject}", response_model=MemberResponse)
def update_member(
    subject: str,
    body: UpdateMemberRequest,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
) -> MemberResponse:
    try:
        new_role = mem.normalise_role(body.role)
    except ValueError as exc:
        record_admin_action(
            action="workspace.member.update", principal=p, target=subject,
            details={"requested_role": body.role}, ok=False,
            error=str(exc), request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))

    existing = mem.get_member(tenant, subject)
    if existing is None:
        record_admin_action(
            action="workspace.member.update", principal=p, target=subject,
            details={"role": new_role}, ok=False, error="not found",
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "member not found")
    # Refuse the last-admin demotion: at least one admin must remain.
    if existing.role == "admin" and new_role != "admin" and mem.count_owners(tenant) <= 1:
        record_admin_action(
            action="workspace.member.update", principal=p, target=subject,
            details={"role": new_role, "previous_role": existing.role},
            ok=False, error="cannot demote the last admin",
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "cannot demote the last admin; promote another member first",
        )
    updated = mem.update_member_role(tenant, subject, new_role)
    assert updated is not None
    record_admin_action(
        action="workspace.member.update", principal=p, target=subject,
        details={"role": new_role, "previous_role": existing.role},
        ok=True, request_id=_rid(request), tenant_id=tenant,
    )
    return _to_member_resp(updated)


@router.delete("/members/{subject}", response_model=MemberResponse)
def remove_member(
    subject: str,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
) -> MemberResponse:
    existing = mem.get_member(tenant, subject)
    if existing is None:
        record_admin_action(
            action="workspace.member.remove", principal=p, target=subject,
            details=None, ok=False, error="not found",
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "member not found")
    # Block removing the last admin.
    if existing.role == "admin" and mem.count_owners(tenant) <= 1:
        record_admin_action(
            action="workspace.member.remove", principal=p, target=subject,
            details={"role": existing.role}, ok=False,
            error="cannot remove the last admin",
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "cannot remove the last admin; promote another member first",
        )
    removed = mem.remove_member(tenant, subject)
    assert removed is not None
    record_admin_action(
        action="workspace.member.remove", principal=p, target=subject,
        details={"role": removed.role}, ok=True,
        request_id=_rid(request), tenant_id=tenant,
    )
    return _to_member_resp(removed)


# ---------------------------------------------------------------------------
# Invitations
# ---------------------------------------------------------------------------

@router.get("/invitations", response_model=InvitationListResponse)
def list_invitations(
    include_resolved: bool = Query(False, description="Include accepted, revoked, and expired."),
    tenant: str = Depends(current_tenant),
    _p=Depends(require_viewer),
) -> InvitationListResponse:
    rows = mem.list_invitations(tenant, include_resolved=include_resolved)
    return InvitationListResponse(
        tenant_id=tenant,
        count=len(rows),
        invitations=[_to_invite_resp(r) for r in rows],
    )


@router.post("/invitations", status_code=201)
def create_invitation(
    body: CreateInvitationRequest,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
):
    if request.query_params.get("dry_run", "").lower() in {"true", "1", "yes"}:
        record_admin_action(
            action="workspace.invitation.create", principal=p, target=body.email,
            details={"role": body.role, "ttl_hours": body.ttl_hours, "dry_run": True},
            ok=True, request_id=_rid(request), tenant_id=tenant,
        )
        return dry_run_response(
            would="create",
            resource="workspace_invitation",
            tenant_id=tenant,
            email=body.email,
            role=body.role,
            ttl_hours=body.ttl_hours,
            summary=(
                f"invite {body.email} to workspace {tenant!r} as {body.role!r} "
                f"with a {body.ttl_hours}-hour accept window"
            ),
        )
    try:
        role = mem.normalise_role(body.role)
    except ValueError as exc:
        record_admin_action(
            action="workspace.invitation.create", principal=p, target=body.email,
            details={"role": body.role}, ok=False, error=str(exc),
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    try:
        token, view = mem.create_invitation(
            tenant_id=tenant,
            email=body.email,
            role=role,
            invited_by=_principal_subject(p),
            ttl_hours=body.ttl_hours,
        )
    except DuplicateInvitation as exc:
        record_admin_action(
            action="workspace.invitation.create", principal=p, target=body.email,
            details={"role": role}, ok=False, error="duplicate pending",
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc))
    except ValueError as exc:
        record_admin_action(
            action="workspace.invitation.create", principal=p, target=body.email,
            details={"role": role}, ok=False, error=str(exc),
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    record_admin_action(
        action="workspace.invitation.create", principal=p, target=body.email,
        details={
            "role": role,
            "invitation_id": view.id,
            "expires_at": view.expires_at.isoformat(),
            "ttl_hours": body.ttl_hours,
        },
        ok=True, request_id=_rid(request), tenant_id=tenant,
    )
    return CreateInvitationResponse(
        invitation=_to_invite_resp(view),
        token=token,
    )


@router.delete("/invitations/{invite_id}", response_model=InvitationResponse)
def revoke_invitation(
    invite_id: int,
    request: Request,
    tenant: str = Depends(current_tenant),
    p=Depends(require_admin),
) -> InvitationResponse:
    existing = mem.get_invitation(invite_id, tenant)
    if existing is None:
        record_admin_action(
            action="workspace.invitation.revoke", principal=p,
            target=str(invite_id), details=None, ok=False, error="not found",
            request_id=_rid(request), tenant_id=tenant,
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "invitation not found")
    view = mem.revoke_invitation(invite_id, tenant, _principal_subject(p))
    assert view is not None
    record_admin_action(
        action="workspace.invitation.revoke", principal=p,
        target=str(invite_id),
        details={"email": existing.email, "previous_state": existing.state},
        ok=True, request_id=_rid(request), tenant_id=tenant,
    )
    return _to_invite_resp(view)


class InvitationPreview(BaseModel):
    """Anonymous preview of an invite, safe to render before sign-up."""

    workspace: dict
    email: str
    role: str
    state: str
    expires_at: str


@router.get("/invitations/preview", response_model=InvitationPreview)
def preview_invitation(
    token: str = Query(..., min_length=8, max_length=256),
) -> InvitationPreview:
    """Look up an invite by plaintext token without consuming it.

    Unauthenticated by design so the invitee can render the accept page
    before they have credentials. Returns only the fields needed to
    decide whether to accept; never returns the token hash, inviter
    identity, or other tenant residents.
    """
    view = mem.preview_invitation(token)
    if view is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "invitation not found")
    return InvitationPreview(
        workspace={"id": view.tenant_id, "name": view.tenant_id},
        email=view.email,
        role=view.role,
        state=view.state,
        expires_at=view.expires_at.isoformat(),
    )


@router.post("/invitations/accept", response_model=AcceptInvitationResponse)
def accept_invitation(
    body: AcceptInvitationRequest,
    request: Request,
    p=Depends(current_principal),
) -> AcceptInvitationResponse:
    """Consume an invitation as the calling principal.

    Uses the principal's ``sub`` (JWT subject or API key name) as the
    membership subject. Audit-logged as the *invite's* tenant, not the
    caller's prior tenant: accepting is what binds the caller to the new
    workspace.
    """
    subject = _principal_subject(p)
    expected_email = None
    # JWTs minted from SSO carry the verified email as the subject; we
    # use it as a soft check when it looks email-shaped.
    if "@" in subject:
        expected_email = subject
    try:
        result = mem.accept_invitation(
            body.token, subject=subject, expected_email=expected_email
        )
    except InvitationError as exc:
        record_admin_action(
            action="workspace.invitation.accept", principal=p,
            target=subject, details={"code": exc.code},
            ok=False, error=str(exc), request_id=_rid(request),
        )
        # Map error codes to HTTP status.
        code_status = {
            "not_found": status.HTTP_404_NOT_FOUND,
            "revoked": status.HTTP_410_GONE,
            "expired": status.HTTP_410_GONE,
            "already_accepted": status.HTTP_409_CONFLICT,
            "email_mismatch": status.HTTP_403_FORBIDDEN,
            "subject_required": status.HTTP_401_UNAUTHORIZED,
        }.get(exc.code, status.HTTP_400_BAD_REQUEST)
        raise HTTPException(code_status, detail={"code": exc.code, "message": str(exc)})

    record_admin_action(
        action="workspace.invitation.accept", principal=p,
        target=subject,
        details={
            "invitation_id": result.invitation.id,
            "tenant_id": result.invitation.tenant_id,
            "role": result.member.role,
        },
        ok=True, request_id=_rid(request),
        tenant_id=result.invitation.tenant_id,
    )
    return AcceptInvitationResponse(
        invitation=_to_invite_resp(result.invitation),
        member=_to_member_resp(result.member),
    )
