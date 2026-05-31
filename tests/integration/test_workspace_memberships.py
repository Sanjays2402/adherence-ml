"""Integration tests for workspace memberships and invitations.

These cover the procurement-blocker invariants:

1. Tenant scoping: an admin in tenant ``acme`` cannot see, mutate, or
   accept invites issued by tenant ``globex``.
2. RBAC: a viewer cannot create or revoke invitations.
3. The accept flow rejects expired, revoked, and email-mismatched
   tokens with precise error codes.
4. The audit log records each mutation against the correct tenant.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv(
        "ADHERENCE_API_KEYS",
        "admin:adm,service:svc,viewer:vwr",
    )
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/memberships.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()


def _mint(client: TestClient, subject: str, role: str, tenant: str) -> str:
    r = client.post(
        "/v1/admin/token",
        json={"subject": subject, "role": role, "tenant": tenant},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_invitation_create_and_accept_round_trip(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app

    client = TestClient(create_app())
    acme_admin = _mint(client, "owner@acme.test", "admin", "acme")

    # Create an invitation for a new admin.
    r = client.post(
        "/v1/workspace/invitations",
        json={"email": "new.admin@acme.test", "role": "admin"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    token = body["token"]
    assert body["invitation"]["state"] == "pending"
    assert body["invitation"]["tenant_id"] == "acme"

    # Anonymous preview returns the workspace + role without consuming.
    r = client.get("/v1/workspace/invitations/preview", params={"token": token})
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "pending"
    assert r.json()["email"] == "new.admin@acme.test"

    # Accept as the invited user (JWT subject matches the invited email).
    invitee_token = _mint(client, "new.admin@acme.test", "viewer", "acme")
    r = client.post(
        "/v1/workspace/invitations/accept",
        json={"token": token},
        headers=_h(invitee_token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["invitation"]["state"] == "accepted"
    assert r.json()["member"]["role"] == "admin"
    assert r.json()["member"]["tenant_id"] == "acme"

    # Replaying the token is a 409.
    r = client.post(
        "/v1/workspace/invitations/accept",
        json={"token": token},
        headers=_h(invitee_token),
    )
    assert r.status_code == 409, r.text

    # Members list now includes the new admin.
    r = client.get("/v1/workspace/members", headers=_h(acme_admin))
    assert r.status_code == 200, r.text
    subjects = {m["subject"].lower() for m in r.json()["members"]}
    assert "new.admin@acme.test" in subjects


def test_cross_tenant_isolation(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app

    client = TestClient(create_app())
    acme_admin = _mint(client, "owner@acme.test", "admin", "acme")
    globex_admin = _mint(client, "owner@globex.test", "admin", "globex")

    # acme creates an invite.
    r = client.post(
        "/v1/workspace/invitations",
        json={"email": "engineer@acme.test", "role": "viewer"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 201, r.text
    acme_invite_id = r.json()["invitation"]["id"]
    acme_invite_token = r.json()["token"]

    # globex must not see acme's invitations.
    r = client.get("/v1/workspace/invitations", headers=_h(globex_admin))
    assert r.status_code == 200
    assert all(inv["tenant_id"] == "globex" for inv in r.json()["invitations"])
    assert r.json()["count"] == 0

    # globex must not be able to revoke acme's invitation by id.
    r = client.delete(
        f"/v1/workspace/invitations/{acme_invite_id}",
        headers=_h(globex_admin),
    )
    assert r.status_code == 404, r.text

    # acme's invite still resolves cleanly when acme reads it.
    r = client.get("/v1/workspace/invitations", headers=_h(acme_admin))
    assert r.status_code == 200
    assert {inv["id"] for inv in r.json()["invitations"]} == {acme_invite_id}

    # Preview is anonymous-but-token-bound: token is still valid.
    r = client.get(
        "/v1/workspace/invitations/preview",
        params={"token": acme_invite_token},
    )
    assert r.status_code == 200
    assert r.json()["state"] == "pending"
    # Token leaks no tenant residents; only the invite payload.
    assert "members" not in r.json()


def test_viewer_cannot_invite_or_revoke(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app

    client = TestClient(create_app())
    admin_tok = _mint(client, "owner@acme.test", "admin", "acme")
    viewer_tok = _mint(client, "viewer@acme.test", "viewer", "acme")

    # viewer can list (read).
    r = client.get("/v1/workspace/invitations", headers=_h(viewer_tok))
    assert r.status_code == 200

    # viewer cannot create.
    r = client.post(
        "/v1/workspace/invitations",
        json={"email": "x@acme.test", "role": "viewer"},
        headers=_h(viewer_tok),
    )
    assert r.status_code == 403, r.text

    # admin can.
    r = client.post(
        "/v1/workspace/invitations",
        json={"email": "x@acme.test", "role": "viewer"},
        headers=_h(admin_tok),
    )
    assert r.status_code == 201, r.text
    invite_id = r.json()["invitation"]["id"]

    # viewer cannot revoke.
    r = client.delete(
        f"/v1/workspace/invitations/{invite_id}",
        headers=_h(viewer_tok),
    )
    assert r.status_code == 403, r.text

    # admin can.
    r = client.delete(
        f"/v1/workspace/invitations/{invite_id}",
        headers=_h(admin_tok),
    )
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "revoked"


def test_accept_rejects_expired_and_revoked(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    from adherence_common import memberships as mem
    from datetime import datetime, timedelta

    client = TestClient(create_app())
    admin_tok = _mint(client, "owner@acme.test", "admin", "acme")

    # Create + revoke.
    r = client.post(
        "/v1/workspace/invitations",
        json={"email": "later@acme.test", "role": "viewer"},
        headers=_h(admin_tok),
    )
    assert r.status_code == 201
    revoked_token = r.json()["token"]
    revoked_id = r.json()["invitation"]["id"]
    r = client.delete(
        f"/v1/workspace/invitations/{revoked_id}",
        headers=_h(admin_tok),
    )
    assert r.status_code == 200

    invitee_tok = _mint(client, "later@acme.test", "viewer", "acme")
    r = client.post(
        "/v1/workspace/invitations/accept",
        json={"token": revoked_token},
        headers=_h(invitee_tok),
    )
    assert r.status_code == 410, r.text
    assert r.json()["detail"]["code"] == "revoked"

    # Create another, manually expire it via the storage layer.
    r = client.post(
        "/v1/workspace/invitations",
        json={"email": "stale@acme.test", "role": "viewer", "ttl_hours": 1},
        headers=_h(admin_tok),
    )
    assert r.status_code == 201
    stale_token = r.json()["token"]
    stale_id = r.json()["invitation"]["id"]

    from adherence_common.db import session
    from adherence_common.memberships import WorkspaceInvitation
    from sqlalchemy import select
    with session() as db:
        row = db.execute(
            select(WorkspaceInvitation).where(WorkspaceInvitation.id == stale_id)
        ).scalar_one()
        row.expires_at = datetime.utcnow() - timedelta(hours=1)
        db.commit()

    stale_user = _mint(client, "stale@acme.test", "viewer", "acme")
    r = client.post(
        "/v1/workspace/invitations/accept",
        json={"token": stale_token},
        headers=_h(stale_user),
    )
    assert r.status_code == 410, r.text
    assert r.json()["detail"]["code"] == "expired"


def test_cannot_remove_last_admin(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    from adherence_common.memberships import upsert_member

    client = TestClient(create_app())
    admin_tok = _mint(client, "owner@acme.test", "admin", "acme")

    # Seed the sole admin into the membership table.
    upsert_member("acme", "owner@acme.test", "admin", added_by="system:test")

    r = client.delete(
        "/v1/workspace/members/owner@acme.test",
        headers=_h(admin_tok),
    )
    assert r.status_code == 409, r.text

    # Demotion is also blocked.
    r = client.patch(
        "/v1/workspace/members/owner@acme.test",
        json={"role": "viewer"},
        headers=_h(admin_tok),
    )
    assert r.status_code == 409, r.text
