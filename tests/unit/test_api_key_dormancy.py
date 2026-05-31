"""Per-workspace API-key dormancy auto-disable.

Enterprise SOC2 / ISO procurement teams require evidence that idle
credentials cannot linger indefinitely. A workspace admin can set
``max_dormant_days`` on the api-key policy; an API key that has been
unused longer than that window is auto-revoked on its next resolve
attempt, an admin-audit row is written, and the caller gets AuthError
instead of a silent env-key fallback. This test proves that contract
end-to-end without any mocks.
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta

import pytest


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    db_file = tmp_path / "api_key_dormancy.db"
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith("adherence_common") or mod.startswith("adherence_api"):
            sys.modules.pop(mod, None)
    yield


def _modules():
    from adherence_common import api_keys, api_key_policy, db
    db.init_db()
    return api_keys, api_key_policy


def test_dormant_key_auto_disables_on_next_resolve():
    api_keys, api_key_policy = _modules()
    plaintext, row = api_keys.create_key(
        name="svc-edge",
        role="service",
        tenant_id="acme",
    )
    record_id = row.id

    # Without a policy, even a very old key resolves cleanly.
    from adherence_common.api_keys import APIKeyRecord
    from adherence_common.db import session
    long_ago = datetime.utcnow() - timedelta(days=400)
    with session() as s:
        s.query(APIKeyRecord).filter(APIKeyRecord.id == record_id).update(
            {"last_used_at": long_ago, "created_at": long_ago}
        )
        s.commit()
    assert api_keys.resolve_db_key(plaintext) is not None

    # Set a 30-day dormancy window on this workspace.
    api_key_policy.set_policy(
        "acme",
        max_ttl_seconds=86400 * 365,
        require_expiry=False,
        max_dormant_days=30,
        updated_by="admin@acme",
    )

    # Re-age the key (the successful resolve above stamped last_used_at
    # back to now). The next resolve must detect dormancy and surface
    # AuthError, not silently fall back to env keys.
    with session() as s:
        s.query(APIKeyRecord).filter(APIKeyRecord.id == record_id).update(
            {"last_used_at": long_ago,
             "created_at": long_ago,
             "rotated_at": None}
        )
        s.commit()

    from adherence_common.errors import AuthError
    with pytest.raises(AuthError, match="dormant"):
        api_keys.resolve_db_key(plaintext)

    # The row is persistently revoked with a dormancy stamp.
    with session() as s:
        refreshed = s.get(APIKeyRecord, record_id)
        assert refreshed.revoked_at is not None
        assert "auto-disabled: dormant" in (refreshed.note or "")

    # Subsequent attempts continue to fail with "revoked" (not "dormant"),
    # proving the revocation persisted.
    with pytest.raises(AuthError, match="revoked"):
        api_keys.resolve_db_key(plaintext)


def test_fresh_key_inside_window_resolves():
    api_keys, api_key_policy = _modules()
    api_key_policy.set_policy(
        "acme",
        max_ttl_seconds=86400 * 365,
        require_expiry=False,
        max_dormant_days=30,
        updated_by="admin@acme",
    )
    plaintext, _row = api_keys.create_key(
        name="svc-fresh",
        role="service",
        tenant_id="acme",
    )
    # Brand-new key (created_at = now) must resolve cleanly.
    assert api_keys.resolve_db_key(plaintext) is not None


def test_dormancy_is_tenant_scoped():
    api_keys, api_key_policy = _modules()
    # Only "acme" enforces dormancy; "beta" does not.
    api_key_policy.set_policy(
        "acme",
        max_ttl_seconds=86400 * 365,
        require_expiry=False,
        max_dormant_days=15,
        updated_by="admin@acme",
    )
    p_acme, row_a = api_keys.create_key(name="a", role="service", tenant_id="acme")
    p_beta, row_b = api_keys.create_key(name="b", role="service", tenant_id="beta")

    from adherence_common.api_keys import APIKeyRecord
    from adherence_common.db import session
    long_ago = datetime.utcnow() - timedelta(days=60)
    with session() as s:
        s.query(APIKeyRecord).filter(
            APIKeyRecord.id.in_([row_a.id, row_b.id])
        ).update({"last_used_at": long_ago, "created_at": long_ago},
                 synchronize_session=False)
        s.commit()

    from adherence_common.errors import AuthError
    with pytest.raises(AuthError, match="dormant"):
        api_keys.resolve_db_key(p_acme)
    # beta has no policy: dormant key still works.
    assert api_keys.resolve_db_key(p_beta) is not None
