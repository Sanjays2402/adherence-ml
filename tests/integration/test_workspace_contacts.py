"""Integration tests for per-workspace notification contact roles.

Enterprise procurement invariants under test:

1. Defaults: a workspace with no overrides reports operator defaults
   for every role with ``source='operator_default'``.
2. Set + read back: an admin can set a role and it shows up as
   ``source='workspace'`` with the supplied label.
3. Dry-run: ``?dry_run=true`` validates input and reports the planned
   diff without writing the row.
4. Delete reverts to operator default.
5. Permission denial: viewer can read, viewer cannot write.
6. Cross-tenant isolation: workspace ``acme`` cannot see or mutate
   workspace ``globex`` rows even with the same role name.
7. Validation: bad role / bad email / oversize label return HTTP 400
   with structured errors.
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
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/wc.db")
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


def test_defaults_when_no_overrides(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    admin = _mint(client, "owner@acme.test", "admin", "acme")

    r = client.get("/v1/workspace/contacts", headers=_h(admin))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["tenant_id"] == "acme"
    assert body["roles"] == [
        "security", "privacy", "billing",
        "abuse", "technical", "breach_notification",
    ]
    for c in body["contacts"]:
        assert c["source"] == "operator_default"
        assert "@" in c["email"]
        assert c["updated_by"] is None
        assert c["description"]


def test_set_and_read_back(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    admin = _mint(client, "owner@acme.test", "admin", "acme")

    r = client.put(
        "/v1/workspace/contacts/security",
        json={"email": "sec-OnCall@Acme.com", "label": "Sec Eng on-call"},
        headers=_h(admin),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # Domain lowercased, local part preserved.
    assert body["email"] == "sec-OnCall@acme.com"
    assert body["label"] == "Sec Eng on-call"
    assert body["source"] == "workspace"
    assert body["role"] == "security"

    r = client.get("/v1/workspace/contacts/security", headers=_h(admin))
    assert r.status_code == 200
    assert r.json()["email"] == "sec-OnCall@acme.com"
    assert r.json()["source"] == "workspace"

    # Other roles still inherit the default.
    r = client.get("/v1/workspace/contacts/billing", headers=_h(admin))
    assert r.status_code == 200
    assert r.json()["source"] == "operator_default"


def test_dry_run_does_not_persist(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    admin = _mint(client, "owner@acme.test", "admin", "acme")

    r = client.put(
        "/v1/workspace/contacts/privacy?dry_run=true",
        json={"email": "dpo@acme.com"},
        headers=_h(admin),
    )
    assert r.status_code == 200, r.text
    assert r.json()["email"] == "dpo@acme.com"
    assert r.json()["updated_at"] == "dry-run"

    # Still default.
    r = client.get("/v1/workspace/contacts/privacy", headers=_h(admin))
    assert r.json()["source"] == "operator_default"


def test_delete_reverts_to_default(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    admin = _mint(client, "owner@acme.test", "admin", "acme")

    client.put(
        "/v1/workspace/contacts/billing",
        json={"email": "ap@acme.com"},
        headers=_h(admin),
    ).raise_for_status()

    # Dry-run delete reports the revert target.
    r = client.delete(
        "/v1/workspace/contacts/billing?dry_run=true", headers=_h(admin)
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dry_run"] is True
    assert body["would_delete"] is True
    assert body["current_email"] == "ap@acme.com"
    assert "@" in body["reverts_to"]

    # Still set.
    r = client.get("/v1/workspace/contacts/billing", headers=_h(admin))
    assert r.json()["source"] == "workspace"

    # Real delete.
    r = client.delete("/v1/workspace/contacts/billing", headers=_h(admin))
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] is True

    r = client.get("/v1/workspace/contacts/billing", headers=_h(admin))
    assert r.json()["source"] == "operator_default"

    # Deleting again 404s.
    r = client.delete("/v1/workspace/contacts/billing", headers=_h(admin))
    assert r.status_code == 404


def test_viewer_cannot_mutate_but_can_read(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    admin = _mint(client, "owner@acme.test", "admin", "acme")
    viewer = _mint(client, "auditor@acme.test", "viewer", "acme")

    client.put(
        "/v1/workspace/contacts/abuse",
        json={"email": "abuse@acme.com"},
        headers=_h(admin),
    ).raise_for_status()

    # Viewer can list.
    r = client.get("/v1/workspace/contacts", headers=_h(viewer))
    assert r.status_code == 200
    abuse = next(c for c in r.json()["contacts"] if c["role"] == "abuse")
    assert abuse["email"] == "abuse@acme.com"

    # Viewer can read the rendered security.txt.
    r = client.get("/v1/workspace/contacts/security.txt", headers=_h(viewer))
    assert r.status_code == 200
    assert "Contact: mailto:" in r.text

    # Viewer cannot PUT or DELETE.
    r = client.put(
        "/v1/workspace/contacts/abuse",
        json={"email": "evil@acme.com"},
        headers=_h(viewer),
    )
    assert r.status_code == 403, r.text

    r = client.delete("/v1/workspace/contacts/abuse", headers=_h(viewer))
    assert r.status_code == 403, r.text


def test_cross_tenant_isolation(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    acme_admin = _mint(client, "owner@acme.test", "admin", "acme")
    globex_admin = _mint(client, "owner@globex.test", "admin", "globex")

    client.put(
        "/v1/workspace/contacts/security",
        json={"email": "sec@acme.com", "label": "ACME SOC"},
        headers=_h(acme_admin),
    ).raise_for_status()

    # Globex sees no override.
    r = client.get("/v1/workspace/contacts/security", headers=_h(globex_admin))
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "operator_default"
    assert body["email"] != "sec@acme.com"
    assert body["label"] is None

    # Globex sets its own; ACME is unaffected.
    client.put(
        "/v1/workspace/contacts/security",
        json={"email": "sec@globex.com"},
        headers=_h(globex_admin),
    ).raise_for_status()

    r = client.get("/v1/workspace/contacts/security", headers=_h(acme_admin))
    assert r.json()["email"] == "sec@acme.com"

    # And Globex cannot DELETE ACME's row (it would just 404 since it
    # has its own and ACME's row lives in another tenant scope).
    r = client.delete(
        "/v1/workspace/contacts/security", headers=_h(globex_admin)
    )
    assert r.status_code == 200
    # ACME's row is still in place.
    r = client.get("/v1/workspace/contacts/security", headers=_h(acme_admin))
    assert r.json()["email"] == "sec@acme.com"
    assert r.json()["source"] == "workspace"


def test_validation_errors(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    admin = _mint(client, "owner@acme.test", "admin", "acme")

    # Unknown role.
    r = client.put(
        "/v1/workspace/contacts/marketing",
        json={"email": "x@acme.com"},
        headers=_h(admin),
    )
    assert r.status_code == 400
    assert "role must be one of" in r.json()["detail"]

    # Bad email.
    r = client.put(
        "/v1/workspace/contacts/security",
        json={"email": "not-an-email"},
        headers=_h(admin),
    )
    assert r.status_code == 400

    # Oversize label.
    r = client.put(
        "/v1/workspace/contacts/security",
        json={"email": "x@acme.com", "label": "L" * 200},
        headers=_h(admin),
    )
    assert r.status_code == 422 or r.status_code == 400
