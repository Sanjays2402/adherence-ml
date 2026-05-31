"""Per-workspace HUMAN member seat enforcement.

Covers: tenant isolation (one workspace's member usage does not block
another), pending invitations count toward the seat budget, the third
invite is rejected with ``MemberSeatLimitExceeded`` on the free plan,
acceptance is seat-neutral (pending -> member), revoking an invite
frees a seat, and a per-workspace ``member_seats_override`` raises the
effective cap.
"""
from __future__ import annotations

import sys

import pytest


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    db_file = tmp_path / "member_seats.db"
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith("adherence_common") or mod.startswith("adherence_api"):
            sys.modules.pop(mod, None)
    yield


def _fresh():
    from adherence_common import db, memberships, quota
    db.init_db()
    return memberships, quota


def test_member_seat_usage_counts_members_and_pending_invites():
    mem, q = _fresh()
    mem.upsert_member("acme", "a@acme.test", role="admin", added_by="root")
    mem.upsert_member("acme", "b@acme.test", role="viewer", added_by="root")
    mem.create_invitation(
        tenant_id="acme", email="c@acme.test", role="viewer", invited_by="root",
    )
    mem.upsert_member("beta", "x@beta.test", role="admin", added_by="root")

    total_a, members_a, pending_a = q.member_seat_usage("acme")
    assert (total_a, members_a, pending_a) == (3, 2, 1)
    total_b, members_b, pending_b = q.member_seat_usage("beta")
    assert (total_b, members_b, pending_b) == (1, 1, 0)


def test_invite_is_blocked_at_member_seat_cap_and_isolates_tenants():
    mem, q = _fresh()
    q.set_plan("acme", plan="free")  # member_seats=3
    q.set_plan("beta", plan="free")

    mem.upsert_member("acme", "a@acme.test", role="admin", added_by="root")
    mem.create_invitation(
        tenant_id="acme", email="b@acme.test", role="viewer", invited_by="root",
    )
    mem.create_invitation(
        tenant_id="acme", email="c@acme.test", role="viewer", invited_by="root",
    )
    # Fourth seat (third invite) trips the gate.
    with pytest.raises(q.MemberSeatLimitExceeded) as exc:
        mem.create_invitation(
            tenant_id="acme", email="d@acme.test", role="viewer", invited_by="root",
        )
    assert exc.value.tenant_id == "acme"
    assert exc.value.used == 3
    assert exc.value.limit == 3
    assert exc.value.plan == "free"
    assert exc.value.members == 1
    assert exc.value.pending == 2

    # Cross-tenant safety: beta still has the whole plan available.
    used_after, limit, plan = q.enforce_member_seat_capacity("beta", extra=1)
    assert (used_after, limit, plan) == (1, 3, "free")


def test_accept_invitation_is_seat_neutral_and_revoke_frees_seat():
    mem, q = _fresh()
    q.set_plan("acme", plan="free")
    mem.upsert_member("acme", "a@acme.test", role="admin", added_by="root")
    token1, view1 = mem.create_invitation(
        tenant_id="acme", email="b@acme.test", role="viewer", invited_by="root",
    )
    _token2, view2 = mem.create_invitation(
        tenant_id="acme", email="c@acme.test", role="viewer", invited_by="root",
    )
    # Workspace is full: 1 member + 2 pending = 3.
    assert q.member_seat_usage("acme")[0] == 3

    # Accept the first invite: pending falls by 1, members rises by 1.
    mem.accept_invitation(token1, subject="b@acme.test", expected_email="b@acme.test")
    total, members, pending = q.member_seat_usage("acme")
    assert (total, members, pending) == (3, 2, 1)

    # Still no headroom for a fourth seat.
    with pytest.raises(q.MemberSeatLimitExceeded):
        q.enforce_member_seat_capacity("acme", extra=1)

    # Revoke the remaining pending invite: a seat opens up.
    mem.revoke_invitation(view2.id, tenant_id="acme", revoked_by="root")
    used_after, _limit, _plan = q.enforce_member_seat_capacity("acme", extra=1)
    assert used_after == 3  # 2 members + 1 newly invited


def test_member_seats_override_raises_effective_cap():
    mem, q = _fresh()
    q.set_plan("acme", plan="free", member_seats_override=5)
    for i in range(5):
        mem.upsert_member("acme", f"u{i}@acme.test", role="viewer", added_by="root")
    with pytest.raises(q.MemberSeatLimitExceeded):
        q.enforce_member_seat_capacity("acme", extra=1)
