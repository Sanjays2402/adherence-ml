"""Tests for per-tenant BCDR (RTO/RPO/DR test) register.

Covers:

* Create / list / update / archive round trip with a monotonic
  version bump on every update.
* Record-test path: outcome is persisted, last_tested_at moves
  next_test_due_at forward, and overdue clears.
* Cross-tenant isolation: tenant B cannot see, update, test, or
  archive tenant A's BCDR entry. This is the multi-tenancy gate
  procurement cares about.
* Validation: short service_name, unknown tier/strategy/outcome,
  duplicate active service name within tenant, out-of-range cadence,
  bad runbook URL, negative RTO/RPO.
* Overdue test accounting against ``next_test_due_at``.
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

from adherence_common import bcdr as bcdr_mod  # noqa: E402
from adherence_common.bcdr import BcdrEntry  # noqa: E402
from adherence_common.db import init_db, session  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh():
    init_db()
    with session() as s:
        s.execute(delete(BcdrEntry))
        s.commit()
    yield
    with session() as s:
        s.execute(delete(BcdrEntry))
        s.commit()


def _mk(tenant="acme", name="prediction-api", **kw):
    return bcdr_mod.create_entry(
        tenant_id=tenant,
        service_name=name,
        tier=kw.pop("tier", "tier1"),
        rto_minutes=kw.pop("rto_minutes", 60),
        rpo_minutes=kw.pop("rpo_minutes", 15),
        strategy=kw.pop("strategy", "warm_standby"),
        created_by=kw.pop("created_by", "ops@acme"),
        runbook_url=kw.pop("runbook_url", "https://runbooks.acme.example/dr"),
        notes=kw.pop("notes", "Primary scoring endpoint."),
        test_cadence_days=kw.pop("test_cadence_days", 180),
    )


def test_empty_register():
    assert bcdr_mod.list_entries(tenant_id="acme") == []
    assert bcdr_mod.active_count("acme") == 0
    assert bcdr_mod.overdue_count("acme") == 0


def test_create_list_update_archive_round_trip():
    v = _mk()
    assert v.active is True
    assert v.version == 1
    assert v.tier == "tier1"
    assert v.rto_minutes == 60
    assert v.rpo_minutes == 15
    assert v.strategy == "warm_standby"
    assert v.last_outcome == "not_tested"
    assert v.test_overdue is False
    assert v.runbook_url == "https://runbooks.acme.example/dr"

    listed = bcdr_mod.list_entries(tenant_id="acme")
    assert len(listed) == 1 and listed[0].id == v.id

    updated = bcdr_mod.update_entry(
        tenant_id="acme",
        entry_id=v.id,
        updated_by="sre@acme",
        rto_minutes=30,
        rpo_minutes=5,
        strategy="multi_site",
    )
    assert updated is not None
    assert updated.version == 2
    assert updated.rto_minutes == 30
    assert updated.rpo_minutes == 5
    assert updated.strategy == "multi_site"
    assert updated.updated_by == "sre@acme"

    archived = bcdr_mod.archive_entry(
        tenant_id="acme", entry_id=v.id, archived_by="ops@acme"
    )
    assert archived is not None
    assert archived.active is False

    assert bcdr_mod.list_entries(tenant_id="acme") == []
    assert len(bcdr_mod.list_entries(tenant_id="acme", include_archived=True)) == 1


def test_record_test_updates_outcome_and_clears_overdue():
    v = _mk(test_cadence_days=30)
    # Force the row's last_tested_at far in the past so it shows overdue.
    with session() as s:
        row = s.get(BcdrEntry, v.id)
        assert row is not None
        row.created_at = datetime.utcnow() - timedelta(days=200)
        s.commit()
    before = bcdr_mod.get_entry(tenant_id="acme", entry_id=v.id)
    assert before is not None and before.test_overdue is True

    after = bcdr_mod.record_test(
        tenant_id="acme",
        entry_id=v.id,
        outcome="passed",
        tested_by="sre@acme",
        test_notes="Failover drill in us-east-2, recovered in 14m.",
    )
    assert after is not None
    assert after.last_outcome == "passed"
    assert after.last_test_notes is not None
    assert after.test_overdue is False
    assert after.version == 2


def test_service_name_validation():
    with pytest.raises(bcdr_mod.BcdrError):
        bcdr_mod.create_entry(
            tenant_id="acme",
            service_name="x",
            tier="tier1",
            rto_minutes=60,
            rpo_minutes=15,
            strategy="warm_standby",
            created_by="x",
        )


def test_unknown_tier_strategy_outcome_rejected():
    with pytest.raises(bcdr_mod.BcdrError):
        bcdr_mod.create_entry(
            tenant_id="acme",
            service_name="svc",
            tier="platinum",
            rto_minutes=60,
            rpo_minutes=15,
            strategy="warm_standby",
            created_by="x",
        )
    with pytest.raises(bcdr_mod.BcdrError):
        bcdr_mod.create_entry(
            tenant_id="acme",
            service_name="svc",
            tier="tier1",
            rto_minutes=60,
            rpo_minutes=15,
            strategy="hope",
            created_by="x",
        )
    v = _mk(name="svc2")
    with pytest.raises(bcdr_mod.BcdrError):
        bcdr_mod.record_test(
            tenant_id="acme",
            entry_id=v.id,
            outcome="catastrophic",
            tested_by="x",
        )


def test_negative_rto_rejected():
    with pytest.raises(bcdr_mod.BcdrError):
        bcdr_mod.create_entry(
            tenant_id="acme",
            service_name="svc",
            tier="tier1",
            rto_minutes=-1,
            rpo_minutes=15,
            strategy="warm_standby",
            created_by="x",
        )


def test_bad_runbook_url_rejected():
    with pytest.raises(bcdr_mod.BcdrError):
        bcdr_mod.create_entry(
            tenant_id="acme",
            service_name="svc",
            tier="tier1",
            rto_minutes=60,
            rpo_minutes=15,
            strategy="warm_standby",
            created_by="x",
            runbook_url="ftp://nope/runbook",
        )


def test_cadence_bounds_enforced():
    with pytest.raises(bcdr_mod.BcdrError):
        bcdr_mod.create_entry(
            tenant_id="acme",
            service_name="svc",
            tier="tier1",
            rto_minutes=60,
            rpo_minutes=15,
            strategy="warm_standby",
            created_by="x",
            test_cadence_days=1,
        )
    with pytest.raises(bcdr_mod.BcdrError):
        bcdr_mod.create_entry(
            tenant_id="acme",
            service_name="svc2",
            tier="tier1",
            rto_minutes=60,
            rpo_minutes=15,
            strategy="warm_standby",
            created_by="x",
            test_cadence_days=10_000,
        )


def test_duplicate_active_service_within_tenant_rejected():
    _mk(name="prediction-api")
    with pytest.raises(bcdr_mod.BcdrError):
        _mk(name="prediction-api")


def test_same_service_allowed_across_tenants():
    _mk(tenant="acme", name="prediction-api")
    other = _mk(tenant="globex", name="prediction-api")
    assert other.tenant_id == "globex"


def test_cross_tenant_isolation():
    """Tenant B must not see, update, test, or archive tenant A's entry."""
    a = _mk(tenant="acme", name="prediction-api")

    assert bcdr_mod.list_entries(tenant_id="globex") == []
    assert bcdr_mod.get_entry(tenant_id="globex", entry_id=a.id) is None

    # Tenant B cannot update tenant A's row.
    assert bcdr_mod.update_entry(
        tenant_id="globex",
        entry_id=a.id,
        updated_by="attacker@globex",
        rto_minutes=9999,
    ) is None

    # Tenant B cannot record a test against tenant A's row.
    assert bcdr_mod.record_test(
        tenant_id="globex",
        entry_id=a.id,
        outcome="failed",
        tested_by="attacker@globex",
    ) is None

    # Tenant B cannot archive tenant A's row.
    assert bcdr_mod.archive_entry(
        tenant_id="globex", entry_id=a.id, archived_by="attacker@globex"
    ) is None

    after = bcdr_mod.get_entry(tenant_id="acme", entry_id=a.id)
    assert after is not None
    assert after.active is True
    assert after.version == 1
    assert after.rto_minutes == 60
    assert after.last_outcome == "not_tested"


def test_overdue_test_flagged_and_counted():
    v = _mk(test_cadence_days=30)
    with session() as s:
        row = s.get(BcdrEntry, v.id)
        assert row is not None
        row.created_at = datetime.utcnow() - timedelta(days=400)
        s.commit()
    listed = bcdr_mod.list_entries(tenant_id="acme")
    assert len(listed) == 1
    assert listed[0].test_overdue is True
    assert bcdr_mod.overdue_count("acme") == 1
