"""Tests for the per-tenant vendor support access grant module."""
from __future__ import annotations

import os
import tempfile
import time

import pytest

_TMP = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP.close()
os.environ["ADHERENCE_DB_URL"] = f"sqlite:///{_TMP.name}"
os.environ.setdefault("JWT_SECRET", "x" * 32)

from adherence_common.db import init_db  # noqa: E402
from adherence_common import support_access as sa  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_db():
    init_db()
    from sqlalchemy import delete
    from adherence_common.db import session
    with session() as s:
        s.execute(delete(sa.SupportAccessGrant))
        s.execute(delete(sa.SupportAccessPolicy))
        s.commit()
    yield


# ---------- policy ----------

def test_policy_absent_returns_none():
    assert sa.get_policy("acme") is None


def test_policy_set_and_get_roundtrip():
    pv = sa.set_policy("acme", require_grant=True, updated_by="owner@acme")
    assert pv.require_grant is True
    again = sa.get_policy("acme")
    assert again is not None
    assert again.require_grant is True
    assert again.updated_by == "owner@acme"


def test_policy_update_overwrites_prior_row():
    sa.set_policy("acme", require_grant=True, updated_by="a")
    sa.set_policy("acme", require_grant=False, updated_by="b")
    pv = sa.get_policy("acme")
    assert pv is not None and pv.require_grant is False
    assert pv.updated_by == "b"


# ---------- grant validation ----------

def test_create_grant_rejects_short_reason():
    with pytest.raises(ValueError):
        sa.create_grant("acme", granted_by="o", reason="too short")


def test_create_grant_rejects_out_of_range_ttl():
    with pytest.raises(ValueError):
        sa.create_grant(
            "acme",
            granted_by="o",
            reason="incident response for ticket 1234",
            ttl_seconds=1,
        )
    with pytest.raises(ValueError):
        sa.create_grant(
            "acme",
            granted_by="o",
            reason="incident response for ticket 1234",
            ttl_seconds=sa.MAX_TTL_SECONDS + 1,
        )


def test_create_grant_returns_active_view():
    gv = sa.create_grant(
        "acme",
        granted_by="owner@acme",
        reason="debug ingestion lag, ticket 9921",
        ttl_seconds=3600,
        grantee_sub="api-key:vendor-support",
    )
    assert gv.public_id.startswith("sag_")
    assert gv.is_active
    assert gv.use_count == 0
    assert gv.grantee_sub == "api-key:vendor-support"


# ---------- evaluate_access (cross-tenant gate) ----------

def test_evaluate_access_allows_when_no_policy():
    allowed, reason, grant = sa.evaluate_access("acme", "api-key:vendor-support")
    assert allowed is True
    assert reason is None
    assert grant is None


def test_evaluate_access_allows_when_policy_disabled():
    sa.set_policy("acme", require_grant=False, updated_by="o")
    allowed, reason, grant = sa.evaluate_access("acme", "api-key:vendor-support")
    assert allowed is True
    assert grant is None


def test_evaluate_access_denies_locked_tenant_without_grant():
    sa.set_policy("acme", require_grant=True, updated_by="o")
    allowed, reason, grant = sa.evaluate_access("acme", "api-key:vendor-support")
    assert allowed is False
    assert reason and "support access grant" in reason
    assert grant is None


def test_evaluate_access_allows_locked_tenant_with_matching_grant():
    sa.set_policy("acme", require_grant=True, updated_by="o")
    sa.create_grant(
        "acme",
        granted_by="owner@acme",
        reason="debug ingestion lag, ticket 9921",
        ttl_seconds=3600,
        grantee_sub="api-key:vendor-support",
    )
    allowed, _, grant = sa.evaluate_access("acme", "api-key:vendor-support")
    assert allowed is True
    assert grant is not None
    assert grant.public_id.startswith("sag_")


def test_evaluate_access_rejects_other_grantee():
    sa.set_policy("acme", require_grant=True, updated_by="o")
    sa.create_grant(
        "acme",
        granted_by="owner@acme",
        reason="ticket 9921 specific engineer only",
        ttl_seconds=3600,
        grantee_sub="api-key:alice",
    )
    allowed, reason, _ = sa.evaluate_access("acme", "api-key:bob")
    assert allowed is False
    assert reason


def test_evaluate_access_wildcard_grant_matches_any_caller():
    sa.set_policy("acme", require_grant=True, updated_by="o")
    sa.create_grant(
        "acme",
        granted_by="owner@acme",
        reason="open grant for the duration of P1 incident",
        ttl_seconds=3600,
        grantee_sub=None,
    )
    allowed, _, grant = sa.evaluate_access("acme", "api-key:any-on-call")
    assert allowed is True and grant is not None


def test_cross_tenant_isolation_grants_do_not_leak():
    """A grant on tenant A must NOT authorise access to tenant B."""
    sa.set_policy("acme", require_grant=True, updated_by="o")
    sa.set_policy("globex", require_grant=True, updated_by="o")
    sa.create_grant(
        "acme",
        granted_by="owner@acme",
        reason="acme only, ticket 1",
        ttl_seconds=3600,
        grantee_sub="api-key:vendor-support",
    )
    allowed, reason, _ = sa.evaluate_access("globex", "api-key:vendor-support")
    assert allowed is False
    assert reason
    allowed_acme, _, _ = sa.evaluate_access("acme", "api-key:vendor-support")
    assert allowed_acme is True


# ---------- revocation + expiry ----------

def test_revoked_grant_no_longer_active():
    sa.set_policy("acme", require_grant=True, updated_by="o")
    gv = sa.create_grant(
        "acme",
        granted_by="o",
        reason="debug ingestion lag, ticket 9921",
        ttl_seconds=3600,
        grantee_sub="api-key:vendor-support",
    )
    revoked = sa.revoke_grant("acme", gv.public_id, revoked_by="owner@acme")
    assert revoked is not None
    assert revoked.is_active is False
    allowed, _, _ = sa.evaluate_access("acme", "api-key:vendor-support")
    assert allowed is False


def test_expired_grant_no_longer_active():
    sa.set_policy("acme", require_grant=True, updated_by="o")
    sa.create_grant(
        "acme",
        granted_by="o",
        reason="short ttl for the unit test",
        ttl_seconds=sa.MIN_TTL_SECONDS,
        grantee_sub="api-key:vendor-support",
    )
    from adherence_common.db import session
    from sqlalchemy import update
    with session() as s:
        s.execute(
            update(sa.SupportAccessGrant).values(expires_at=int(time.time()) - 10)
        )
        s.commit()
    allowed, _, _ = sa.evaluate_access("acme", "api-key:vendor-support")
    assert allowed is False


def test_record_use_bumps_counter_and_timestamp():
    sa.set_policy("acme", require_grant=True, updated_by="o")
    gv = sa.create_grant(
        "acme",
        granted_by="o",
        reason="debug ingestion lag, ticket 9921",
        ttl_seconds=3600,
        grantee_sub="api-key:vendor-support",
    )
    sa.record_use(gv.public_id)
    sa.record_use(gv.public_id)
    listed = sa.list_grants("acme", include_inactive=True)
    target = next(g for g in listed if g.public_id == gv.public_id)
    assert target.use_count == 2
    assert target.last_used_at is not None
