"""Tamper-evident hash chain for the admin audit log.

Enterprise auditors (SOC2 CC7.2, ISO 27001 A.12.4.2) require that
admin-plane audit rows be append-only and detect tampering. This test
proves the contract end-to-end without mocks:

* every ``record_admin_action`` call populates ``prev_hash`` and
  ``row_hash`` so the chain is contiguous,
* a clean chain verifies (``ok=True``, no breaks),
* mutating any field of a committed row (here ``details``) is detected
  by ``verify_chain`` and reported with row id and reason,
* deleting a row in the middle of the chain breaks the prev_hash link
  on the successor and is also reported.
"""
from __future__ import annotations

import sys

import pytest


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    db_file = tmp_path / "admin_audit_chain.db"
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith("adherence_common") or mod.startswith("adherence_api"):
            sys.modules.pop(mod, None)
    yield


def _bootstrap():
    from adherence_common import db
    db.init_db()
    from adherence_common.admin_audit import record_admin_action
    from adherence_common.admin_audit_chain import verify_chain
    from adherence_common.db import AdminAuditLog, session
    return record_admin_action, verify_chain, AdminAuditLog, session


def _principal(tenant: str = "acme", role: str = "admin", sub: str = "owner@acme") -> dict:
    return {"tenant": tenant, "role": role, "sub": sub}


def test_chain_is_assigned_and_verifies_clean():
    record_admin_action, verify_chain, AdminAuditLog, session = _bootstrap()

    ids = []
    for action in ("api_key.create", "api_key.rotate", "model.rollback"):
        ids.append(
            record_admin_action(
                action=action,
                principal=_principal(),
                target="svc-edge",
                details={"k": action},
            )
        )
    assert all(i is not None for i in ids)

    with session() as s:
        rows = s.query(AdminAuditLog).order_by(AdminAuditLog.id.asc()).all()
        assert len(rows) == 3
        assert rows[0].prev_hash is None
        assert rows[0].row_hash is not None
        for prev, cur in zip(rows, rows[1:]):
            assert cur.prev_hash == prev.row_hash
            assert cur.row_hash and cur.row_hash != prev.row_hash

    result = verify_chain(tenant_id="acme")
    assert result.ok is True
    assert result.n_rows == 3
    assert result.n_hashed == 3
    assert result.breaks == []
    assert result.head_hash is not None


def test_chain_detects_field_tampering():
    record_admin_action, verify_chain, AdminAuditLog, session = _bootstrap()

    for action in ("api_key.create", "api_key.revoke", "gdpr.erase"):
        record_admin_action(
            action=action,
            principal=_principal(),
            target="user-1",
            details={"k": action},
        )

    # An attacker (or buggy migration) edits the middle row to hide what
    # actually happened. The stored row_hash no longer matches the
    # recomputed value, so verify_chain flags the row id and reason.
    with session() as s:
        middle = s.query(AdminAuditLog).order_by(AdminAuditLog.id.asc()).all()[1]
        middle.details = {"k": "tampered"}
        s.commit()
        tampered_id = int(middle.id)

    result = verify_chain(tenant_id="acme")
    assert result.ok is False
    reasons = {(b.row_id, b.reason) for b in result.breaks}
    assert (tampered_id, "row_hash_mismatch") in reasons


def test_chain_detects_row_deletion():
    record_admin_action, verify_chain, AdminAuditLog, session = _bootstrap()

    for action in ("api_key.create", "api_key.rotate", "api_key.revoke"):
        record_admin_action(
            action=action,
            principal=_principal(),
            target="svc-x",
            details={"k": action},
        )

    # Delete the middle row. The third row's prev_hash now points to a
    # row_hash that no longer exists in the table, so its expected_prev
    # (the first row's hash) won't match.
    with session() as s:
        rows = s.query(AdminAuditLog).order_by(AdminAuditLog.id.asc()).all()
        survivor_id = int(rows[2].id)
        s.delete(rows[1])
        s.commit()

    result = verify_chain(tenant_id="acme")
    assert result.ok is False
    assert any(
        b.row_id == survivor_id and b.reason == "prev_hash_mismatch"
        for b in result.breaks
    )


def test_chain_is_tenant_scopeable_without_false_positives():
    record_admin_action, verify_chain, _AdminAuditLog, _session = _bootstrap()

    # Interleave two tenants. Per-tenant verification must not flag the
    # other tenant's rows that sit between this tenant's rows in global
    # id order.
    record_admin_action(action="a.1", principal=_principal("acme"), target="t")
    record_admin_action(action="b.1", principal=_principal("globex"), target="t")
    record_admin_action(action="a.2", principal=_principal("acme"), target="t")
    record_admin_action(action="b.2", principal=_principal("globex"), target="t")

    a = verify_chain(tenant_id="acme")
    b = verify_chain(tenant_id="globex")
    assert a.ok is True and a.n_hashed == 2
    assert b.ok is True and b.n_hashed == 2
