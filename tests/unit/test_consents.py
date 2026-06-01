"""Tests for per-tenant data subject consent register."""
from __future__ import annotations

import os
import tempfile

import pytest

_TMP = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP.close()
os.environ["ADHERENCE_DB_URL"] = f"sqlite:///{_TMP.name}"
os.environ.setdefault("JWT_SECRET", "x" * 32)

from sqlalchemy import delete  # noqa: E402

from adherence_common import consents as cons_mod  # noqa: E402
from adherence_common.consents import ConsentReceipt  # noqa: E402
from adherence_common.db import init_db, session  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh():
    init_db()
    with session() as s:
        s.execute(delete(ConsentReceipt))
        s.commit()
    yield
    with session() as s:
        s.execute(delete(ConsentReceipt))
        s.commit()


def test_empty_register():
    assert cons_mod.list_consents(tenant_id="acme") == []
    c = cons_mod.counts("acme")
    assert c == {
        "active": 0,
        "withdrawn": 0,
        "active_subjects": 0,
        "active_purposes": [],
    }
    assert cons_mod.has_active_consent("acme", "patient:123",
                                        "research.secondary_use") is False


def test_grant_idempotent_bumps_version():
    v1 = cons_mod.grant_consent(
        tenant_id="acme",
        subject_ref="patient:123",
        purpose="research.secondary_use",
        lawful_basis="consent",
        capture_channel="web_form",
        granted_by="dpo@acme",
        evidence_ref="form-2026-01-01-7",
    )
    assert v1.active is True
    assert v1.version == 1
    assert v1.purpose == "research.secondary_use"
    assert cons_mod.has_active_consent(
        "acme", "patient:123", "research.secondary_use"
    ) is True

    v2 = cons_mod.grant_consent(
        tenant_id="acme",
        subject_ref="patient:123",
        purpose="research.secondary_use",
        lawful_basis="hipaa_authorization",
        capture_channel="paper_form",
        granted_by="dpo@acme",
        evidence_ref="form-2026-01-02-9",
        notes="Patient re-consented on paper after lawful basis change.",
    )
    assert v2.id == v1.id
    assert v2.version == 2
    assert v2.lawful_basis == "hipaa_authorization"
    assert v2.capture_channel == "paper_form"

    summary = cons_mod.counts("acme")
    assert summary == {
        "active": 1,
        "withdrawn": 0,
        "active_subjects": 1,
        "active_purposes": ["research.secondary_use"],
    }


def test_withdraw_consent_preserves_row_for_audit():
    v = cons_mod.grant_consent(
        tenant_id="acme",
        subject_ref="patient:42",
        purpose="marketing.outreach",
        lawful_basis="consent",
        capture_channel="web_form",
        granted_by="dpo@acme",
    )
    withdrawn = cons_mod.withdraw_consent(
        tenant_id="acme",
        consent_id=v.id,
        withdrawn_by="patient_portal",
        reason="data subject request",
    )
    assert withdrawn is not None
    assert withdrawn.active is False
    assert withdrawn.withdrawn_by == "patient_portal"
    assert withdrawn.withdrawal_reason == "data subject request"

    # Still discoverable in the audit-friendly history.
    assert cons_mod.get_consent(
        tenant_id="acme", consent_id=v.id
    ).active is False
    assert cons_mod.list_consents(
        tenant_id="acme", include_withdrawn=False
    ) == []
    assert len(cons_mod.list_consents(
        tenant_id="acme", include_withdrawn=True
    )) == 1

    # Cannot withdraw twice.
    again = cons_mod.withdraw_consent(
        tenant_id="acme", consent_id=v.id, withdrawn_by="x",
    )
    assert again is None
    assert cons_mod.has_active_consent(
        "acme", "patient:42", "marketing.outreach"
    ) is False


def test_tenant_isolation_no_cross_tenant_leak():
    """Critical multi-tenancy invariant: consents in one tenant are not
    readable, listable, withdrawable, or testable from another tenant.
    """
    a = cons_mod.grant_consent(
        tenant_id="tenantA",
        subject_ref="patient:shared-id-1",
        purpose="ml.training",
        lawful_basis="consent",
        capture_channel="api",
        granted_by="admin@A",
    )
    cons_mod.grant_consent(
        tenant_id="tenantB",
        subject_ref="patient:shared-id-1",  # same subject ref!
        purpose="ml.training",
        lawful_basis="consent",
        capture_channel="api",
        granted_by="admin@B",
    )

    # Lists are tenant-scoped.
    a_list = cons_mod.list_consents(tenant_id="tenantA")
    b_list = cons_mod.list_consents(tenant_id="tenantB")
    assert len(a_list) == 1 and a_list[0].tenant_id == "tenantA"
    assert len(b_list) == 1 and b_list[0].tenant_id == "tenantB"

    # Hashes for the same subject_ref differ across tenants
    # so cross-tenant subject correlation is impossible by hash.
    assert a_list[0].subject_hash != b_list[0].subject_hash

    # get_consent from the wrong tenant returns None.
    assert cons_mod.get_consent(tenant_id="tenantB", consent_id=a.id) is None
    assert cons_mod.get_consent(tenant_id="tenantA", consent_id=a.id) is not None

    # withdraw_consent from the wrong tenant is a no-op.
    assert cons_mod.withdraw_consent(
        tenant_id="tenantB", consent_id=a.id, withdrawn_by="attacker"
    ) is None
    still = cons_mod.get_consent(tenant_id="tenantA", consent_id=a.id)
    assert still is not None and still.active is True

    # has_active_consent is tenant-scoped.
    assert cons_mod.has_active_consent(
        "tenantA", "patient:shared-id-1", "ml.training"
    ) is True
    # An unrelated tenant must not see consent even with same subject_ref.
    assert cons_mod.has_active_consent(
        "tenantC", "patient:shared-id-1", "ml.training"
    ) is False


def test_input_validation():
    with pytest.raises(cons_mod.ConsentError):
        cons_mod.grant_consent(
            tenant_id="acme",
            subject_ref="",
            purpose="research",
            lawful_basis="consent",
            capture_channel="web_form",
            granted_by="x",
        )
    with pytest.raises(cons_mod.ConsentError):
        cons_mod.grant_consent(
            tenant_id="acme",
            subject_ref="patient:1",
            purpose="research",
            lawful_basis="not_a_basis",
            capture_channel="web_form",
            granted_by="x",
        )
    with pytest.raises(cons_mod.ConsentError):
        cons_mod.grant_consent(
            tenant_id="acme",
            subject_ref="patient:1",
            purpose="research",
            lawful_basis="consent",
            capture_channel="telepathy",
            granted_by="x",
        )


def test_list_filter_by_subject_and_purpose():
    cons_mod.grant_consent(
        tenant_id="acme", subject_ref="patient:1", purpose="ml.training",
        lawful_basis="consent", capture_channel="api", granted_by="x",
    )
    cons_mod.grant_consent(
        tenant_id="acme", subject_ref="patient:1", purpose="marketing.outreach",
        lawful_basis="consent", capture_channel="api", granted_by="x",
    )
    cons_mod.grant_consent(
        tenant_id="acme", subject_ref="patient:2", purpose="ml.training",
        lawful_basis="consent", capture_channel="api", granted_by="x",
    )

    only_p1 = cons_mod.list_consents(tenant_id="acme", subject_ref="patient:1")
    assert {e.purpose for e in only_p1} == {"ml.training", "marketing.outreach"}

    only_training = cons_mod.list_consents(tenant_id="acme", purpose="ml.training")
    assert {e.subject_ref for e in only_training} == {"patient:1", "patient:2"}

    summary = cons_mod.counts("acme")
    assert summary["active"] == 3
    assert summary["active_subjects"] == 2
    assert set(summary["active_purposes"]) == {"ml.training", "marketing.outreach"}
