"""Per-workspace seat enforcement for API key issuance.

Covers: tenant isolation (one workspace's seat usage does not block
another), enforce_seat_capacity raises at the plan cap, revoking a key
frees the seat, and expired keys do not count toward usage.
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta

import pytest


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    db_file = tmp_path / "seats.db"
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith("adherence_common") or mod.startswith("adherence_api"):
            sys.modules.pop(mod, None)
    yield


def _fresh():
    from adherence_common import api_keys as ak
    from adherence_common import db, quota
    db.init_db()
    return ak, db, quota


def _mk(ak, *, name: str, tenant: str, ttl: int | None = None) -> str:
    plain, _row = ak.create_key(
        name=name, role="service", tenant_id=tenant, ttl_seconds=ttl,
    )
    return plain


def test_seat_usage_counts_only_active_keys_in_tenant():
    ak, _, q = _fresh()
    _mk(ak, name="acme-1", tenant="acme")
    _mk(ak, name="acme-2", tenant="acme")
    _mk(ak, name="beta-1", tenant="beta")
    assert q.seat_usage("acme") == 2
    assert q.seat_usage("beta") == 1
    # Tenant isolation: revoke does not affect the other.
    ak.revoke_key("acme-1")
    assert q.seat_usage("acme") == 1
    assert q.seat_usage("beta") == 1


def test_expired_key_does_not_consume_a_seat():
    ak, _, q = _fresh()
    # ttl=1s then backdate via direct ORM patch so the row is in the past.
    from adherence_common.db import session
    from adherence_common.api_keys import APIKeyRecord
    from sqlalchemy import select
    _mk(ak, name="acme-1", tenant="acme")
    _mk(ak, name="acme-2", tenant="acme", ttl=3600)
    with session() as s:
        row = s.execute(
            select(APIKeyRecord).where(APIKeyRecord.name == "acme-2")
        ).scalar_one()
        row.expires_at = datetime.utcnow() - timedelta(seconds=10)
        s.commit()
    assert q.seat_usage("acme") == 1


def test_enforce_seat_capacity_raises_at_plan_cap_and_isolates_tenants():
    ak, _, q = _fresh()
    # free plan = 3 seats.
    q.set_plan("acme", plan="free")
    q.set_plan("beta", plan="free")
    for i in range(3):
        _mk(ak, name=f"acme-{i}", tenant="acme")
    # acme is full; beta untouched.
    with pytest.raises(q.SeatLimitExceeded) as exc:
        q.enforce_seat_capacity("acme")
    assert exc.value.tenant_id == "acme"
    assert exc.value.used == 3
    assert exc.value.limit == 3
    assert exc.value.plan == "free"
    # Cross-tenant safety: beta still has all 3 seats available.
    used_after, limit, plan = q.enforce_seat_capacity("beta")
    assert (used_after, limit, plan) == (1, 3, "free")

    # Revoking on acme frees a seat; enforcement passes again.
    ak.revoke_key("acme-0")
    used_after, limit, plan = q.enforce_seat_capacity("acme")
    assert (used_after, limit, plan) == (3, 3, "free")


def test_seats_override_raises_effective_cap():
    ak, _, q = _fresh()
    q.set_plan("acme", plan="free", seats_override=5)
    for i in range(5):
        _mk(ak, name=f"acme-{i}", tenant="acme")
    with pytest.raises(q.SeatLimitExceeded):
        q.enforce_seat_capacity("acme")
