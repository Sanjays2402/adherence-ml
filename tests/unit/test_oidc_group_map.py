"""Per-tenant OIDC group claim to role mapping tests.

Exercises the resolver, the priority order, the cross-tenant isolation
guarantee, and the integration with
:func:`adherence_common.oidc.map_identity_to_principal` so a group
claim wins over the static email-domain map.
"""
from __future__ import annotations

import os
import tempfile

import pytest

# Pin the package-level engine cache to a throwaway sqlite file before
# any adherence_common module is imported (mirrors test_ip_allowlist).
_TMP = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP.close()
os.environ["ADHERENCE_DB_URL"] = f"sqlite:///{_TMP.name}"
os.environ.setdefault("JWT_SECRET", "x" * 32)

from adherence_common.db import (  # noqa: E402
    TenantOidcGroupRoleMap,
    init_db,
    session,
)
from sqlalchemy import delete  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_table():
    init_db()
    with session() as s:
        s.execute(delete(TenantOidcGroupRoleMap))
        s.commit()
    yield


def test_add_and_list_mappings_round_trip():
    from adherence_common.oidc_group_map import add_mapping, list_mappings

    add_mapping(
        tenant_id="acme",
        group_claim="okta:adherence-admins",
        role="admin",
        priority=200,
        created_by="owner@acme.com",
    )
    add_mapping(
        tenant_id="acme",
        group_claim="okta:adherence-viewers",
        role="viewer",
        priority=50,
    )
    items = list_mappings("acme")
    # Sorted by priority desc, then group asc.
    assert [m.group_claim for m in items] == [
        "okta:adherence-admins",
        "okta:adherence-viewers",
    ]
    assert items[0].role == "admin"
    assert items[0].priority == 200


def test_add_mapping_rejects_invalid_role():
    from adherence_common.oidc_group_map import add_mapping

    with pytest.raises(ValueError):
        add_mapping(tenant_id="acme", group_claim="g", role="superuser")


def test_add_mapping_rejects_duplicate_within_tenant():
    from adherence_common.oidc_group_map import add_mapping

    add_mapping(tenant_id="acme", group_claim="g1", role="viewer")
    with pytest.raises(ValueError):
        add_mapping(tenant_id="acme", group_claim="g1", role="admin")


def test_cross_tenant_isolation_for_same_group_name():
    """Two tenants may use the same IdP group name but the resolver must
    only return the row stamped with the caller's tenant id."""
    from adherence_common.oidc_group_map import (
        add_mapping,
        resolve_role_for_groups,
    )

    add_mapping(tenant_id="acme", group_claim="engineering", role="admin")
    add_mapping(tenant_id="globex", group_claim="engineering", role="viewer")

    a = resolve_role_for_groups("acme", ["engineering"])
    g = resolve_role_for_groups("globex", ["engineering"])
    assert a is not None and a[0] == "admin" and a[1].tenant_id == "acme"
    assert g is not None and g[0] == "viewer" and g[1].tenant_id == "globex"


def test_cross_tenant_delete_is_a_noop():
    """A tenant must not be able to delete another tenant's row via the
    helper, even if it knows the row id."""
    from adherence_common.oidc_group_map import (
        add_mapping,
        delete_mapping,
        list_mappings,
    )

    row = add_mapping(tenant_id="acme", group_claim="g1", role="admin")
    assert delete_mapping(row.id, tenant_id="globex") is False
    # Row still present in acme.
    assert any(m.id == row.id for m in list_mappings("acme"))
    # Same-tenant delete succeeds.
    assert delete_mapping(row.id, tenant_id="acme") is True
    assert all(m.id != row.id for m in list_mappings("acme"))


def test_resolver_picks_highest_priority_among_matches():
    from adherence_common.oidc_group_map import (
        add_mapping,
        resolve_role_for_groups,
    )

    add_mapping(tenant_id="acme", group_claim="contractors", role="viewer", priority=10)
    add_mapping(tenant_id="acme", group_claim="staff", role="admin", priority=500)
    add_mapping(tenant_id="acme", group_claim="auditors", role="service", priority=200)
    hit = resolve_role_for_groups("acme", ["contractors", "staff", "auditors"])
    assert hit is not None
    assert hit[0] == "admin"
    assert hit[1].group_claim == "staff"


def test_extract_groups_handles_common_claim_shapes():
    from adherence_common.oidc_group_map import extract_groups

    assert extract_groups({"groups": ["a", "b", "a"]}) == ["a", "b"]
    assert extract_groups({"roles": "x,y, z"}) == ["x", "y", "z"]
    assert extract_groups({"groups": "single"}) == ["single"]
    assert extract_groups({"cognito:groups": ["c1"]}) == ["c1"]
    assert extract_groups({}) == []
    assert extract_groups(None) == []  # type: ignore[arg-type]


def test_group_mapping_wins_over_domain_role_map():
    """Integration: an identity whose email-domain map says "viewer" but
    whose group claim is mapped to "admin" must resolve to admin."""
    from adherence_common.oidc import OidcIdentity, map_identity_to_principal
    from adherence_common.oidc_group_map import add_mapping
    from adherence_common.settings import Settings

    settings = Settings(
        jwt_secret="x" * 32,
        oidc_domain_role_map="acme.com:viewer",
        oidc_domain_tenant_map="acme.com:acme",
        oidc_default_role="viewer",
    )
    # Workspace owner promotes the "ops-admins" IdP group to admin role.
    add_mapping(
        tenant_id="acme",
        group_claim="ops-admins",
        role="admin",
        priority=500,
    )

    identity = OidcIdentity(
        sub="u1",
        email="alice@acme.com",
        email_verified=True,
        name="Alice",
        issuer="https://idp.example.com",
        provider="acme",
        raw_claims={"groups": ["ops-admins", "everyone"]},
    )
    role, tenant = map_identity_to_principal(identity, settings)
    assert tenant == "acme"
    assert role == "admin", "group claim should outrank the domain role map"


def test_group_mapping_does_not_leak_across_tenants_at_resolve_time():
    """A group mapped to admin in tenant `acme` must not promote an
    identity routed to tenant `globex`."""
    from adherence_common.oidc import OidcIdentity, map_identity_to_principal
    from adherence_common.oidc_group_map import add_mapping
    from adherence_common.settings import Settings

    settings = Settings(
        jwt_secret="x" * 32,
        oidc_domain_role_map="globex.com:viewer",
        oidc_domain_tenant_map="globex.com:globex",
        oidc_default_role="viewer",
    )
    add_mapping(tenant_id="acme", group_claim="ops-admins", role="admin")

    identity = OidcIdentity(
        sub="u2",
        email="bob@globex.com",
        email_verified=True,
        name="Bob",
        issuer="https://idp.example.com",
        provider="globex",
        raw_claims={"groups": ["ops-admins"]},
    )
    role, tenant = map_identity_to_principal(identity, settings)
    assert tenant == "globex"
    assert role == "viewer", "acme's group mapping must not leak into globex"
