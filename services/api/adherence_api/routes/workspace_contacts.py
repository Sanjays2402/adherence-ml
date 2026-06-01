"""/v1/workspace/contacts: per-workspace notification contact roles.

Admin-only and tenant-scoped. Mutations are audit-logged with a
before / after diff and support ``?dry_run=true`` so an enterprise IT
team can preview a rotation before applying it.

Roles are a closed enum (see ``ROLES`` in
``adherence_common.workspace_contacts``). Any role not overridden by
this workspace inherits the operator default exposed via
``/.well-known/security.txt``.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from adherence_api.deps import require_admin, require_viewer
from adherence_api.dry_run import dry_run_response
from adherence_common import workspace_contacts as wc
from adherence_common.admin_audit import record_admin_action

router = APIRouter(prefix="/v1/workspace/contacts", tags=["workspace"])


class ContactOut(BaseModel):
    role: str
    email: str
    label: str | None
    updated_by: str | None
    updated_at: str
    source: str
    description: str


class ContactsListOut(BaseModel):
    tenant_id: str
    roles: list[str]
    contacts: list[ContactOut]


class SetContactIn(BaseModel):
    email: str = Field(..., min_length=3, max_length=320)
    label: str | None = Field(None, max_length=80)


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _view_to_out(v: wc.ContactView) -> ContactOut:
    return ContactOut(
        role=v.role,
        email=v.email,
        label=v.label,
        updated_by=v.updated_by,
        updated_at=v.updated_at,
        source=v.source,
        description=wc.ROLE_DESCRIPTIONS.get(v.role, ""),
    )


@router.get("", response_model=ContactsListOut)
def list_contacts(p=Depends(require_viewer)) -> ContactsListOut:
    tid = str(p.get("tenant") or "default")
    views = wc.list_contacts(tid)
    return ContactsListOut(
        tenant_id=tid,
        roles=list(wc.ROLES),
        contacts=[_view_to_out(v) for v in views],
    )


@router.get("/security.txt", response_class=PlainTextResponse)
def workspace_security_txt(p=Depends(require_viewer)) -> PlainTextResponse:
    """Render the effective contact card as RFC 9116 style text.

    Useful for a buyer's IT team to confirm where breach and abuse
    mail would actually land. Viewer-readable so non-admin reviewers
    can audit without write access.
    """
    tid = str(p.get("tenant") or "default")
    body = "\n".join(wc.security_txt_lines(tid)) + "\n"
    return PlainTextResponse(body, media_type="text/plain; charset=utf-8")


@router.get("/{role}", response_model=ContactOut)
def get_contact(role: str, p=Depends(require_viewer)) -> ContactOut:
    tid = str(p.get("tenant") or "default")
    try:
        view = wc.get_contact(tid, role)
    except wc.WorkspaceContactError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return _view_to_out(view)


@router.put("/{role}", response_model=ContactOut)
def set_contact(
    role: str,
    body: SetContactIn,
    request: Request,
    dry_run: bool = Query(
        False,
        description="Validate input and report the planned change without writing.",
    ),
    p=Depends(require_admin),
) -> ContactOut:
    tid = str(p.get("tenant") or "default")
    # Normalise + validate up front so dry-run rejects bad input the
    # same way the real call would.
    try:
        r = wc.normalise_role(role)
        email = wc.normalise_email(body.email)
        label = wc.normalise_label(body.label)
    except wc.WorkspaceContactError as exc:
        record_admin_action(
            action="workspace_contact.set",
            principal=p,
            target=role,
            details={"email": body.email, "label": body.label, "dry_run": dry_run},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
            tenant_id=tid,
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    prior = wc.get_contact(tid, r)
    prior_payload = (
        {"role": prior.role, "email": prior.email, "label": prior.label}
        if prior.source == "workspace"
        else None
    )

    if dry_run:
        record_admin_action(
            action="workspace_contact.set",
            principal=p,
            target=r,
            details={
                "dry_run": True,
                "before": prior_payload,
                "after": {"role": r, "email": email, "label": label},
            },
            ok=True,
            request_id=_rid(request),
            tenant_id=tid,
        )
        return ContactOut(
            role=r,
            email=email,
            label=label,
            updated_by=str(p.get("sub") or "unknown"),
            updated_at="dry-run",
            source="workspace",
            description=wc.ROLE_DESCRIPTIONS.get(r, ""),
        )

    try:
        result = wc.set_contact(
            tenant_id=tid,
            role=r,
            email=email,
            label=label,
            updated_by=str(p.get("sub") or "unknown"),
        )
    except wc.WorkspaceContactError as exc:
        record_admin_action(
            action="workspace_contact.set",
            principal=p,
            target=r,
            details={"email": email, "label": label},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
            tenant_id=tid,
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    record_admin_action(
        action="workspace_contact.set",
        principal=p,
        target=r,
        details={
            "created": result.created,
            "before": result.before,
            "after": {
                "role": result.view.role,
                "email": result.view.email,
                "label": result.view.label,
            },
        },
        ok=True,
        request_id=_rid(request),
        tenant_id=tid,
    )
    return _view_to_out(result.view)


@router.delete("/{role}")
def delete_contact(
    role: str,
    request: Request,
    dry_run: bool = Query(
        False,
        description="Report which override would be removed without writing.",
    ),
    p=Depends(require_admin),
) -> dict:
    tid = str(p.get("tenant") or "default")
    try:
        r = wc.normalise_role(role)
    except wc.WorkspaceContactError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    current = wc.get_contact(tid, r)
    if current.source != "workspace":
        # No override exists; mirror invite-policy 404 behaviour so
        # dry-run signals the absence the same way.
        record_admin_action(
            action="workspace_contact.delete",
            principal=p,
            target=r,
            details={"dry_run": dry_run},
            ok=False,
            error="no workspace override",
            request_id=_rid(request),
            tenant_id=tid,
        )
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail="no workspace override for this role",
        )

    if dry_run:
        record_admin_action(
            action="workspace_contact.delete",
            principal=p,
            target=r,
            details={
                "dry_run": True,
                "before": {"role": current.role, "email": current.email, "label": current.label},
                "would_revert_to": wc.OPERATOR_DEFAULTS[r],
            },
            ok=True,
            request_id=_rid(request),
            tenant_id=tid,
        )
        return dry_run_response(
            would="delete",
            role=r,
            current_email=current.email,
            reverts_to=wc.OPERATOR_DEFAULTS[r],
        )

    result = wc.delete_contact(tenant_id=tid, role=r)
    record_admin_action(
        action="workspace_contact.delete",
        principal=p,
        target=r,
        details={
            "before": result.before,
            "reverted_to": wc.OPERATOR_DEFAULTS[r],
        },
        ok=True,
        request_id=_rid(request),
        tenant_id=tid,
    )
    return {
        "deleted": True,
        "role": r,
        "reverted_to": wc.OPERATOR_DEFAULTS[r],
    }
