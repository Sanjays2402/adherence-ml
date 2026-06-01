"""Tests for per-tenant scheduled maintenance window register."""
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

from adherence_common import maintenance as maint_mod  # noqa: E402
from adherence_common.maintenance import MaintenanceWindow  # noqa: E402
from adherence_common.db import init_db, session  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh():
    init_db()
    with session() as s:
        s.execute(delete(MaintenanceWindow))
        s.commit()
    yield
    with session() as s:
        s.execute(delete(MaintenanceWindow))
        s.commit()


def _t(offset_minutes: int) -> datetime:
    return (datetime.utcnow() + timedelta(minutes=offset_minutes)).replace(microsecond=0)


def test_empty_register():
    assert maint_mod.list_windows(tenant_id="acme") == []
    assert maint_mod.active_count("acme") == 0
    assert maint_mod.upcoming_count("acme") == 0
    assert maint_mod.active_windows("acme") == []


def test_create_list_update_archive_round_trip():
    v = maint_mod.create_window(
        tenant_id="acme",
        title="Quarterly Postgres minor upgrade",
        description=(
            "Rolling minor-version upgrade of the primary Postgres cluster "
            "for the adherence prediction service. Reads remain available."
        ),
        category="upgrade",
        impact="degraded",
        starts_at=_t(60),
        ends_at=_t(120),
        created_by="sre@acme",
    )
    assert v.active is True
    assert v.version == 1
    assert v.category == "upgrade"
    assert v.impact == "degraded"
    assert v.status == "scheduled"

    listed = maint_mod.list_windows(tenant_id="acme")
    assert len(listed) == 1 and listed[0].id == v.id

    updated = maint_mod.update_window(
        tenant_id="acme",
        window_id=v.id,
        updated_by="lead@acme",
        impact="partial_outage",
        ends_at=_t(150),
    )
    assert updated is not None
    assert updated.version == 2
    assert updated.impact == "partial_outage"
    assert updated.updated_by == "lead@acme"

    archived = maint_mod.archive_window(
        tenant_id="acme",
        window_id=v.id,
        archived_by="sre@acme",
        reason="Vendor pushed a patch that removes the need for this window.",
    )
    assert archived is not None
    assert archived.active is False
    assert archived.status == "cancelled"
    assert archived.archive_reason and "vendor" in archived.archive_reason.lower()

    assert maint_mod.list_windows(tenant_id="acme") == []
    assert len(maint_mod.list_windows(tenant_id="acme", include_archived=True)) == 1


def test_description_validation():
    with pytest.raises(maint_mod.MaintenanceError):
        maint_mod.create_window(
            tenant_id="acme",
            title="X",
            description="short",
            category="maintenance",
            impact="degraded",
            starts_at=_t(60),
            ends_at=_t(120),
            created_by="x",
        )


def test_unknown_category_and_impact_rejected():
    with pytest.raises(maint_mod.MaintenanceError):
        maint_mod.create_window(
            tenant_id="acme",
            title="Title here",
            description="A perfectly fine description for testing category validation.",
            category="party",
            impact="degraded",
            starts_at=_t(60),
            ends_at=_t(120),
            created_by="x",
        )
    with pytest.raises(maint_mod.MaintenanceError):
        maint_mod.create_window(
            tenant_id="acme",
            title="Title here",
            description="A perfectly fine description for testing impact validation.",
            category="upgrade",
            impact="catastrophic",
            starts_at=_t(60),
            ends_at=_t(120),
            created_by="x",
        )


def test_end_before_start_rejected():
    with pytest.raises(maint_mod.MaintenanceError):
        maint_mod.create_window(
            tenant_id="acme",
            title="Backwards window",
            description="A perfectly fine description for testing the time ordering guard.",
            category="upgrade",
            impact="degraded",
            starts_at=_t(120),
            ends_at=_t(60),
            created_by="x",
        )


def test_window_too_long_rejected():
    with pytest.raises(maint_mod.MaintenanceError):
        maint_mod.create_window(
            tenant_id="acme",
            title="Forever window",
            description="A perfectly fine description for testing the max-duration guard.",
            category="upgrade",
            impact="degraded",
            starts_at=_t(60),
            ends_at=_t(60 + 60 * 24 * 60),
            created_by="x",
        )


def test_window_too_short_rejected():
    with pytest.raises(maint_mod.MaintenanceError):
        maint_mod.create_window(
            tenant_id="acme",
            title="Blink window",
            description="A perfectly fine description for testing the min-duration guard.",
            category="upgrade",
            impact="degraded",
            starts_at=_t(60),
            ends_at=(_t(60) + timedelta(seconds=10)),
            created_by="x",
        )


def test_duplicate_title_and_start_within_tenant_rejected():
    start = _t(60)
    end = _t(120)
    maint_mod.create_window(
        tenant_id="acme",
        title="Cache flush",
        description="A perfectly fine description for testing the unique guard.",
        category="maintenance",
        impact="none",
        starts_at=start,
        ends_at=end,
        created_by="x",
    )
    with pytest.raises(maint_mod.MaintenanceError):
        maint_mod.create_window(
            tenant_id="acme",
            title="Cache flush",
            description="A perfectly fine description for testing the unique guard.",
            category="maintenance",
            impact="none",
            starts_at=start,
            ends_at=end,
            created_by="x",
        )


def test_cross_tenant_isolation():
    """Tenant B must not see, update, archive, or observe tenant A's window."""
    a = maint_mod.create_window(
        tenant_id="acme",
        title="Tenant A only",
        description="Tenant A schedules its own maintenance against its own data plane.",
        category="security_patch",
        impact="full_outage",
        starts_at=_t(-5),
        ends_at=_t(55),
        created_by="root@acme",
    )

    assert maint_mod.list_windows(tenant_id="globex") == []
    assert maint_mod.get_window(tenant_id="globex", window_id=a.id) is None
    assert maint_mod.active_windows("globex") == []

    assert maint_mod.update_window(
        tenant_id="globex",
        window_id=a.id,
        updated_by="attacker@globex",
        impact="none",
    ) is None

    assert maint_mod.archive_window(
        tenant_id="globex",
        window_id=a.id,
        archived_by="attacker@globex",
    ) is None

    after = maint_mod.get_window(tenant_id="acme", window_id=a.id)
    assert after is not None
    assert after.active is True
    assert after.version == 1
    assert after.impact == "full_outage"


def test_active_windows_excludes_archived_and_out_of_range():
    in_flight = maint_mod.create_window(
        tenant_id="acme",
        title="Currently rolling",
        description="A perfectly fine description for testing active-window detection.",
        category="upgrade",
        impact="degraded",
        starts_at=_t(-10),
        ends_at=_t(20),
        created_by="x",
    )
    future = maint_mod.create_window(
        tenant_id="acme",
        title="Later this week",
        description="A perfectly fine description for testing scheduled-status detection.",
        category="maintenance",
        impact="none",
        starts_at=_t(60),
        ends_at=_t(120),
        created_by="x",
    )
    past = maint_mod.create_window(
        tenant_id="acme",
        title="Already done",
        description="A perfectly fine description for testing completed-status detection.",
        category="maintenance",
        impact="none",
        starts_at=_t(-120),
        ends_at=_t(-60),
        created_by="x",
    )
    cancelled = maint_mod.create_window(
        tenant_id="acme",
        title="Was going to roll now",
        description="A perfectly fine description for a window we cancel mid-flight.",
        category="upgrade",
        impact="degraded",
        starts_at=_t(-5),
        ends_at=_t(25),
        created_by="x",
    )
    maint_mod.archive_window(
        tenant_id="acme",
        window_id=cancelled.id,
        archived_by="x",
        reason="Superseded by another window.",
    )

    active = maint_mod.active_windows("acme")
    ids = {w.id for w in active}
    assert in_flight.id in ids
    assert future.id not in ids
    assert past.id not in ids
    assert cancelled.id not in ids
    assert maint_mod.upcoming_count("acme") == 1
