"""Tests for the per-tenant Enterprise Risk Register.

Covers:

* Create / list / update / close round trip with audit-friendly
  fields populated and a monotonic version bump on every update.
* Server-computed inherent and residual scores.
* Cross-tenant isolation: entries belonging to tenant A are invisible
  to tenant B, an update from tenant B targeting tenant A's entry id
  is a no-op (returns None), and a close from tenant B is the same.
  This is the multi-tenancy gate procurement cares about.
* Validation: short description, unknown category / treatment /
  status, residual scores exceeding inherent, duplicate active title
  within the same tenant.
* Review-overdue derivation.
"""
from __future__ import annotations

import os
import tempfile
from datetime import datetime, timedelta

import pytest

_TMP = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP.close()
os.environ["ADHERENCE_DB_URL"] = f"sqlite:///{_TMP.name}"
os.environ.setdefault("JWT_SECRET", "x" * 32)

from sqlalchemy import delete  # noqa: E402

from adherence_common import risk_register as rr  # noqa: E402
from adherence_common.risk_register import RiskEntry  # noqa: E402
from adherence_common.db import init_db, session  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh():
    init_db()
    with session() as s:
        s.execute(delete(RiskEntry))
        s.commit()
    yield
    with session() as s:
        s.execute(delete(RiskEntry))
        s.commit()


def _mk(**over):
    base = dict(
        tenant_id="acme",
        title="Model drift on adherence scoring",
        category="model",
        description="Prediction quality may degrade as patient mix shifts.",
        likelihood=3,
        impact=4,
        treatment="mitigate",
        owner="ml-platform@acme",
        created_by="root@acme",
        mitigations="Weekly drift monitor; quarterly retrain.",
        residual_likelihood=2,
        residual_impact=3,
        next_review_at=(datetime.utcnow() + timedelta(days=30)).strftime("%Y-%m-%d"),
    )
    base.update(over)
    return rr.create_entry(**base)


def test_empty_register():
    assert rr.list_entries(tenant_id="acme") == []
    assert rr.active_count("acme") == 0
    assert rr.overdue_count("acme") == 0


def test_create_list_update_close_round_trip():
    v = _mk()
    assert v.active is True
    assert v.version == 1
    assert v.inherent_score == 12  # 3 * 4
    assert v.residual_score == 6   # 2 * 3
    assert v.status == "open"
    assert v.review_overdue is False

    listed = rr.list_entries(tenant_id="acme")
    assert len(listed) == 1 and listed[0].id == v.id

    updated = rr.update_entry(
        tenant_id="acme",
        entry_id=v.id,
        updated_by="ciso@acme",
        residual_likelihood=1,
        residual_impact=2,
        status="mitigating",
        notes="Mitigation deployed in prod 2026-05-30.",
    )
    assert updated is not None
    assert updated.version == 2
    assert updated.residual_score == 2
    assert updated.status == "mitigating"
    assert updated.updated_by == "ciso@acme"

    closed = rr.close_entry(
        tenant_id="acme",
        entry_id=v.id,
        closed_by="ciso@acme",
        reason="Residual within appetite; accepted by risk committee.",
    )
    assert closed is not None
    assert closed.active is False
    assert closed.status == "closed"
    assert closed.closed_reason.startswith("Residual within appetite")

    # default list excludes closed
    assert rr.list_entries(tenant_id="acme") == []
    assert len(rr.list_entries(tenant_id="acme", include_closed=True)) == 1


def test_cross_tenant_isolation_is_total():
    a = _mk(tenant_id="acme", title="Tenant A risk")
    _mk(tenant_id="globex", title="Tenant B risk")

    # B can't see A
    b_listed = [e.title for e in rr.list_entries(tenant_id="globex")]
    assert b_listed == ["Tenant B risk"]

    # B can't fetch A by id
    assert rr.get_entry(tenant_id="globex", entry_id=a.id) is None

    # B can't update A
    assert (
        rr.update_entry(
            tenant_id="globex",
            entry_id=a.id,
            updated_by="attacker@globex",
            notes="pwn",
        )
        is None
    )

    # B can't close A
    assert (
        rr.close_entry(
            tenant_id="globex",
            entry_id=a.id,
            closed_by="attacker@globex",
        )
        is None
    )

    # A's entry is unchanged
    fetched = rr.get_entry(tenant_id="acme", entry_id=a.id)
    assert fetched is not None
    assert fetched.active is True
    assert fetched.notes is None
    assert fetched.version == 1


def test_validation_rejects_bad_inputs():
    with pytest.raises(rr.RiskRegisterError):
        _mk(description="too short")
    with pytest.raises(rr.RiskRegisterError):
        _mk(category="nonsense")
    with pytest.raises(rr.RiskRegisterError):
        _mk(treatment="ignore")
    with pytest.raises(rr.RiskRegisterError):
        _mk(likelihood=9)
    with pytest.raises(rr.RiskRegisterError):
        # residual cannot exceed inherent
        _mk(likelihood=2, impact=2, residual_likelihood=3, residual_impact=2)
    _mk(title="dup test")
    with pytest.raises(rr.RiskRegisterError):
        _mk(title="dup test")


def test_review_overdue_flag():
    past = (datetime.utcnow() - timedelta(days=7)).strftime("%Y-%m-%d")
    v = _mk(title="Overdue risk", next_review_at=past)
    assert v.review_overdue is True
    assert rr.overdue_count("acme") == 1
    # close clears the overdue contribution
    rr.close_entry(tenant_id="acme", entry_id=v.id, closed_by="root@acme")
    assert rr.overdue_count("acme") == 0


def test_status_closed_via_update_is_rejected():
    v = _mk(title="Status guard")
    with pytest.raises(rr.RiskRegisterError):
        rr.update_entry(
            tenant_id="acme",
            entry_id=v.id,
            updated_by="root@acme",
            status="closed",
        )
