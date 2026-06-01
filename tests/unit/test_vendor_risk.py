"""Tests for the per-tenant vendor risk assessment register.

Covers:

* Create / list / update / review / retire round trip with a
  monotonic version bump on every mutation.
* Cross-tenant isolation: tenant B cannot see, update, review, or
  retire tenant A's vendor row. This is the multi-tenancy gate
  procurement cares about.
* Validation: short vendor_name, unknown enum values, residual risk
  above inherent risk, bad URL, duplicate active vendor name within
  tenant, cadence bounds.
* Review updates next_review_at and clears overdue.
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

from adherence_common import vendor_risk as vr  # noqa: E402
from adherence_common.vendor_risk import VendorRiskEntry, VendorReviewEntry  # noqa: E402
from adherence_common.db import init_db, session  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh():
    init_db()
    with session() as s:
        s.execute(delete(VendorReviewEntry))
        s.execute(delete(VendorRiskEntry))
        s.commit()
    yield
    with session() as s:
        s.execute(delete(VendorReviewEntry))
        s.execute(delete(VendorRiskEntry))
        s.commit()


def _mk(tenant="acme", name="OpenAI", **kw):
    return vr.create_entry(
        tenant_id=tenant,
        vendor_name=name,
        vendor_type=kw.pop("vendor_type", "subprocessor"),
        owner=kw.pop("owner", "alice"),
        created_by=kw.pop("created_by", "alice"),
        **kw,
    )


def test_empty_register():
    assert vr.list_entries(tenant_id="acme") == []
    s = vr.summary(tenant_id="acme")
    assert s["total"] == 0
    assert s["active"] == 0
    assert s["overdue"] == 0


def test_create_list_update_review_retire_round_trip():
    v = _mk(data_shared="pii", inherent_risk="high", residual_risk="medium")
    assert v.id > 0
    assert v.version == 1
    assert v.active is True
    assert v.status == "proposed"
    assert v.residual_risk == "medium"
    assert v.next_review_at  # set to now + cadence

    listed = vr.list_entries(tenant_id="acme")
    assert len(listed) == 1
    assert listed[0].vendor_name == "OpenAI"

    upd = vr.update_entry(
        tenant_id="acme",
        entry_id=v.id,
        updated_by="bob",
        residual_risk="low",
        soc2=True,
    )
    assert upd is not None
    assert upd.version == 2
    assert upd.residual_risk == "low"
    assert upd.soc2 is True

    result = vr.record_review(
        tenant_id="acme",
        entry_id=v.id,
        outcome="approved",
        reviewed_by="carol",
        notes="reviewed against SOC2 type 2 report",
    )
    assert result is not None
    reviewed, review = result
    assert reviewed.status == "approved"
    assert reviewed.last_review_outcome == "approved"
    assert reviewed.version == 3
    assert review.outcome == "approved"
    assert review.reviewed_by == "carol"

    log = vr.list_reviews(tenant_id="acme", entry_id=v.id)
    assert len(log) == 1
    assert log[0].outcome == "approved"

    retired = vr.retire_entry(
        tenant_id="acme", entry_id=v.id, retired_by="alice"
    )
    assert retired is not None
    assert retired.active is False
    assert retired.status == "retired"

    assert vr.list_entries(tenant_id="acme") == []
    assert (
        len(vr.list_entries(tenant_id="acme", include_retired=True)) == 1
    )


def test_cross_tenant_isolation():
    v = _mk(tenant="acme")
    # tenant b cannot see
    assert vr.list_entries(tenant_id="beta") == []
    assert vr.get_entry(tenant_id="beta", entry_id=v.id) is None
    assert vr.list_reviews(tenant_id="beta", entry_id=v.id) == []

    # tenant b cannot update or review or retire
    assert (
        vr.update_entry(
            tenant_id="beta",
            entry_id=v.id,
            updated_by="evil",
            status="approved",
        )
        is None
    )
    assert (
        vr.record_review(
            tenant_id="beta",
            entry_id=v.id,
            outcome="approved",
            reviewed_by="evil",
        )
        is None
    )
    assert (
        vr.retire_entry(
            tenant_id="beta", entry_id=v.id, retired_by="evil"
        )
        is None
    )

    # Acme's row is intact and unmodified
    same = vr.get_entry(tenant_id="acme", entry_id=v.id)
    assert same is not None
    assert same.version == 1
    assert same.status == "proposed"
    assert vr.list_reviews(tenant_id="acme", entry_id=v.id) == []


def test_same_name_allowed_across_tenants():
    a = _mk(tenant="acme", name="OpenAI")
    b = _mk(tenant="beta", name="OpenAI")
    assert a.id != b.id
    assert a.tenant_id == "acme"
    assert b.tenant_id == "beta"


def test_duplicate_active_vendor_rejected():
    _mk(name="OpenAI")
    with pytest.raises(vr.VendorRiskError):
        _mk(name="openai")  # case-insensitive collision


def test_short_vendor_name_rejected():
    with pytest.raises(vr.VendorRiskError):
        _mk(name="X")


def test_unknown_enums_rejected():
    with pytest.raises(vr.VendorRiskError):
        _mk(vendor_type="quantum")
    with pytest.raises(vr.VendorRiskError):
        _mk(data_shared="psychic")
    with pytest.raises(vr.VendorRiskError):
        _mk(inherent_risk="apocalyptic")
    with pytest.raises(vr.VendorRiskError):
        _mk(status="retired")  # only the retire endpoint may retire


def test_residual_above_inherent_rejected():
    with pytest.raises(vr.VendorRiskError):
        _mk(inherent_risk="low", residual_risk="critical")


def test_bad_evidence_url_rejected():
    with pytest.raises(vr.VendorRiskError):
        _mk(evidence_url="javascript:alert(1)")


def test_cadence_bounds_enforced():
    with pytest.raises(vr.VendorRiskError):
        _mk(review_cadence_days=1)
    with pytest.raises(vr.VendorRiskError):
        _mk(review_cadence_days=100_000)


def test_review_clears_overdue_and_advances_next_review():
    v = _mk(review_cadence_days=30)
    # Force overdue by rewinding next_review_at into the past.
    with session() as s:
        row = s.get(VendorRiskEntry, v.id)
        row.next_review_at = datetime.utcnow() - timedelta(days=5)
        s.commit()

    cur = vr.get_entry(tenant_id="acme", entry_id=v.id)
    assert cur is not None
    assert cur.review_overdue is True

    result = vr.record_review(
        tenant_id="acme",
        entry_id=v.id,
        outcome="conditional",
        reviewed_by="bob",
    )
    assert result is not None
    after, _ = result
    assert after.review_overdue is False
    assert after.status == "conditional"
    # Next review should be roughly 30 days out.
    next_at = datetime.fromisoformat(after.next_review_at)
    delta = (next_at - datetime.utcnow()).total_seconds()
    assert 29 * 86400 < delta < 31 * 86400


def test_summary_aggregates_by_status_and_residual_risk():
    _mk(name="Vendor A", inherent_risk="high", residual_risk="medium")
    _mk(name="Vendor B", inherent_risk="critical", residual_risk="critical")
    _mk(name="Vendor C", inherent_risk="low", residual_risk="low")
    s = vr.summary(tenant_id="acme")
    assert s["active"] == 3
    assert s["by_residual_risk"]["medium"] == 1
    assert s["by_residual_risk"]["critical"] == 1
    assert s["by_residual_risk"]["low"] == 1
