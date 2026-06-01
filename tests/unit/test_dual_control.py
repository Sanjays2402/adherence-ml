"""Tests for per-tenant dual-control (four-eyes) approval workflow.

Covers:

* Self-approval is refused: the requester cannot approve their own
  pending request.
* Cross-tenant isolation: a request on tenant A is invisible to
  tenant B; an approval attempt from tenant B is a no-op (raises
  ``request not found``) even when the row id collides.
* ``ensure_approved`` is a no-op when the action type is not gated.
* ``ensure_approved`` raises until a matching approval exists, and
  payload tampering invalidates the approval.
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

from adherence_common import dual_control as dc  # noqa: E402
from adherence_common.dual_control import (  # noqa: E402
    DualControlPolicy,
    DualControlRequest,
)
from adherence_common.db import init_db, session  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh():
    init_db()
    with session() as s:
        s.execute(delete(DualControlRequest))
        s.execute(delete(DualControlPolicy))
        s.commit()
    yield
    with session() as s:
        s.execute(delete(DualControlRequest))
        s.execute(delete(DualControlPolicy))
        s.commit()


def test_policy_round_trip_and_gating():
    assert dc.is_gated(tenant_id="acme", action_type="legal_hold.release") is False
    view = dc.set_policy(
        tenant_id="acme",
        action_type="legal_hold.release",
        created_by="owner@acme",
        description="Lifting a preservation order needs two admins.",
    )
    assert view.action_type == "legal_hold.release"
    assert view.tenant_id == "acme"
    assert dc.is_gated(tenant_id="acme", action_type="legal_hold.release") is True
    # Different tenant must NOT inherit the policy.
    assert dc.is_gated(tenant_id="other", action_type="legal_hold.release") is False
    assert dc.clear_policy(tenant_id="acme", action_type="legal_hold.release") is True
    assert dc.is_gated(tenant_id="acme", action_type="legal_hold.release") is False


def test_self_approval_is_refused():
    req = dc.create_request(
        tenant_id="acme",
        action_type="legal_hold.release",
        payload={"hold_id": 1, "release_reason": "matter closed"},
        reason="matter SUP-9 closed per counsel runbook",
        requested_by="alice@acme",
    )
    assert req.status == dc.STATUS_PENDING
    with pytest.raises(dc.DualControlError) as ei:
        dc.approve_request(
            tenant_id="acme",
            request_id=req.id,
            approver="alice@acme",
        )
    assert "self approval" in str(ei.value).lower()
    # A different admin succeeds.
    view = dc.approve_request(
        tenant_id="acme",
        request_id=req.id,
        approver="bob@acme",
        decision_reason="reviewed runbook, signed off",
    )
    assert view.status == dc.STATUS_APPROVED
    assert view.decided_by == "bob@acme"


def test_cross_tenant_isolation():
    a = dc.create_request(
        tenant_id="acme",
        action_type="legal_hold.release",
        payload={"hold_id": 1},
        reason="matter SUP-9 closed per counsel runbook",
        requested_by="alice@acme",
    )
    b = dc.create_request(
        tenant_id="other",
        action_type="legal_hold.release",
        payload={"hold_id": 1},
        reason="matter SUP-9 closed per counsel runbook",
        requested_by="alice@other",
    )
    # Each tenant only sees its own row.
    acme_list = dc.list_requests(tenant_id="acme")
    other_list = dc.list_requests(tenant_id="other")
    assert {r.id for r in acme_list} == {a.id}
    assert {r.id for r in other_list} == {b.id}

    # Tenant B cannot approve tenant A's request even by guessing its
    # id. The query is scoped by tenant_id, so the lookup misses.
    with pytest.raises(dc.DualControlError) as ei:
        dc.approve_request(
            tenant_id="other",
            request_id=a.id,
            approver="bob@other",
        )
    assert "not found" in str(ei.value).lower()

    # And the get accessor returns None for cross-tenant ids.
    assert dc.get_request(tenant_id="other", request_id=a.id) is None
    assert dc.get_request(tenant_id="acme", request_id=b.id) is None


def test_ensure_approved_no_gate_is_noop():
    # Action type is not gated; ensure_approved returns None and the
    # caller proceeds in single-control mode.
    out = dc.ensure_approved(
        tenant_id="acme",
        action_type="cmek.rotate",
        payload={"key_id": "k1"},
        principal_id="alice@acme",
    )
    assert out is None


def test_ensure_approved_requires_matching_payload():
    dc.set_policy(
        tenant_id="acme",
        action_type="legal_hold.release",
        created_by="owner@acme",
    )
    # No approval yet: must raise.
    with pytest.raises(dc.DualControlError):
        dc.ensure_approved(
            tenant_id="acme",
            action_type="legal_hold.release",
            payload={"hold_id": 7, "release_reason": "x"},
            principal_id="alice@acme",
        )

    req = dc.create_request(
        tenant_id="acme",
        action_type="legal_hold.release",
        payload={"hold_id": 7, "release_reason": "x"},
        reason="matter SUP-7 closed per counsel runbook",
        requested_by="alice@acme",
    )
    dc.approve_request(
        tenant_id="acme", request_id=req.id, approver="bob@acme"
    )

    # Tampered payload: hash mismatch, still raises.
    with pytest.raises(dc.DualControlError):
        dc.ensure_approved(
            tenant_id="acme",
            action_type="legal_hold.release",
            payload={"hold_id": 7, "release_reason": "DIFFERENT"},
            principal_id="alice@acme",
        )

    # Exact match: returns the approved request view.
    out = dc.ensure_approved(
        tenant_id="acme",
        action_type="legal_hold.release",
        payload={"hold_id": 7, "release_reason": "x"},
        principal_id="alice@acme",
    )
    assert out is not None
    assert out.id == req.id
    assert out.status == dc.STATUS_APPROVED

    # After execution the approval is consumed and cannot be reused.
    exec_view = dc.mark_executed(tenant_id="acme", request_id=req.id)
    assert exec_view is not None
    assert exec_view.status == dc.STATUS_EXECUTED
    with pytest.raises(dc.DualControlError):
        dc.ensure_approved(
            tenant_id="acme",
            action_type="legal_hold.release",
            payload={"hold_id": 7, "release_reason": "x"},
            principal_id="alice@acme",
        )


def test_cancel_only_by_requester():
    req = dc.create_request(
        tenant_id="acme",
        action_type="legal_hold.release",
        payload={"hold_id": 1},
        reason="matter SUP-9 closed per counsel runbook",
        requested_by="alice@acme",
    )
    with pytest.raises(dc.DualControlError) as ei:
        dc.cancel_request(
            tenant_id="acme", request_id=req.id, canceller="bob@acme"
        )
    assert "requester" in str(ei.value).lower()
    cancelled = dc.cancel_request(
        tenant_id="acme", request_id=req.id, canceller="alice@acme"
    )
    assert cancelled.status == dc.STATUS_CANCELLED
