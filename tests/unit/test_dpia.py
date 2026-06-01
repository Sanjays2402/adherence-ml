"""Tests for per-tenant GDPR Art. 35 DPIA register.

Covers:

* Create / list / update / archive round trip with audit-friendly
  fields populated and a monotonic version bump on every update.
* Cross-tenant isolation: tenant B cannot see, update, or archive
  tenant A's DPIA entry. This is the multi-tenancy gate procurement
  cares about.
* Validation: short description, unknown residual_risk, duplicate
  active title within the same tenant, out-of-range review window.
* Overdue review accounting against ``review_due_at``.
"""
from __future__ import annotations

import os
import tempfile

import pytest

_TMP = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP.close()
os.environ["ADHERENCE_DB_URL"] = f"sqlite:///{_TMP.name}"
os.environ.setdefault("JWT_SECRET", "x" * 32)

from datetime import datetime, timedelta  # noqa: E402

from sqlalchemy import delete  # noqa: E402

from adherence_common import dpia as dpia_mod  # noqa: E402
from adherence_common.dpia import DpiaEntry  # noqa: E402
from adherence_common.db import init_db, session  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh():
    init_db()
    with session() as s:
        s.execute(delete(DpiaEntry))
        s.commit()
    yield
    with session() as s:
        s.execute(delete(DpiaEntry))
        s.commit()


def test_empty_register():
    assert dpia_mod.list_entries(tenant_id="acme") == []
    assert dpia_mod.active_count("acme") == 0
    assert dpia_mod.overdue_count("acme") == 0


def test_create_list_update_archive_round_trip():
    v = dpia_mod.create_entry(
        tenant_id="acme",
        title="Adherence risk scoring",
        description=(
            "Train and serve a gradient-boosted adherence risk model over "
            "patient dose history to drive clinician outreach lists."
        ),
        residual_risk="moderate",
        created_by="dpo@acme",
        necessity="No less intrusive way to flag high-risk patients in time.",
        risks="Re-identification of patients in small cohorts.",
        mitigations="Tenant scoping, k-anonymity floor of 5 in exports.",
        dpo_consulted=True,
        consultation_required=False,
        review_in_days=180,
    )
    assert v.active is True
    assert v.version == 1
    assert v.residual_risk == "moderate"
    assert v.dpo_consulted is True
    assert v.consultation_required is False
    assert v.review_overdue is False

    listed = dpia_mod.list_entries(tenant_id="acme")
    assert len(listed) == 1 and listed[0].id == v.id

    updated = dpia_mod.update_entry(
        tenant_id="acme",
        entry_id=v.id,
        updated_by="legal@acme",
        residual_risk="low",
        mitigations="Tenant scoping, k=5 floor, plus differential privacy on exports.",
    )
    assert updated is not None
    assert updated.version == 2
    assert updated.residual_risk == "low"
    assert updated.updated_by == "legal@acme"

    archived = dpia_mod.archive_entry(
        tenant_id="acme", entry_id=v.id, archived_by="dpo@acme"
    )
    assert archived is not None
    assert archived.active is False

    # Default listing hides archived rows.
    assert dpia_mod.list_entries(tenant_id="acme") == []
    assert len(dpia_mod.list_entries(tenant_id="acme", include_archived=True)) == 1


def test_description_validation():
    with pytest.raises(dpia_mod.DpiaError):
        dpia_mod.create_entry(
            tenant_id="acme",
            title="X risk",
            description="too short",
            residual_risk="low",
            created_by="x",
        )


def test_unknown_residual_risk_rejected():
    with pytest.raises(dpia_mod.DpiaError):
        dpia_mod.create_entry(
            tenant_id="acme",
            title="Some processing",
            description="A perfectly fine description for testing the residual risk validator.",
            residual_risk="catastrophic",
            created_by="x",
        )


def test_review_window_bounds_enforced():
    with pytest.raises(dpia_mod.DpiaError):
        dpia_mod.create_entry(
            tenant_id="acme",
            title="Some processing",
            description="A perfectly fine description for testing the review window guard.",
            residual_risk="low",
            created_by="x",
            review_in_days=0,
        )
    with pytest.raises(dpia_mod.DpiaError):
        dpia_mod.create_entry(
            tenant_id="acme",
            title="Some processing 2",
            description="A perfectly fine description for testing the review window guard.",
            residual_risk="low",
            created_by="x",
            review_in_days=10_000,
        )


def test_duplicate_active_title_within_tenant_rejected():
    dpia_mod.create_entry(
        tenant_id="acme",
        title="Adherence risk scoring",
        description="A perfectly fine description for testing the unique active title guard.",
        residual_risk="moderate",
        created_by="x",
    )
    with pytest.raises(dpia_mod.DpiaError):
        dpia_mod.create_entry(
            tenant_id="acme",
            title="Adherence risk scoring",
            description="A perfectly fine description for testing the unique active title guard.",
            residual_risk="moderate",
            created_by="x",
        )


def test_cross_tenant_isolation():
    """Tenant B must not see, update, or archive tenant A's entry."""
    a = dpia_mod.create_entry(
        tenant_id="acme",
        title="Tenant A DPIA",
        description="Tenant A processes its own data and only its own data for adherence scoring.",
        residual_risk="high",
        created_by="root@acme",
    )

    assert dpia_mod.list_entries(tenant_id="globex") == []
    assert dpia_mod.get_entry(tenant_id="globex", entry_id=a.id) is None

    # Tenant B cannot update tenant A's row.
    assert dpia_mod.update_entry(
        tenant_id="globex",
        entry_id=a.id,
        updated_by="attacker@globex",
        residual_risk="low",
    ) is None

    # Tenant B cannot archive tenant A's row.
    assert dpia_mod.archive_entry(
        tenant_id="globex", entry_id=a.id, archived_by="attacker@globex"
    ) is None

    # Tenant A's row is unchanged.
    after = dpia_mod.get_entry(tenant_id="acme", entry_id=a.id)
    assert after is not None
    assert after.active is True
    assert after.version == 1
    assert after.residual_risk == "high"


def test_same_title_allowed_across_tenants():
    dpia_mod.create_entry(
        tenant_id="acme",
        title="Adherence risk scoring",
        description="A processes adherence risk for its own customers under contract.",
        residual_risk="moderate",
        created_by="x",
    )
    other = dpia_mod.create_entry(
        tenant_id="globex",
        title="Adherence risk scoring",
        description="B processes adherence risk for its own customers under contract.",
        residual_risk="moderate",
        created_by="y",
    )
    assert other.tenant_id == "globex"


def test_overdue_review_flagged_and_counted():
    v = dpia_mod.create_entry(
        tenant_id="acme",
        title="Overdue assessment",
        description="An assessment whose review date is in the past should surface as overdue.",
        residual_risk="moderate",
        created_by="x",
        review_in_days=30,
    )
    # Force review_due_at into the past directly on the row to simulate
    # the passage of time without sleeping.
    with session() as s:
        row = s.get(DpiaEntry, v.id)
        assert row is not None
        row.review_due_at = datetime.utcnow() - timedelta(days=1)
        s.commit()
    listed = dpia_mod.list_entries(tenant_id="acme")
    assert len(listed) == 1
    assert listed[0].review_overdue is True
    assert dpia_mod.overdue_count("acme") == 1
