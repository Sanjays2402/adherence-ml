"""Tests for per-tenant GDPR Art. 30 Record of Processing Activities.

Covers:

* Create / list / update / archive round trip with audit-friendly
  fields populated and a monotonic version bump on every update.
* The cross-tenant isolation guarantee: entries belonging to tenant A
  are invisible to tenant B, an update from tenant B targeting tenant
  A's entry id is a no-op (returns None), and an archive from tenant B
  is the same. This is the multi-tenancy gate that procurement cares
  about.
* Validation: short purpose, unknown lawful basis, duplicate active
  name within the same tenant.
"""
from __future__ import annotations

import os
import tempfile

import pytest

_TMP = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP.close()
os.environ["ADHERENCE_DB_URL"] = f"sqlite:///{_TMP.name}"
os.environ.setdefault("JWT_SECRET", "x" * 32)

from sqlalchemy import delete  # noqa: E402

from adherence_common import ropa as ropa_mod  # noqa: E402
from adherence_common.ropa import RopaEntry  # noqa: E402
from adherence_common.db import init_db, session  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh():
    init_db()
    with session() as s:
        s.execute(delete(RopaEntry))
        s.commit()
    yield
    with session() as s:
        s.execute(delete(RopaEntry))
        s.commit()


# ---------------------------------------------------------------------------
# Module-level behaviour
# ---------------------------------------------------------------------------


def test_empty_register():
    assert ropa_mod.list_entries(tenant_id="acme") == []


def test_create_list_update_archive_round_trip():
    v = ropa_mod.create_entry(
        tenant_id="acme",
        name="Adherence risk scoring",
        purpose="Compute medication adherence risk to support clinician outreach.",
        lawful_basis="legitimate_interests",
        created_by="root@acme",
        data_subjects="patients enrolled in adherence program",
        data_categories="dose history, demographics",
        recipients="internal care coordinators",
        retention="36 months from last dose event",
        security_measures="encryption at rest, row-level tenant scoping",
    )
    assert v.active is True
    assert v.version == 1
    assert v.created_by == "root@acme"

    listed = ropa_mod.list_entries(tenant_id="acme")
    assert len(listed) == 1 and listed[0].id == v.id

    updated = ropa_mod.update_entry(
        tenant_id="acme",
        entry_id=v.id,
        updated_by="legal@acme",
        purpose="Compute medication adherence risk for clinician outreach and reporting.",
    )
    assert updated is not None
    assert updated.version == 2
    assert updated.updated_by == "legal@acme"

    archived = ropa_mod.archive_entry(
        tenant_id="acme", entry_id=v.id, archived_by="root@acme"
    )
    assert archived is not None
    assert archived.active is False

    # Default listing hides archived rows.
    assert ropa_mod.list_entries(tenant_id="acme") == []
    assert len(ropa_mod.list_entries(tenant_id="acme", include_archived=True)) == 1


def test_purpose_validation():
    with pytest.raises(ropa_mod.RopaError):
        ropa_mod.create_entry(
            tenant_id="acme",
            name="X",
            purpose="too short",
            lawful_basis="contract",
            created_by="x",
        )


def test_unknown_lawful_basis_rejected():
    with pytest.raises(ropa_mod.RopaError):
        ropa_mod.create_entry(
            tenant_id="acme",
            name="Some processing activity",
            purpose="A perfectly fine purpose description for testing inputs.",
            lawful_basis="vibes",
            created_by="x",
        )


def test_duplicate_active_name_within_tenant_rejected():
    ropa_mod.create_entry(
        tenant_id="acme",
        name="Adherence risk scoring",
        purpose="Compute medication adherence risk for clinician outreach.",
        lawful_basis="contract",
        created_by="x",
    )
    with pytest.raises(ropa_mod.RopaError):
        ropa_mod.create_entry(
            tenant_id="acme",
            name="Adherence risk scoring",
            purpose="Compute medication adherence risk for clinician outreach.",
            lawful_basis="contract",
            created_by="x",
        )


def test_cross_tenant_isolation():
    """Tenant B must not be able to see, update, or archive tenant A's entry."""
    a = ropa_mod.create_entry(
        tenant_id="acme",
        name="Tenant A processing",
        purpose="A is processing personal data for its own purposes only.",
        lawful_basis="contract",
        created_by="root@acme",
    )

    # Tenant B sees nothing.
    assert ropa_mod.list_entries(tenant_id="globex") == []
    assert ropa_mod.get_entry(tenant_id="globex", entry_id=a.id) is None

    # Tenant B cannot update tenant A's row.
    assert ropa_mod.update_entry(
        tenant_id="globex",
        entry_id=a.id,
        updated_by="attacker@globex",
        purpose="An attempted cross-tenant rewrite that must be rejected.",
    ) is None

    # Tenant B cannot archive tenant A's row.
    assert ropa_mod.archive_entry(
        tenant_id="globex", entry_id=a.id, archived_by="attacker@globex"
    ) is None

    # Tenant A's row is unchanged and still active.
    after = ropa_mod.get_entry(tenant_id="acme", entry_id=a.id)
    assert after is not None
    assert after.active is True
    assert after.version == 1
    assert after.purpose.startswith("A is processing")


def test_same_name_allowed_across_tenants():
    ropa_mod.create_entry(
        tenant_id="acme",
        name="Adherence risk scoring",
        purpose="A processes adherence risk for its own customers.",
        lawful_basis="contract",
        created_by="x",
    )
    # Same name, different tenant must be allowed.
    other = ropa_mod.create_entry(
        tenant_id="globex",
        name="Adherence risk scoring",
        purpose="B processes adherence risk for its own customers.",
        lawful_basis="contract",
        created_by="y",
    )
    assert other.tenant_id == "globex"
