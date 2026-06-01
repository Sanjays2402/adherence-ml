"""Integration test: per-workspace data classification.

Proves the enterprise contract:

1. By default a tenant reports ``confidential`` and ``pinned=False``.
2. A workspace admin can pin their tenant to ``restricted`` and the
   change is reflected immediately on the ``X-Data-Classification``
   response header (and the matching retention floor surfaces).
3. The pin is tenant-scoped: pinning ``acme`` does not affect ``globex``.
4. Every mutation lands in the admin audit log so SOC2 reviewers can
   trace who relabelled a workspace and when.
5. Unknown labels are rejected before they touch the audit chain in a
   confusing way.
6. Viewers can read the label but cannot change it.
7. ``dry_run=true`` never persists.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv(
        "ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr"
    )
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv(
        "ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/data_class.db"
    )
    monkeypatch.setenv(
        "ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns"
    )
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()


def _mint(
    client: TestClient, *, subject: str, tenant: str, role: str = "viewer"
) -> str:
    r = client.post(
        "/v1/admin/token",
        json={"subject": subject, "role": role, "tenant": tenant},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _admin_for(client: TestClient, tenant: str) -> str:
    return _mint(
        client, subject=f"admin-{tenant}", tenant=tenant, role="admin"
    )


def test_classification_default_and_pin_per_tenant(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    acme_admin = _admin_for(client, "acme")
    globex_admin = _admin_for(client, "globex")

    # Default: confidential, not pinned, header echoes the default.
    r0 = client.get(
        "/v1/workspace/data-classification",
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r0.status_code == 200, r0.text
    body0 = r0.json()
    assert body0["tenant_id"] == "acme"
    assert body0["pinned"] is False
    assert body0["label"] == body0["default_label"] == "confidential"
    assert sorted(body0["allowed_labels"]) == [
        "confidential",
        "internal",
        "public",
        "restricted",
    ]
    assert body0["min_retention_days"] == 90
    assert r0.headers.get("x-data-classification") == "confidential"

    # Pin acme to restricted with a justification.
    r_set = client.put(
        "/v1/workspace/data-classification",
        json={
            "label": "restricted",
            "justification": "PHI under 45 CFR 164.514",
        },
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_set.status_code == 200, r_set.text
    set_body = r_set.json()
    assert set_body["label"] == "restricted"
    assert set_body["pinned"] is True
    assert set_body["justification"] == "PHI under 45 CFR 164.514"
    assert set_body["min_retention_days"] == 365
    assert r_set.headers.get("x-data-classification") == "restricted"

    # Read confirms persistence and the header on any tenant-bound call.
    r_read = client.get(
        "/v1/workspace/data-classification",
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_read.headers.get("x-data-classification") == "restricted"
    assert r_read.json()["min_retention_days"] == 365

    # globex is untouched. Cross-tenant isolation is non-negotiable.
    r_g = client.get(
        "/v1/workspace/data-classification",
        headers={"Authorization": f"Bearer {globex_admin}"},
    )
    assert r_g.status_code == 200, r_g.text
    assert r_g.json()["pinned"] is False
    assert r_g.headers.get("x-data-classification") == "confidential"
    assert r_g.headers.get("x-data-classification") != "restricted"

    # Audit trail captured the change.
    r_audit = client.get(
        "/v1/admin/audit/admin?action=workspace.data_classification.set"
        "&tenant=*&limit=5",
        headers={"x-api-key": "adm"},
    )
    assert r_audit.status_code == 200, r_audit.text
    actions = [row["action"] for row in r_audit.json()]
    assert "workspace.data_classification.set" in actions

    # Clearing reverts to default.
    r_del = client.delete(
        "/v1/workspace/data-classification",
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_del.status_code == 200, r_del.text
    assert r_del.json()["pinned"] is False
    assert r_del.headers.get("x-data-classification") == "confidential"


def test_classification_rejects_unknown_label(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    admin_tok = _admin_for(client, "acme")
    r = client.put(
        "/v1/workspace/data-classification",
        json={"label": "top-secret"},
        headers={"Authorization": f"Bearer {admin_tok}"},
    )
    assert r.status_code == 400, r.text
    assert "label" in r.text.lower()


def test_classification_requires_admin_to_write(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    viewer_tok = _mint(client, subject="vw", tenant="acme", role="viewer")

    r_get = client.get(
        "/v1/workspace/data-classification",
        headers={"Authorization": f"Bearer {viewer_tok}"},
    )
    assert r_get.status_code == 200, r_get.text

    r_put = client.put(
        "/v1/workspace/data-classification",
        json={"label": "restricted"},
        headers={"Authorization": f"Bearer {viewer_tok}"},
    )
    assert r_put.status_code == 403, r_put.text


def test_classification_dry_run_does_not_persist(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    admin_tok = _admin_for(client, "acme")
    r = client.put(
        "/v1/workspace/data-classification?dry_run=true",
        json={"label": "restricted"},
        headers={"Authorization": f"Bearer {admin_tok}"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("dry_run") is True or "would" in body

    r_read = client.get(
        "/v1/workspace/data-classification",
        headers={"Authorization": f"Bearer {admin_tok}"},
    )
    assert r_read.json()["pinned"] is False
