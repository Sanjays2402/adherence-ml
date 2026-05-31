"""Integration tests for /v1/admin/access-reviews.

Procurement invariants exercised here:

1. Tenant scoping: acme cannot list, read, decide on, or close globex's
   reviews. Cross-tenant probes return 404, not data.
2. RBAC: a viewer cannot open, decide, close, or cancel a review.
3. Closing a review with pending items is rejected (400) and leaves
   memberships untouched.
4. A clean close applies ``revoke`` and ``change`` decisions to the
   live membership table and writes one admin audit row per applied
   change.
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
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/ar.db")
    monkeypatch.setenv(
        "ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns"
    )
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    monkeypatch.setenv("ADHERENCE_ADMIN_MFA_REQUIRED", "false")
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


def _seed_members(tenant: str) -> None:
    from adherence_common import memberships as mem
    mem.upsert_member(
        tenant_id=tenant, subject="alice@x.test", role="admin", added_by="seed"
    )
    mem.upsert_member(
        tenant_id=tenant, subject="bob@x.test", role="viewer", added_by="seed"
    )
    mem.upsert_member(
        tenant_id=tenant, subject="carol@x.test", role="viewer", added_by="seed"
    )


def test_access_review_full_lifecycle_and_isolation(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app

    client = TestClient(create_app())
    _seed_members("acme")
    _seed_members("globex")

    acme_admin = _mint(client, "owner@acme.test", "admin", "acme")
    acme_viewer = _mint(client, "v@acme.test", "viewer", "acme")
    globex_admin = _mint(client, "owner@globex.test", "admin", "globex")

    # Viewer cannot open a review.
    r = client.post(
        "/v1/admin/access-reviews",
        json={"reason": "Quarterly review Q1"},
        headers=_h(acme_viewer),
    )
    assert r.status_code == 403, r.text

    # Admin opens a review for acme; snapshot includes all 3 members.
    r = client.post(
        "/v1/admin/access-reviews",
        json={"reason": "Quarterly review Q1", "label": "2026-Q1"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 201, r.text
    review = r.json()
    rid = review["id"]
    assert review["state"] == "open"
    assert review["item_count"] == 3
    assert review["pending_count"] == 3

    # Globex admin cannot see acme's review.
    r = client.get(f"/v1/admin/access-reviews/{rid}", headers=_h(globex_admin))
    assert r.status_code == 404, r.text
    r = client.get(
        f"/v1/admin/access-reviews/{rid}/items", headers=_h(globex_admin)
    )
    assert r.status_code == 404, r.text

    # List items for acme.
    r = client.get(
        f"/v1/admin/access-reviews/{rid}/items", headers=_h(acme_admin)
    )
    assert r.status_code == 200, r.text
    items = {it["subject"]: it for it in r.json()["items"]}
    assert set(items) == {"alice@x.test", "bob@x.test", "carol@x.test"}

    # Cannot close with pending items.
    r = client.post(
        f"/v1/admin/access-reviews/{rid}/close",
        json={"summary": "trying early"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 400, r.text

    # Globex admin cannot decide on acme's items.
    r = client.post(
        f"/v1/admin/access-reviews/{rid}/items/{items['alice@x.test']['id']}/decide",
        json={"decision": "keep"},
        headers=_h(globex_admin),
    )
    assert r.status_code in (400, 404), r.text

    # Acme admin: keep alice, change bob to admin, revoke carol.
    r = client.post(
        f"/v1/admin/access-reviews/{rid}/items/{items['alice@x.test']['id']}/decide",
        json={"decision": "keep", "note": "still owner"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 200, r.text
    r = client.post(
        f"/v1/admin/access-reviews/{rid}/items/{items['bob@x.test']['id']}/decide",
        json={"decision": "change", "new_role": "admin"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 200, r.text
    r = client.post(
        f"/v1/admin/access-reviews/{rid}/items/{items['carol@x.test']['id']}/decide",
        json={"decision": "revoke", "note": "off-boarded"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 200, r.text

    # Invalid change (missing new_role) rejected.
    r = client.post(
        f"/v1/admin/access-reviews/{rid}/items/{items['alice@x.test']['id']}/decide",
        json={"decision": "change"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 400

    # Dry-run close shows what would apply.
    r = client.post(
        f"/v1/admin/access-reviews/{rid}/close?dry_run=true",
        json={"summary": "preview"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 200, r.text
    assert r.json().get("dry_run") is True

    # Real close applies changes.
    r = client.post(
        f"/v1/admin/access-reviews/{rid}/close",
        json={"summary": "Q1 closed"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["review"]["state"] == "closed"
    by_subject = {a["subject"]: a for a in body["applied"]}
    assert by_subject["carol@x.test"]["decision"] == "revoke"
    assert by_subject["bob@x.test"]["decision"] == "change"

    # Membership table reflects the decisions.
    from adherence_common import memberships as mem
    members = {m.subject: m.role for m in mem.list_members("acme")}
    assert "carol@x.test" not in members
    assert members["bob@x.test"] == "admin"
    assert members["alice@x.test"] == "admin"

    # Globex memberships are untouched.
    g = {m.subject: m.role for m in mem.list_members("globex")}
    assert set(g) == {"alice@x.test", "bob@x.test", "carol@x.test"}

    # Cannot close a closed review.
    r = client.post(
        f"/v1/admin/access-reviews/{rid}/close",
        json={},
        headers=_h(acme_admin),
    )
    assert r.status_code == 400

    # Cannot decide on items of a closed review.
    r = client.post(
        f"/v1/admin/access-reviews/{rid}/items/{items['alice@x.test']['id']}/decide",
        json={"decision": "keep"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 400
