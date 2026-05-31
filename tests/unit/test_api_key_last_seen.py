"""Best-effort last-seen IP / User-Agent attribution on resolved API keys.

Enterprise SOC2 reviewers want to answer "where was this key just used
from?" without spelunking the request log. The resolver writes the most
recent client IP and UA back to the credential row via touch_last_seen;
this test proves the round trip works for a fresh key and that an empty
update is a no-op (we never clobber a recorded value with blanks).
"""
from __future__ import annotations

import sys

import pytest


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    db_file = tmp_path / "api_key_last_seen.db"
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith("adherence_common") or mod.startswith("adherence_api"):
            sys.modules.pop(mod, None)
    yield


def _fresh():
    from adherence_common import api_keys, db
    db.init_db()
    return api_keys


def test_touch_last_seen_records_ip_and_user_agent():
    ak = _fresh()
    plaintext, row = ak.create_key(
        name="svc-edge",
        role="service",
        tenant_id="acme",
    )
    record_id = row.id
    resolved = ak.resolve_db_key(plaintext)
    assert resolved is not None
    assert resolved.record_id == record_id

    ak.touch_last_seen(
        record_id,
        client_ip="203.0.113.42",
        user_agent="curl/8.5.0",
    )

    from adherence_common.api_keys import APIKeyRecord
    from adherence_common.db import session
    from sqlalchemy import select
    with session() as s:
        row2 = s.execute(
            select(APIKeyRecord).where(APIKeyRecord.id == record_id)
        ).scalar_one()
        assert row2.last_used_ip == "203.0.113.42"
        assert row2.last_used_user_agent == "curl/8.5.0"
        assert row2.last_used_at is not None


def test_touch_last_seen_truncates_oversized_user_agent():
    ak = _fresh()
    _, row = ak.create_key(name="svc-trunc", role="service", tenant_id="acme")
    record_id = row.id
    long_ua = "AcmeBot/" + ("x" * 1024)
    ak.touch_last_seen(
        record_id,
        client_ip="198.51.100.7",
        user_agent=long_ua,
    )

    from adherence_common.api_keys import APIKeyRecord
    from adherence_common.db import session
    from sqlalchemy import select
    with session() as s:
        row2 = s.execute(
            select(APIKeyRecord).where(APIKeyRecord.id == record_id)
        ).scalar_one()
        assert row2.last_used_ip == "198.51.100.7"
        assert len(row2.last_used_user_agent) <= 256
        assert row2.last_used_user_agent.startswith("AcmeBot/")


def test_touch_last_seen_with_blanks_is_a_noop():
    ak = _fresh()
    _, row = ak.create_key(name="svc-noop", role="service", tenant_id="acme")
    record_id = row.id
    ak.touch_last_seen(record_id, client_ip="10.1.2.3", user_agent="ua-1")
    # Subsequent call with empty meta must not clobber the recorded values.
    ak.touch_last_seen(record_id, client_ip="", user_agent="   ")

    from adherence_common.api_keys import APIKeyRecord
    from adherence_common.db import session
    from sqlalchemy import select
    with session() as s:
        row2 = s.execute(
            select(APIKeyRecord).where(APIKeyRecord.id == record_id)
        ).scalar_one()
        assert row2.last_used_ip == "10.1.2.3"
        assert row2.last_used_user_agent == "ua-1"


def test_touch_last_seen_does_not_cross_tenants():
    ak = _fresh()
    _, a_row = ak.create_key(name="acme-key", role="service", tenant_id="acme")
    _, b_row = ak.create_key(name="beta-key", role="service", tenant_id="beta")
    ak.touch_last_seen(a_row.id, client_ip="10.0.0.1", user_agent="acme-cli")
    ak.touch_last_seen(b_row.id, client_ip="10.0.0.2", user_agent="beta-cli")

    from adherence_common.api_keys import APIKeyRecord
    from adherence_common.db import session
    from sqlalchemy import select
    with session() as s:
        a2 = s.execute(
            select(APIKeyRecord).where(APIKeyRecord.id == a_row.id)
        ).scalar_one()
        b2 = s.execute(
            select(APIKeyRecord).where(APIKeyRecord.id == b_row.id)
        ).scalar_one()
        assert a2.tenant_id == "acme"
        assert a2.last_used_ip == "10.0.0.1"
        assert a2.last_used_user_agent == "acme-cli"
        assert b2.tenant_id == "beta"
        assert b2.last_used_ip == "10.0.0.2"
        assert b2.last_used_user_agent == "beta-cli"
