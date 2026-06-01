"""Per-tenant OIDC group claim to role mappings.

Enterprise IdPs (Okta, Azure AD, Google Workspace) provision SaaS access
by group membership rather than per-user assignment. This module stores
those mappings per workspace and resolves the highest-priority role for
an incoming OIDC identity based on the ``groups`` claim it carries.

Resolution is always per-tenant and runs BEFORE the static deployment
``oidc_domain_role_map`` so a workspace owner can grant a group admin
access without changing global config.

Roles are restricted to the same set the rest of the codebase accepts
(``admin`` | ``service`` | ``viewer``). Group claim values are stored as
opaque strings so any IdP convention (display name, group id, full DN)
works as long as the IdP includes it consistently in the claim.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Iterable

from sqlalchemy import delete, select

from adherence_common.db import (
    TenantOidcGroupRoleMap,
    init_db,
    session,
)

VALID_ROLES = frozenset({"admin", "service", "viewer"})
MAX_GROUP_LEN = 255
MAX_NOTE_LEN = 255


@dataclass(frozen=True)
class GroupMapping:
    id: int
    tenant_id: str
    group_claim: str
    role: str
    priority: int
    note: str | None
    created_by: str | None
    created_at: datetime


def _row_to_mapping(row: TenantOidcGroupRoleMap) -> GroupMapping:
    return GroupMapping(
        id=int(row.id),
        tenant_id=str(row.tenant_id or "default"),
        group_claim=str(row.group_claim),
        role=str(row.role),
        priority=int(row.priority or 0),
        note=(str(row.note) if row.note else None),
        created_by=(str(row.created_by) if row.created_by else None),
        created_at=row.created_at,
    )


def list_mappings(tenant_id: str = "default") -> list[GroupMapping]:
    """Return all mappings for a tenant ordered by priority desc, group asc."""
    init_db()
    tid = (tenant_id or "default").strip() or "default"
    with session() as s:
        rows = list(
            s.scalars(
                select(TenantOidcGroupRoleMap)
                .where(TenantOidcGroupRoleMap.tenant_id == tid)
                .order_by(
                    TenantOidcGroupRoleMap.priority.desc(),
                    TenantOidcGroupRoleMap.group_claim.asc(),
                )
            )
        )
        return [_row_to_mapping(r) for r in rows]


def add_mapping(
    *,
    tenant_id: str,
    group_claim: str,
    role: str,
    priority: int = 100,
    note: str | None = None,
    created_by: str | None = None,
) -> GroupMapping:
    """Create a mapping. Raises ValueError on bad input; uniqueness is
    enforced on (tenant_id, group_claim) at the application layer."""
    tid = (tenant_id or "default").strip() or "default"
    g = (group_claim or "").strip()
    r = (role or "").strip()
    if not g:
        raise ValueError("group_claim is required")
    if len(g) > MAX_GROUP_LEN:
        raise ValueError(f"group_claim too long (max {MAX_GROUP_LEN})")
    if r not in VALID_ROLES:
        raise ValueError(f"role must be one of {sorted(VALID_ROLES)}")
    pri = int(priority)
    if pri < 0 or pri > 10_000:
        raise ValueError("priority must be in [0, 10000]")
    n = (note or "").strip() or None
    if n and len(n) > MAX_NOTE_LEN:
        raise ValueError(f"note too long (max {MAX_NOTE_LEN})")
    init_db()
    with session() as s:
        existing = s.execute(
            select(TenantOidcGroupRoleMap).where(
                TenantOidcGroupRoleMap.tenant_id == tid,
                TenantOidcGroupRoleMap.group_claim == g,
            )
        ).scalar_one_or_none()
        if existing is not None:
            raise ValueError(
                f"mapping for group {g!r} in tenant {tid!r} already exists"
            )
        row = TenantOidcGroupRoleMap(
            tenant_id=tid,
            group_claim=g,
            role=r,
            priority=pri,
            note=n,
            created_by=(created_by or None),
            created_at=datetime.utcnow(),
        )
        s.add(row)
        s.commit()
        s.refresh(row)
        return _row_to_mapping(row)


def delete_mapping(mapping_id: int, tenant_id: str = "default") -> bool:
    """Delete a mapping; scoped by tenant so a tenant cannot remove
    another tenant's row. Returns True if a row was removed."""
    init_db()
    tid = (tenant_id or "default").strip() or "default"
    with session() as s:
        row = s.execute(
            select(TenantOidcGroupRoleMap).where(
                TenantOidcGroupRoleMap.id == int(mapping_id),
                TenantOidcGroupRoleMap.tenant_id == tid,
            )
        ).scalar_one_or_none()
        if row is None:
            return False
        s.execute(
            delete(TenantOidcGroupRoleMap).where(
                TenantOidcGroupRoleMap.id == int(mapping_id),
                TenantOidcGroupRoleMap.tenant_id == tid,
            )
        )
        s.commit()
        return True


def extract_groups(raw_claims: dict | None) -> list[str]:
    """Pull a list of group strings out of an OIDC claim set.

    Accepts the common conventions: ``groups`` (Okta, Auth0),
    ``roles`` (Azure AD app roles), ``hd``-prefixed Google Workspace
    groups. Values may be a list of strings, a single string, or a
    comma-separated string. Non-string values are coerced via ``str``.
    Duplicates and blanks are stripped; order is preserved on first
    appearance so the priority resolver sees a stable input.
    """
    if not isinstance(raw_claims, dict):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for key in ("groups", "roles", "wids", "cognito:groups"):
        val = raw_claims.get(key)
        if val is None:
            continue
        items: Iterable
        if isinstance(val, list):
            items = val
        elif isinstance(val, str):
            items = val.split(",") if "," in val else [val]
        else:
            items = [val]
        for item in items:
            s = str(item).strip()
            if not s or s in seen:
                continue
            seen.add(s)
            out.append(s[:MAX_GROUP_LEN])
    return out


def resolve_role_for_groups(
    tenant_id: str, groups: Iterable[str]
) -> tuple[str, GroupMapping] | None:
    """Return the (role, mapping) with the highest priority for an
    identity's group list, or None if no group matches a stored row.

    Ties on priority are broken by mapping ``id`` ascending (oldest
    wins) so the result is deterministic across deployments.
    """
    g_set = {str(g).strip() for g in groups if str(g).strip()}
    if not g_set:
        return None
    init_db()
    tid = (tenant_id or "default").strip() or "default"
    with session() as s:
        rows = list(
            s.scalars(
                select(TenantOidcGroupRoleMap)
                .where(
                    TenantOidcGroupRoleMap.tenant_id == tid,
                    TenantOidcGroupRoleMap.group_claim.in_(g_set),
                )
                .order_by(
                    TenantOidcGroupRoleMap.priority.desc(),
                    TenantOidcGroupRoleMap.id.asc(),
                )
            )
        )
        if not rows:
            return None
        winner = rows[0]
        m = _row_to_mapping(winner)
        return m.role, m
