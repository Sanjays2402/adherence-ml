"""Tests for per-tenant HIPAA BAA register and PHI enforcement.

Covers create / list / update / terminate, cross-tenant isolation,
validation, effective_status window derivation, and the enforcement
state machine including grace windows and expiry.
"""
from __future__ import annotations

import os
import tempfile

import pytest

_TMP = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP.close()
os.environ["ADHERENCE_DB_URL"] = f"sqlite:///{_TMP.name}"
os.environ.setdefault("JWT_SECRET", "x" * 32)

from datetime import date, timedelta  # noqa: E402

from sqlalchemy import delete  # noqa: E402

from adherence_common import baa as baa_mod  # noqa: E402
from adherence_common.baa import BaaEntry, BaaPolicy  # noqa: E402
from adherence_common.db import init_db, session  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh():
    init_db()
    with session() as s:
        s.execute(delete(BaaEntry))
        s.execute(delete(BaaPolicy))
        s.commit()
    yield
    with session() as s:
        s.execute(delete(BaaEntry))
        s.execute(delete(BaaPolicy))
        s.commit()


def test_empty_register():
    assert baa_mod.list_entries(tenant_id="acme") == []
    assert baa_mod.active_count("acme") == 0
    assert baa_mod.has_active("acme") is False
    assert baa_mod.expiring_within("acme", days=30) == 0


def test_create_list_update_terminate_round_trip():
    today = date.today()
    v = baa_mod.create_entry(
        tenant_id="acme",
        counterparty="Mercy Health System",
        document_version="v2.1",
        created_by="dpo@acme",
        status="active",
        effective_on=today - timedelta(days=10),
        expires_on=today + timedelta(days=365),
        breach_notify_hours=48,
        covered_entity_signatory="J. Patel, Privacy Officer",
        business_associate_signatory="S. Liu, COO",
        evidence_url="https://vault.example/contracts/mercy-baa-v2.1.pdf",
        notes="Initial executed agreement.",
    )
    assert v.version == 1
    assert v.status == "active"
    assert v.effective_status == "active"
    assert v.breach_notify_hours == 48

    listed = baa_mod.list_entries(tenant_id="acme")
    assert len(listed) == 1 and listed[0].id == v.id
    assert baa_mod.has_active("acme") is True
    assert baa_mod.active_count("acme") == 1

    updated = baa_mod.update_entry(
        tenant_id="acme",
        entry_id=v.id,
        updated_by="cso@acme",
        breach_notify_hours=24,
        notes="Tightened breach window per security review.",
    )
    assert updated is not None
    assert updated.version == 2
    assert updated.breach_notify_hours == 24

    terminated = baa_mod.terminate_entry(
        tenant_id="acme", entry_id=v.id, terminated_by="cso@acme"
    )
    assert terminated is not None
    assert terminated.status == "terminated"
    assert terminated.effective_status == "terminated"
    assert baa_mod.has_active("acme") is False


def test_cross_tenant_isolation():
    today = date.today()
    a = baa_mod.create_entry(
        tenant_id="acme",
        counterparty="Mercy Health System",
        document_version="v1",
        created_by="dpo@acme",
        status="active",
        effective_on=today - timedelta(days=1),
        expires_on=today + timedelta(days=365),
    )
    assert baa_mod.list_entries(tenant_id="globex") == []
    assert baa_mod.get_entry(tenant_id="globex", entry_id=a.id) is None
    assert (
        baa_mod.update_entry(
            tenant_id="globex",
            entry_id=a.id,
            updated_by="attacker@globex",
            notes="cross-tenant write should not land",
        )
        is None
    )
    assert (
        baa_mod.terminate_entry(
            tenant_id="globex",
            entry_id=a.id,
            terminated_by="attacker@globex",
        )
        is None
    )
    again = baa_mod.get_entry(tenant_id="acme", entry_id=a.id)
    assert again is not None
    assert again.status == "active"
    assert again.notes is None

    baa_mod.set_policy(
        tenant_id="globex",
        require_baa_for_phi=True,
        grace_until=None,
        updated_by="cso@globex",
    )
    st = baa_mod.enforcement_state("globex")
    assert st["has_active_baa"] is False
    assert st["should_block"] is True

    baa_mod.set_policy(
        tenant_id="acme",
        require_baa_for_phi=True,
        grace_until=None,
        updated_by="cso@acme",
    )
    st_a = baa_mod.enforcement_state("acme")
    assert st_a["has_active_baa"] is True
    assert st_a["should_block"] is False


def test_validation_rejects_bad_input():
    with pytest.raises(baa_mod.BaaError):
        baa_mod.create_entry(
            tenant_id="acme",
            counterparty="X",
            document_version="v1",
            created_by="dpo@acme",
        )
    with pytest.raises(baa_mod.BaaError):
        baa_mod.create_entry(
            tenant_id="acme",
            counterparty="Mercy Health System",
            document_version="v1",
            created_by="dpo@acme",
            status="signed-on-a-napkin",
        )
    today = date.today()
    with pytest.raises(baa_mod.BaaError):
        baa_mod.create_entry(
            tenant_id="acme",
            counterparty="Mercy Health System",
            document_version="v1",
            created_by="dpo@acme",
            effective_on=today,
            expires_on=today - timedelta(days=1),
        )
    with pytest.raises(baa_mod.BaaError):
        baa_mod.create_entry(
            tenant_id="acme",
            counterparty="Mercy Health System",
            document_version="v1",
            created_by="dpo@acme",
            breach_notify_hours=0,
        )
    baa_mod.create_entry(
        tenant_id="acme",
        counterparty="Mercy Health System",
        document_version="v1",
        created_by="dpo@acme",
    )
    with pytest.raises(baa_mod.BaaError):
        baa_mod.create_entry(
            tenant_id="acme",
            counterparty="Mercy Health System",
            document_version="v1",
            created_by="dpo@acme",
        )


def test_effective_status_window():
    today = date.today()
    future = baa_mod.create_entry(
        tenant_id="acme",
        counterparty="Mercy Health System",
        document_version="future",
        created_by="dpo@acme",
        status="active",
        effective_on=today + timedelta(days=7),
        expires_on=today + timedelta(days=400),
    )
    assert future.effective_status == "draft"
    past = baa_mod.create_entry(
        tenant_id="acme",
        counterparty="Mercy Health System",
        document_version="past",
        created_by="dpo@acme",
        status="active",
        effective_on=today - timedelta(days=400),
        expires_on=today - timedelta(days=1),
    )
    assert past.effective_status == "expired"
    baa_mod.create_entry(
        tenant_id="acme",
        counterparty="Mercy Health System",
        document_version="now",
        created_by="dpo@acme",
        status="active",
        effective_on=today - timedelta(days=1),
        expires_on=today + timedelta(days=20),
    )
    assert baa_mod.active_count("acme") == 1
    assert baa_mod.expiring_within("acme", days=30) == 1
    assert baa_mod.expiring_within("acme", days=5) == 0


def test_enforcement_state_grace_and_expiry():
    today = date.today()
    st = baa_mod.enforcement_state("acme")
    assert st["should_block"] is False

    baa_mod.set_policy(
        tenant_id="acme",
        require_baa_for_phi=True,
        grace_until=None,
        updated_by="cso@acme",
    )
    st = baa_mod.enforcement_state("acme")
    assert st["should_block"] is True

    baa_mod.set_policy(
        tenant_id="acme",
        require_baa_for_phi=True,
        grace_until=(today + timedelta(days=7)).isoformat(),
        updated_by="cso@acme",
    )
    st = baa_mod.enforcement_state("acme")
    assert st["in_grace"] is True
    assert st["should_block"] is False

    baa_mod.set_policy(
        tenant_id="acme",
        require_baa_for_phi=True,
        grace_until=(today - timedelta(days=1)).isoformat(),
        updated_by="cso@acme",
    )
    st = baa_mod.enforcement_state("acme")
    assert st["in_grace"] is False
    assert st["should_block"] is True

    baa_mod.create_entry(
        tenant_id="acme",
        counterparty="Mercy Health System",
        document_version="v1",
        created_by="dpo@acme",
        status="active",
        effective_on=today - timedelta(days=1),
        expires_on=today + timedelta(days=200),
    )
    st = baa_mod.enforcement_state("acme")
    assert st["has_active_baa"] is True
    assert st["should_block"] is False
