"""SCIM 2.0 provisioning endpoints (RFC 7644 subset).

Exposes the minimum surface an IdP needs to provision and de-provision
users into the caller's workspace:

* ``GET    /scim/v2/ServiceProviderConfig`` — capability advertisement
* ``GET    /scim/v2/ResourceTypes``         — supported resources
* ``GET    /scim/v2/Schemas``               — schemas in use
* ``GET    /scim/v2/Users``                 — list, filter by userName eq "..."
* ``GET    /scim/v2/Users/{id}``            — fetch one
* ``POST   /scim/v2/Users``                 — create / provision
* ``PUT    /scim/v2/Users/{id}``            — replace
* ``PATCH  /scim/v2/Users/{id}``            — active toggle (deactivate = remove)
* ``DELETE /scim/v2/Users/{id}``            — hard delete

Token management lives at ``/v1/admin/scim/tokens`` so workspace admins
can mint, list, and revoke the bearer credentials they hand to their
IdP. Tokens are tenant-bound: the SCIM endpoints only see the workspace
the presented token belongs to. No SCIM call ever trusts a tenant value
from the URL or body.

Every provisioning mutation is recorded in ``admin_audit_log`` so the
existing audit UI, SIEM drain, and retention policy automatically cover
SCIM activity. Failed authentication is also logged so an IdP that
points at the wrong workspace is visible in the audit trail.
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from adherence_common import memberships as mem
from adherence_common import scim as scim_lib
from adherence_common.admin_audit import record_admin_action

from adherence_api.deps import current_principal, current_tenant, require_admin


SCIM_CONTENT_TYPE = "application/scim+json"

router = APIRouter(tags=["scim"])


# ---------------------------------------------------------------------------
# Auth: SCIM bearer token resolves to a tenant binding
# ---------------------------------------------------------------------------

def _client_ip(request: Request) -> str | None:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else None


def scim_principal(
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict[str, str]:
    """Resolve the SCIM bearer token to a tenant-scoped principal.

    The principal shape mirrors :func:`current_principal` so the audit
    layer treats SCIM and human admins identically.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail=scim_lib.scim_error("missing bearer token", 401),
            headers={"WWW-Authenticate": "Bearer realm=\"scim\""},
        )
    token = authorization.split(" ", 1)[1].strip()
    view = scim_lib.resolve_token(token)
    if view is None:
        # Audit the failure so an IdP misconfig shows up in the trail.
        record_admin_action(
            action="scim.auth.fail",
            principal={"sub": "scim", "role": "service", "tenant": "default"},
            target=None,
            details={"ip": _client_ip(request)},
            ok=False,
            error="invalid_or_revoked_scim_token",
        )
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail=scim_lib.scim_error("invalid or revoked scim token", 401),
            headers={"WWW-Authenticate": "Bearer realm=\"scim\""},
        )
    return {
        "sub": f"scim:{view.name}",
        "role": "admin",
        "tenant": view.tenant_id,
        "scim_token_id": str(view.id),
    }


# ---------------------------------------------------------------------------
# Discovery endpoints (unauthenticated, per RFC 7644 §4)
# ---------------------------------------------------------------------------

@router.get("/scim/v2/ServiceProviderConfig")
def service_provider_config() -> JSONResponse:
    body = {
        "schemas": [
            "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"
        ],
        "documentationUri": "https://datatracker.ietf.org/doc/html/rfc7644",
        "patch": {"supported": True},
        "bulk": {"supported": False, "maxOperations": 0, "maxPayloadSize": 0},
        "filter": {"supported": True, "maxResults": 200},
        "changePassword": {"supported": False},
        "sort": {"supported": False},
        "etag": {"supported": False},
        "authenticationSchemes": [
            {
                "type": "oauthbearertoken",
                "name": "OAuth Bearer Token",
                "description": "Authentication via per-workspace SCIM bearer token.",
                "primary": True,
            }
        ],
    }
    return JSONResponse(body, media_type=SCIM_CONTENT_TYPE)


@router.get("/scim/v2/ResourceTypes")
def resource_types() -> JSONResponse:
    body = {
        "schemas": ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
        "totalResults": 1,
        "Resources": [
            {
                "schemas": [
                    "urn:ietf:params:scim:schemas:core:2.0:ResourceType"
                ],
                "id": "User",
                "name": "User",
                "endpoint": "/Users",
                "description": "User account",
                "schema": scim_lib.SCIM_USER_SCHEMA,
            }
        ],
    }
    return JSONResponse(body, media_type=SCIM_CONTENT_TYPE)


@router.get("/scim/v2/Schemas")
def schemas() -> JSONResponse:
    body = {
        "schemas": ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
        "totalResults": 1,
        "Resources": [
            {
                "id": scim_lib.SCIM_USER_SCHEMA,
                "name": "User",
                "description": "Adherence-ML workspace user",
            }
        ],
    }
    return JSONResponse(body, media_type=SCIM_CONTENT_TYPE)


# ---------------------------------------------------------------------------
# /Users
# ---------------------------------------------------------------------------

def _scim_json(body: dict, status_code: int = 200) -> JSONResponse:
    return JSONResponse(body, status_code=status_code, media_type=SCIM_CONTENT_TYPE)


def _parse_username_filter(filter_str: str) -> str | None:
    """Tiny SCIM filter parser limited to ``userName eq "..."``.

    Okta and Azure AD use exactly this filter to check existence before
    a create. Anything more elaborate falls back to "no match" to keep
    the parser safe and predictable.
    """
    if not filter_str:
        return None
    f = filter_str.strip()
    # case-insensitive on attribute name, value enclosed in double quotes
    lower = f.lower()
    marker = "username eq "
    if not lower.startswith(marker):
        return None
    rest = f[len(marker):].strip()
    if len(rest) < 2 or rest[0] != '"':
        return None
    end = rest.find('"', 1)
    if end <= 1:
        return None
    return rest[1:end]


def _find_member_by_id(tenant_id: str, user_id: str) -> Optional[mem.MemberView]:
    try:
        mid = int(user_id)
    except (TypeError, ValueError):
        return None
    for m in mem.list_members(tenant_id):
        if m.id == mid:
            return m
    return None


@router.get("/scim/v2/Users")
def list_users(
    request: Request,
    principal: dict = Depends(scim_principal),
    filter: str | None = None,
    startIndex: int = 1,
    count: int = 100,
) -> JSONResponse:
    tenant = principal["tenant"]
    members = mem.list_members(tenant)
    if filter:
        target = _parse_username_filter(filter)
        if target is None:
            members = []
        else:
            tl = target.lower()
            members = [m for m in members if m.subject.lower() == tl]
    total = len(members)
    if startIndex < 1:
        startIndex = 1
    if count < 0:
        count = 0
    page = members[startIndex - 1 : startIndex - 1 + count]
    body = {
        "schemas": [scim_lib.SCIM_LIST_SCHEMA],
        "totalResults": total,
        "startIndex": startIndex,
        "itemsPerPage": len(page),
        "Resources": [scim_lib.member_to_scim(m) for m in page],
    }
    return _scim_json(body)


@router.get("/scim/v2/Users/{user_id}")
def get_user(
    user_id: str,
    request: Request,
    principal: dict = Depends(scim_principal),
) -> JSONResponse:
    member = _find_member_by_id(principal["tenant"], user_id)
    if member is None:
        return _scim_json(scim_lib.scim_error("user not found", 404), 404)
    return _scim_json(scim_lib.member_to_scim(member))


@router.post("/scim/v2/Users")
async def create_user(
    request: Request,
    principal: dict = Depends(scim_principal),
) -> JSONResponse:
    try:
        payload = await request.json()
    except Exception:
        return _scim_json(
            scim_lib.scim_error("body must be json", 400, "invalidSyntax"), 400
        )
    if not isinstance(payload, dict):
        return _scim_json(
            scim_lib.scim_error("body must be a json object", 400, "invalidSyntax"),
            400,
        )
    email = scim_lib.primary_email(payload)
    if not email:
        return _scim_json(
            scim_lib.scim_error(
                "userName or primary email required", 400, "invalidValue"
            ),
            400,
        )
    role = scim_lib.map_role_from_scim(payload)
    tenant = principal["tenant"]
    # Reject duplicates: SCIM expects 409 when the user already exists.
    existing = mem.get_member(tenant, email)
    if existing is not None:
        return _scim_json(
            scim_lib.scim_error("user already exists", 409, "uniqueness"), 409
        )
    try:
        member = mem.upsert_member(
            tenant_id=tenant,
            subject=email,
            role=role,
            added_by=principal.get("sub"),
        )
    except ValueError as exc:
        return _scim_json(
            scim_lib.scim_error(str(exc), 400, "invalidValue"), 400
        )
    record_admin_action(
        action="scim.user.create",
        principal=principal,
        target=f"member:{member.id}",
        details={
            "subject": email,
            "role": role,
            "ip": _client_ip(request),
        },
    )
    return _scim_json(scim_lib.member_to_scim(member), 201)


@router.put("/scim/v2/Users/{user_id}")
async def replace_user(
    user_id: str,
    request: Request,
    principal: dict = Depends(scim_principal),
) -> JSONResponse:
    tenant = principal["tenant"]
    member = _find_member_by_id(tenant, user_id)
    if member is None:
        return _scim_json(scim_lib.scim_error("user not found", 404), 404)
    try:
        payload = await request.json()
    except Exception:
        return _scim_json(
            scim_lib.scim_error("body must be json", 400, "invalidSyntax"), 400
        )
    if not isinstance(payload, dict):
        return _scim_json(
            scim_lib.scim_error("body must be a json object", 400, "invalidSyntax"),
            400,
        )
    # Deactivation via PUT active=false is the canonical de-provision
    # path for several IdPs.
    if payload.get("active") is False:
        removed = mem.remove_member(tenant, member.subject)
        record_admin_action(
            action="scim.user.deactivate",
            principal=principal,
            target=f"member:{member.id}",
            details={"subject": member.subject, "ip": _client_ip(request)},
            ok=removed is not None,
        )
        body = scim_lib.member_to_scim(member)
        body["active"] = False
        return _scim_json(body)
    role = scim_lib.map_role_from_scim(payload)
    email = scim_lib.primary_email(payload) or member.subject
    if email.lower() != member.subject.lower():
        return _scim_json(
            scim_lib.scim_error(
                "renaming userName via SCIM is not supported", 400, "mutability"
            ),
            400,
        )
    updated = mem.update_member_role(tenant, member.subject, role)
    if updated is None:
        return _scim_json(scim_lib.scim_error("user not found", 404), 404)
    record_admin_action(
        action="scim.user.replace",
        principal=principal,
        target=f"member:{updated.id}",
        details={
            "subject": updated.subject,
            "old_role": member.role,
            "new_role": updated.role,
            "ip": _client_ip(request),
        },
    )
    return _scim_json(scim_lib.member_to_scim(updated))


@router.patch("/scim/v2/Users/{user_id}")
async def patch_user(
    user_id: str,
    request: Request,
    principal: dict = Depends(scim_principal),
) -> JSONResponse:
    tenant = principal["tenant"]
    member = _find_member_by_id(tenant, user_id)
    if member is None:
        return _scim_json(scim_lib.scim_error("user not found", 404), 404)
    try:
        payload = await request.json()
    except Exception:
        return _scim_json(
            scim_lib.scim_error("body must be json", 400, "invalidSyntax"), 400
        )
    if not isinstance(payload, dict):
        return _scim_json(
            scim_lib.scim_error("body must be a json object", 400, "invalidSyntax"),
            400,
        )
    ops = payload.get("Operations") or []
    if not isinstance(ops, list):
        return _scim_json(
            scim_lib.scim_error("Operations must be a list", 400, "invalidSyntax"),
            400,
        )
    new_role: str | None = None
    deactivate = False
    for op in ops:
        if not isinstance(op, dict):
            continue
        path = (op.get("path") or "").strip().lower()
        value = op.get("value")
        op_name = (op.get("op") or "").strip().lower()
        if op_name not in {"add", "replace", "remove"}:
            continue
        if path == "active":
            if value is False or value == "False" or value == "false":
                deactivate = True
            continue
        if path in {"", "roles", "roles[primary eq true].value"}:
            if isinstance(value, dict):
                mapped = scim_lib.map_role_from_scim(value)
                if mapped:
                    new_role = mapped
            elif isinstance(value, list):
                mapped = scim_lib.map_role_from_scim({"roles": value})
                if mapped:
                    new_role = mapped
            elif isinstance(value, str):
                from adherence_common.scim import _ROLE_MAP  # type: ignore
                mapped = _ROLE_MAP.get(value.strip().lower())
                if mapped:
                    new_role = mapped
    if deactivate:
        removed = mem.remove_member(tenant, member.subject)
        record_admin_action(
            action="scim.user.deactivate",
            principal=principal,
            target=f"member:{member.id}",
            details={"subject": member.subject, "ip": _client_ip(request)},
            ok=removed is not None,
        )
        body = scim_lib.member_to_scim(member)
        body["active"] = False
        return _scim_json(body)
    if new_role and new_role != member.role:
        updated = mem.update_member_role(tenant, member.subject, new_role)
        if updated is None:
            return _scim_json(scim_lib.scim_error("user not found", 404), 404)
        record_admin_action(
            action="scim.user.patch",
            principal=principal,
            target=f"member:{updated.id}",
            details={
                "subject": updated.subject,
                "old_role": member.role,
                "new_role": updated.role,
                "ip": _client_ip(request),
            },
        )
        return _scim_json(scim_lib.member_to_scim(updated))
    return _scim_json(scim_lib.member_to_scim(member))


@router.delete("/scim/v2/Users/{user_id}")
def delete_user(
    user_id: str,
    request: Request,
    principal: dict = Depends(scim_principal),
) -> Response:
    tenant = principal["tenant"]
    member = _find_member_by_id(tenant, user_id)
    if member is None:
        return _scim_json(scim_lib.scim_error("user not found", 404), 404)
    mem.remove_member(tenant, member.subject)
    record_admin_action(
        action="scim.user.delete",
        principal=principal,
        target=f"member:{member.id}",
        details={"subject": member.subject, "ip": _client_ip(request)},
    )
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Token management (workspace admins)
# ---------------------------------------------------------------------------

class ScimTokenCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)


class ScimTokenResponse(BaseModel):
    id: int
    tenant_id: str
    name: str
    created_by: Optional[str] = None
    created_at: str
    last_used_at: Optional[str] = None
    revoked_at: Optional[str] = None


class ScimTokenCreatedResponse(ScimTokenResponse):
    token: str = Field(description="Plaintext bearer token. Shown once.")


def _token_view_to_response(v: scim_lib.ScimTokenView) -> dict:
    return {
        "id": v.id,
        "tenant_id": v.tenant_id,
        "name": v.name,
        "created_by": v.created_by,
        "created_at": v.created_at.isoformat() if v.created_at else "",
        "last_used_at": v.last_used_at.isoformat() if v.last_used_at else None,
        "revoked_at": v.revoked_at.isoformat() if v.revoked_at else None,
    }


@router.get("/v1/admin/scim/tokens")
def list_scim_tokens(
    principal: dict = Depends(require_admin),
    tenant: str = Depends(current_tenant),
):
    rows = scim_lib.list_tokens(tenant)
    return {
        "tenant_id": tenant,
        "count": len(rows),
        "tokens": [_token_view_to_response(r) for r in rows],
    }


@router.post("/v1/admin/scim/tokens", status_code=201)
def create_scim_token(
    body: ScimTokenCreate,
    request: Request,
    principal: dict = Depends(require_admin),
    tenant: str = Depends(current_tenant),
):
    try:
        view, plaintext = scim_lib.mint_token(
            tenant_id=tenant,
            name=body.name,
            created_by=principal.get("sub"),
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc))
    record_admin_action(
        action="scim.token.create",
        principal=principal,
        target=f"scim_token:{view.id}",
        details={"name": view.name, "ip": _client_ip(request)},
    )
    out = _token_view_to_response(view)
    out["token"] = plaintext
    return out


@router.delete("/v1/admin/scim/tokens/{token_id}")
def revoke_scim_token(
    token_id: int,
    request: Request,
    principal: dict = Depends(require_admin),
    tenant: str = Depends(current_tenant),
):
    view = scim_lib.revoke_token(tenant, token_id)
    if view is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="scim token not found")
    record_admin_action(
        action="scim.token.revoke",
        principal=principal,
        target=f"scim_token:{view.id}",
        details={"name": view.name, "ip": _client_ip(request)},
    )
    return _token_view_to_response(view)
