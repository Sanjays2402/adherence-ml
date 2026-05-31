"""Integration test: per-workspace data residency.

Proves the enterprise contract documented in ``docs/SUBPROCESSORS.md``:

1. By default a tenant reports the deployment default region.
2. A workspace admin can pin their tenant to ``eu`` and the change is
   reflected immediately on the ``X-Data-Residency`` response header.
3. The pin is tenant-scoped: pinning ``acme`` to ``eu`` does not affect
   ``globex``, which still resolves to the default.
4. Every mutation lands in the admin audit log so SOC2 reviewers can
   trace who moved a workspace and when.
5. Unknown region codes are rejected before they touch the audit chain
   in a confusing way.
6. Viewers can read the policy but cannot change it.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/residency.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()


def _mint(client: TestClient, *, subject: str, tenant: str, role: str = "viewer") -> str:
    r = client.post(
        "/v1/admin/token",
        json={"subject": subject, "role": role, "tenant": tenant},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _admin_for(client: TestClient, tenant: str) -> str:
    return _mint(client, subject=f"admin-{tenant}", tenant=tenant, role="admin")


def test_residency_default_and_pin_per_tenant(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    acme_admin = _admin_for(client, "acme")
    globex_admin = _admin_for(client, "globex")

    # Default: no pin, default region surfaced and pinned=False.
    r0 = client.get(
        "/v1/workspace/residency",
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r0.status_code == 200, r0.text
    body0 = r0.json()
    assert body0["tenant_id"] == "acme"
    assert body0["pinned"] is False
    assert body0["region"] == body0["default_region"]
    assert sorted(body0["allowed_regions"]) == ["eu", "us"]
    # And the header echoes that.
    assert r0.headers.get("x-data-residency") == body0["default_region"]

    # Pin acme to eu.
    r_set = client.put(
        "/v1/workspace/residency",
        json={"region": "eu"},
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_set.status_code == 200, r_set.text
    assert r_set.json()["region"] == "eu"
    assert r_set.json()["pinned"] is True
    # The PUT response itself carries the new region on the header.
    assert r_set.headers.get("x-data-residency") == "eu"

    # A fresh read confirms the pin and the header on any tenant-bound
    # endpoint mirrors it.
    r_read = client.get(
        "/v1/workspace/residency",
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_read.headers.get("x-data-residency") == "eu"

    # globex is untouched: still on the default and still pinned=False.
    r_g = client.get(
        "/v1/workspace/residency",
        headers={"Authorization": f"Bearer {globex_admin}"},
    )
    assert r_g.status_code == 200, r_g.text
    assert r_g.json()["pinned"] is False
    assert r_g.headers.get("x-data-residency") == r_g.json()["default_region"]
    assert r_g.headers.get("x-data-residency") != "eu"

    # Audit trail captured the change.
    r_audit = client.get(
        "/v1/admin/audit/admin?action=workspace.residency.set&tenant=*&limit=5",
        headers={"x-api-key": "adm"},
    )
    assert r_audit.status_code == 200, r_audit.text
    actions = [row["action"] for row in r_audit.json()]
    assert "workspace.residency.set" in actions

    # Clearing reverts to default.
    r_del = client.delete(
        "/v1/workspace/residency",
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_del.status_code == 200, r_del.text
    assert r_del.json()["pinned"] is False
    assert r_del.headers.get("x-data-residency") == r_del.json()["default_region"]


def test_residency_rejects_unknown_region(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    admin_tok = _admin_for(client, "acme")
    r = client.put(
        "/v1/workspace/residency",
        json={"region": "mars"},
        headers={"Authorization": f"Bearer {admin_tok}"},
    )
    assert r.status_code == 400, r.text
    assert "region" in r.text.lower()


def test_residency_requires_admin_to_write(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    viewer_tok = _mint(client, subject="vw", tenant="acme", role="viewer")

    # Viewer can read.
    r_get = client.get(
        "/v1/workspace/residency",
        headers={"Authorization": f"Bearer {viewer_tok}"},
    )
    assert r_get.status_code == 200, r_get.text

    # Viewer cannot write.
    r_put = client.put(
        "/v1/workspace/residency",
        json={"region": "eu"},
        headers={"Authorization": f"Bearer {viewer_tok}"},
    )
    assert r_put.status_code == 403, r_put.text


def test_residency_dry_run_does_not_persist(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    admin_tok = _admin_for(client, "acme")
    r = client.put(
        "/v1/workspace/residency?dry_run=true",
        json={"region": "eu"},
        headers={"Authorization": f"Bearer {admin_tok}"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("dry_run") is True or "would" in body

    # Confirm nothing actually changed.
    r_read = client.get(
        "/v1/workspace/residency",
        headers={"Authorization": f"Bearer {admin_tok}"},
    )
    assert r_read.json()["pinned"] is False
