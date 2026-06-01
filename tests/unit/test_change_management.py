"""Tests for per-tenant change management register.

Covers:

* Create / list / update / archive round trip with monotonic version
  bump on every update.
* Workflow: planned -> approved -> in_progress -> completed (and the
  rolled_back and cancelled branches). Bad transitions rejected.
* Four-eyes: high or critical risk and emergency changes require a
  named approver distinct from the requester, and the approver named
  on the request is the only principal allowed to approve it.
* Post implementation review required to close to completed or
  rolled_back.
* Cross-tenant isolation: tenant B cannot see, update, transition,
  or archive tenant A's change. This is the multi-tenancy gate
  procurement cares about.
* Validation: short title, unknown type or risk, planned_end before
  planned_start, duplicate active reference, bad email.
* Overdue accounting against planned_end_at while not terminal.
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

from adherence_common import change_management as cm  # noqa: E402
from adherence_common.change_management import ChangeRequest  # noqa: E402
from adherence_common.db import init_db, session  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh():
    init_db()
    with session() as s:
        s.execute(delete(ChangeRequest))
        s.commit()
    yield
    with session() as s:
        s.execute(delete(ChangeRequest))
        s.commit()


def _mk(tenant="acme", **kw):
    return cm.create_change(
        tenant_id=tenant,
        title=kw.pop("title", "Roll forecast worker to v3.4"),
        change_type=kw.pop("change_type", "normal"),
        risk_class=kw.pop("risk_class", "low"),
        affected_service=kw.pop("affected_service", "inference_worker"),
        rollback_plan=kw.pop(
            "rollback_plan",
            "Re-tag previous image and trigger blue-green rollback.",
        ),
        requester_email=kw.pop("requester_email", "alice@acme.example"),
        approver_email=kw.pop("approver_email", None),
        created_by=kw.pop("created_by", "alice@acme.example"),
        notes=kw.pop("notes", None),
        reference=kw.pop("reference", None),
        planned_start_at=kw.pop("planned_start_at", None),
        planned_end_at=kw.pop("planned_end_at", None),
    )


def test_empty_register():
    assert cm.list_changes(tenant_id="acme") == []
    assert cm.active_count("acme") == 0
    assert cm.open_count("acme") == 0
    assert cm.overdue_count("acme") == 0
    assert cm.highest_open_risk("acme") == "low"


def test_create_list_update_archive_round_trip():
    v = _mk(reference="CHG-1001")
    assert v.active is True
    assert v.version == 1
    assert v.status == "planned"
    assert v.requires_approver is False
    assert v.is_terminal is False

    listed = cm.list_changes(tenant_id="acme")
    assert len(listed) == 1 and listed[0].id == v.id

    updated = cm.update_change(
        tenant_id="acme",
        change_id=v.id,
        updated_by="alice@acme.example",
        title="Roll forecast worker to v3.4 (extended window)",
        notes="Bumping window after capacity review.",
    )
    assert updated is not None
    assert updated.version == 2
    assert updated.notes is not None

    archived = cm.archive_change(
        tenant_id="acme", change_id=v.id, archived_by="ciso@acme.example"
    )
    assert archived is not None and archived.active is False
    assert cm.list_changes(tenant_id="acme") == []
    assert (
        len(cm.list_changes(tenant_id="acme", include_archived=True)) == 1
    )


def test_full_workflow_to_completed_requires_review():
    v = _mk(
        risk_class="high",
        approver_email="bob@acme.example",
    )
    assert v.requires_approver is True

    # Requester cannot self-approve.
    with pytest.raises(cm.ChangeError):
        cm.transition_change(
            tenant_id="acme",
            change_id=v.id,
            target_status="approved",
            actor_email="alice@acme.example",
            actor="alice@acme.example",
        )

    approved = cm.transition_change(
        tenant_id="acme",
        change_id=v.id,
        target_status="approved",
        actor_email="bob@acme.example",
        actor="bob@acme.example",
    )
    assert approved is not None
    assert approved.status == "approved"
    assert approved.approved_at is not None
    assert approved.approved_by == "bob@acme.example"

    started = cm.transition_change(
        tenant_id="acme",
        change_id=v.id,
        target_status="in_progress",
        actor_email="alice@acme.example",
        actor="alice@acme.example",
    )
    assert started is not None
    assert started.status == "in_progress"
    assert started.actual_start_at is not None

    # Closing requires a review summary.
    with pytest.raises(cm.ChangeError):
        cm.transition_change(
            tenant_id="acme",
            change_id=v.id,
            target_status="completed",
            actor_email="alice@acme.example",
            actor="alice@acme.example",
        )

    closed = cm.transition_change(
        tenant_id="acme",
        change_id=v.id,
        target_status="completed",
        actor_email="alice@acme.example",
        actor="alice@acme.example",
        review_summary="Deployed without incident. Latency steady.",
    )
    assert closed is not None
    assert closed.status == "completed"
    assert closed.is_terminal is True
    assert closed.has_review is True
    assert closed.actual_end_at is not None
    assert cm.open_count("acme") == 0


def test_rollback_branch_records_review_and_blocks_edits():
    v = _mk()
    cm.transition_change(
        tenant_id="acme",
        change_id=v.id,
        target_status="approved",
        actor_email="alice@acme.example",  # low risk: any actor
        actor="alice@acme.example",
    ) if False else None
    # Low risk has no approver, so move planned -> cancelled is allowed
    # via the cancelled branch in another test. Here exercise the
    # rolled_back leaf by attaching an approver and walking the path.
    cm.update_change(
        tenant_id="acme",
        change_id=v.id,
        updated_by="alice@acme.example",
        risk_class="critical",
        approver_email="bob@acme.example",
    )
    cm.transition_change(
        tenant_id="acme",
        change_id=v.id,
        target_status="approved",
        actor_email="bob@acme.example",
        actor="bob@acme.example",
    )
    cm.transition_change(
        tenant_id="acme",
        change_id=v.id,
        target_status="in_progress",
        actor_email="alice@acme.example",
        actor="alice@acme.example",
    )
    rb = cm.transition_change(
        tenant_id="acme",
        change_id=v.id,
        target_status="rolled_back",
        actor_email="alice@acme.example",
        actor="alice@acme.example",
        review_summary="Latency regression on canary. Rolled back at 02:14Z.",
    )
    assert rb is not None
    assert rb.status == "rolled_back"
    assert rb.is_terminal is True

    # Cannot edit a terminal change.
    with pytest.raises(cm.ChangeError):
        cm.update_change(
            tenant_id="acme",
            change_id=v.id,
            updated_by="alice@acme.example",
            notes="late edit",
        )


def test_cancellation_allowed_from_planned_and_approved_only():
    v = _mk()
    cancelled = cm.transition_change(
        tenant_id="acme",
        change_id=v.id,
        target_status="cancelled",
        actor_email="alice@acme.example",
        actor="alice@acme.example",
    )
    assert cancelled is not None and cancelled.status == "cancelled"

    v2 = _mk(
        title="Cycle keys",
        risk_class="high",
        approver_email="bob@acme.example",
    )
    cm.transition_change(
        tenant_id="acme",
        change_id=v2.id,
        target_status="approved",
        actor_email="bob@acme.example",
        actor="bob@acme.example",
    )
    cm.transition_change(
        tenant_id="acme",
        change_id=v2.id,
        target_status="in_progress",
        actor_email="alice@acme.example",
        actor="alice@acme.example",
    )
    # Cannot cancel once in_progress.
    with pytest.raises(cm.ChangeError):
        cm.transition_change(
            tenant_id="acme",
            change_id=v2.id,
            target_status="cancelled",
            actor_email="alice@acme.example",
            actor="alice@acme.example",
        )


def test_four_eyes_required_for_high_critical_and_emergency():
    with pytest.raises(cm.ChangeError):
        _mk(risk_class="high")  # missing approver
    with pytest.raises(cm.ChangeError):
        _mk(risk_class="critical", approver_email="alice@acme.example")
    with pytest.raises(cm.ChangeError):
        _mk(change_type="emergency")  # missing approver
    # Low risk normal does not require an approver.
    v = _mk()
    assert v.requires_approver is False


def test_cross_tenant_isolation_is_total():
    a = _mk(
        tenant="acme",
        risk_class="high",
        approver_email="bob@acme.example",
    )
    b = _mk(
        tenant="globex",
        risk_class="high",
        approver_email="bob@globex.example",
        requester_email="alice@globex.example",
        created_by="alice@globex.example",
    )
    assert a.id != b.id

    assert {e.id for e in cm.list_changes(tenant_id="acme")} == {a.id}
    assert {e.id for e in cm.list_changes(tenant_id="globex")} == {b.id}

    # Wrong-tenant reads return None.
    assert cm.get_change(tenant_id="globex", change_id=a.id) is None
    assert cm.get_change(tenant_id="acme", change_id=b.id) is None

    # Wrong-tenant update is a silent miss.
    assert (
        cm.update_change(
            tenant_id="globex",
            change_id=a.id,
            updated_by="attacker@globex.example",
            notes="pwn",
        )
        is None
    )
    fresh = cm.get_change(tenant_id="acme", change_id=a.id)
    assert fresh is not None and fresh.version == 1 and fresh.notes is None

    # Wrong-tenant transition is a silent miss.
    assert (
        cm.transition_change(
            tenant_id="globex",
            change_id=a.id,
            target_status="approved",
            actor_email="bob@acme.example",
            actor="attacker@globex.example",
        )
        is None
    )
    fresh = cm.get_change(tenant_id="acme", change_id=a.id)
    assert fresh is not None and fresh.status == "planned"

    # Wrong-tenant archive is a silent miss.
    assert (
        cm.archive_change(
            tenant_id="globex",
            change_id=a.id,
            archived_by="attacker@globex.example",
        )
        is None
    )
    fresh = cm.get_change(tenant_id="acme", change_id=a.id)
    assert fresh is not None and fresh.active is True

    # Aggregates are per-tenant.
    assert cm.open_count("acme") == 1
    assert cm.open_count("globex") == 1
    assert cm.highest_open_risk("acme") == "high"
    assert cm.highest_open_risk("globex") == "high"


def test_validation_rejects_bad_inputs():
    with pytest.raises(cm.ChangeError):
        _mk(title="x")  # too short
    with pytest.raises(cm.ChangeError):
        _mk(change_type="weird")
    with pytest.raises(cm.ChangeError):
        _mk(risk_class="extreme")
    with pytest.raises(cm.ChangeError):
        _mk(requester_email="not-an-email")
    with pytest.raises(cm.ChangeError):
        _mk(rollback_plan="no")  # too short
    # planned_end must be after planned_start
    start = datetime.utcnow() + timedelta(hours=2)
    with pytest.raises(cm.ChangeError):
        _mk(
            planned_start_at=start,
            planned_end_at=start - timedelta(minutes=10),
        )
    # Duplicate active reference within tenant rejected.
    _mk(reference="CHG-2002")
    with pytest.raises(cm.ChangeError):
        _mk(reference="CHG-2002", title="Same reference, different title")


def test_overdue_tracking_against_planned_end():
    long_ago = datetime.utcnow() - timedelta(hours=12)
    earlier = long_ago - timedelta(hours=1)
    v = _mk(planned_start_at=earlier, planned_end_at=long_ago)
    assert v.is_overdue is True
    assert cm.overdue_count("acme") == 1

    # Closing the change clears overdue accounting.
    cm.transition_change(
        tenant_id="acme",
        change_id=v.id,
        target_status="cancelled",
        actor_email="alice@acme.example",
        actor="alice@acme.example",
    )
    assert cm.overdue_count("acme") == 0
