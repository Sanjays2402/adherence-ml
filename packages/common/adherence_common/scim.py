"""SCIM 2.0 provisioning support.

Enterprise IdPs (Okta, Azure AD / Entra ID, OneLogin, JumpCloud, Google
Workspace via SAML Jackson, etc.) provision and de-provision users into
SaaS apps via SCIM 2.0 (RFC 7643/7644). Without a SCIM endpoint, an
enterprise buyer cannot wire automatic onboarding/offboarding to the
adherence-ml workspace, which is a hard procurement blocker for any deal
with central IT.

This module owns:

* :class:`ScimToken` — one row per ``(tenant_id, name)`` bearer token.
  Tokens are stored as sha256 hashes (mirroring API keys), each row
  tracks ``last_used_at`` and a ``revoked_at`` tombstone so an IdP
  rotation never leaves stale credentials behind.
* :func:`mint_token`, :func:`resolve_token`, :func:`list_tokens`,
  :func:`revoke_token` — token lifecycle used by the SCIM route and the
  admin settings UI.
* SCIM ``User`` projection helpers that map a
  :class:`adherence_common.memberships.WorkspaceMember` row to the SCIM
  JSON shape an IdP expects, including stable ``id`` and ``meta`` blocks.

The HTTP surface lives in :mod:`adherence_api.routes.scim`. Every
provisioning mutation is audit-logged via
:func:`adherence_common.admin_audit.record_admin_action` with the
canonical ``scim.*`` action names so the existing audit UI, SIEM drain,
and retention policy cover SCIM traffic without further work.

The token in the ``Authorization: Bearer ...`` header carries the tenant
binding; SCIM never trusts a tenant claim from the request body. That
guarantees an IdP configured for tenant A cannot provision a user into
tenant B even if it ships the wrong payload.
"""
from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Column, DateTime, Integer, String, UniqueConstraint, select

from adherence_common.db import Base, session
from adherence_common.memberships import MemberView


SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User"
SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse"
SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error"

# Map IdP-side group/role names (best-effort) to the workspace role
# vocabulary already used by memberships and JWTs.
_ROLE_MAP = {
    "admin": "admin",
    "administrator": "admin",
    "owner": "admin",
    "service": "service",
    "member": "service",
    "user": "service",
    "viewer": "viewer",
    "readonly": "viewer",
    "read-only": "viewer",
}
DEFAULT_PROVISIONED_ROLE = "service"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Token table
# ---------------------------------------------------------------------------

class ScimToken(Base):
    """Bearer token an IdP uses to call the SCIM endpoints.

    Unique on ``(tenant_id, name)``. The plaintext token is returned
    exactly once at creation time; only the sha256 hash is persisted.
    """

    __tablename__ = "scim_tokens"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_scim_token_tenant_name"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    name = Column(String(128), nullable=False)
    token_hash = Column(String(64), index=True, nullable=False)
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=_now, nullable=False)
    last_used_at = Column(DateTime, nullable=True, index=True)
    revoked_at = Column(DateTime, nullable=True, index=True)


@dataclass(frozen=True)
class ScimTokenView:
    id: int
    tenant_id: str
    name: str
    created_by: Optional[str]
    created_at: datetime
    last_used_at: Optional[datetime]
    revoked_at: Optional[datetime]


def _to_view(row: ScimToken) -> ScimTokenView:
    return ScimTokenView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        name=str(row.name),
        created_by=row.created_by,
        created_at=row.created_at,
        last_used_at=row.last_used_at,
        revoked_at=row.revoked_at,
    )


def mint_token(
    tenant_id: str,
    name: str,
    *,
    created_by: Optional[str] = None,
) -> tuple[ScimTokenView, str]:
    """Create a new SCIM bearer token. Returns ``(view, plaintext)``."""
    tid = (tenant_id or "default").strip() or "default"
    nm = (name or "").strip()
    if not nm:
        raise ValueError("token name required")
    if len(nm) > 128:
        raise ValueError("token name too long")
    plaintext = "scim_" + secrets.token_urlsafe(32)
    h = _hash_token(plaintext)
    with session() as db:
        existing = db.execute(
            select(ScimToken).where(
                ScimToken.tenant_id == tid, ScimToken.name == nm
            )
        ).scalar_one_or_none()
        if existing is not None:
            raise ValueError(f"scim token named {nm!r} already exists")
        row = ScimToken(
            tenant_id=tid,
            name=nm,
            token_hash=h,
            created_by=(created_by[:128] if created_by else None),
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return _to_view(row), plaintext


def list_tokens(tenant_id: str) -> list[ScimTokenView]:
    tid = (tenant_id or "default").strip() or "default"
    with session() as db:
        rows = db.execute(
            select(ScimToken)
            .where(ScimToken.tenant_id == tid)
            .order_by(ScimToken.created_at.asc())
        ).scalars().all()
    return [_to_view(r) for r in rows]


def revoke_token(tenant_id: str, token_id: int) -> ScimTokenView | None:
    tid = (tenant_id or "default").strip() or "default"
    with session() as db:
        row = db.execute(
            select(ScimToken).where(
                ScimToken.tenant_id == tid, ScimToken.id == int(token_id)
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        if row.revoked_at is None:
            row.revoked_at = _now()
            db.commit()
            db.refresh(row)
        return _to_view(row)


def resolve_token(plaintext: str) -> ScimTokenView | None:
    """Resolve a bearer token to its tenant binding, or None if invalid
    / revoked. Updates ``last_used_at`` on a successful lookup so the
    admin UI can show stale credentials.
    """
    if not plaintext:
        return None
    h = _hash_token(plaintext)
    with session() as db:
        row = db.execute(
            select(ScimToken).where(ScimToken.token_hash == h)
        ).scalar_one_or_none()
        if row is None or row.revoked_at is not None:
            return None
        row.last_used_at = _now()
        db.commit()
        db.refresh(row)
        return _to_view(row)


# ---------------------------------------------------------------------------
# SCIM <-> WorkspaceMember projection
# ---------------------------------------------------------------------------

def map_role_from_scim(payload: dict) -> str:
    """Pick a workspace role from a SCIM ``User`` payload.

    Looks at ``roles[].value`` and ``groups[].display`` (Azure AD ships
    role assignments as group memberships). Falls back to
    ``DEFAULT_PROVISIONED_ROLE`` so a vanilla "create user" call from an
    IdP that does not push role info still lands as a usable member.
    """
    candidates: list[str] = []
    for role in payload.get("roles") or []:
        if isinstance(role, dict):
            v = role.get("value") or role.get("display")
            if v:
                candidates.append(str(v))
    for grp in payload.get("groups") or []:
        if isinstance(grp, dict):
            v = grp.get("display") or grp.get("value")
            if v:
                candidates.append(str(v))
    for c in candidates:
        mapped = _ROLE_MAP.get(c.strip().lower())
        if mapped is not None:
            return mapped
    return DEFAULT_PROVISIONED_ROLE


def primary_email(payload: dict) -> str | None:
    """Pull the email an IdP wants us to use as the canonical identifier.

    Honours SCIM ``userName`` first (most IdPs ship the email there),
    then the primary entry in ``emails[]``, then the first entry.
    """
    user_name = payload.get("userName")
    if isinstance(user_name, str) and "@" in user_name:
        return user_name.strip()
    emails = payload.get("emails") or []
    if isinstance(emails, list):
        for e in emails:
            if isinstance(e, dict) and e.get("primary") and e.get("value"):
                return str(e["value"]).strip()
        for e in emails:
            if isinstance(e, dict) and e.get("value"):
                return str(e["value"]).strip()
    if isinstance(user_name, str) and user_name.strip():
        return user_name.strip()
    return None


def member_to_scim(member: MemberView, *, base_path: str = "/scim/v2/Users") -> dict:
    """Project a :class:`MemberView` into a SCIM 2.0 ``User`` resource."""
    created = member.added_at.isoformat() + "Z" if member.added_at else None
    updated = member.updated_at.isoformat() + "Z" if member.updated_at else None
    return {
        "schemas": [SCIM_USER_SCHEMA],
        "id": str(member.id),
        "externalId": member.subject,
        "userName": member.subject,
        "active": True,
        "emails": [
            {"value": member.subject, "primary": True, "type": "work"}
        ] if "@" in member.subject else [],
        "roles": [{"value": member.role, "primary": True}],
        "meta": {
            "resourceType": "User",
            "created": created,
            "lastModified": updated,
            "location": f"{base_path}/{member.id}",
        },
    }


def scim_error(detail: str, status_code: int, scim_type: str | None = None) -> dict:
    out = {
        "schemas": [SCIM_ERROR_SCHEMA],
        "status": str(status_code),
        "detail": detail,
    }
    if scim_type:
        out["scimType"] = scim_type
    return out
