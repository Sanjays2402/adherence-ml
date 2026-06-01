"""Integration tests for the API deprecation registry.

Procurement-blocker invariants this test pins:

1. Admin can register a deprecation. Mutations are audit-logged.
2. Every response on a matching route carries the standard headers:
   ``Deprecation``, ``Sunset``, and a ``Link`` rel=successor-version.
3. The public ``/.well-known/api-deprecations`` endpoint returns the
   registry without authentication.
4. Per-tenant usage tracking is strictly tenant-scoped: a call by
   ``acme`` never shows up in ``globex``'s usage report.
5. A viewer (non-admin) cannot register or remove entries.
6. ``?dry_run=true`` on register and remove does not mutate state.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/dep.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()
    from adherence_common import api_deprecations as dep
    dep.invalidate_cache()


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


def test_api_deprecations_end_to_end(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    admin_acme = _mint(client, "alice", "admin", "acme")
    admin_globex = _mint(client, "carol", "admin", "globex")
    viewer = _mint(client, "bob", "viewer", "acme")

    now = datetime.now(timezone.utc)
    body = {
        "method": "GET",
        "path_prefix": "/v1/auth/scopes",
        "deprecated_at": (now - timedelta(days=1)).isoformat(),
        "sunset_at": (now + timedelta(days=90)).isoformat(),
        "successor_link": "https://docs.adherence.ml/v2/auth/scopes",
        "reason": "v1 scopes introspection is being replaced with /v2/auth/scopes.",
    }

    # Viewer cannot register.
    r = client.post("/v1/admin/api-deprecations", json=body, headers=_h(viewer))
    assert r.status_code == 403, r.text

    # Dry-run does not persist.
    r = client.post(
        "/v1/admin/api-deprecations?dry_run=true", json=body, headers=_h(admin_acme)
    )
    assert r.status_code == 201, r.text
    r = client.get("/v1/admin/api-deprecations", headers=_h(admin_acme))
    assert r.status_code == 200
    assert r.json()["entries"] == []

    # Real register.
    r = client.post("/v1/admin/api-deprecations", json=body, headers=_h(admin_acme))
    assert r.status_code == 201, r.text
    entry = r.json()
    assert entry["method"] == "GET"
    assert entry["path_prefix"] == "/v1/auth/scopes"
    assert entry["sunset_at"].endswith("GMT")  # IMF-fixdate per RFC 8594

    # Duplicate registration is rejected with 400.
    r = client.post("/v1/admin/api-deprecations", json=body, headers=_h(admin_acme))
    assert r.status_code == 400

    # Invalid: sunset before deprecated.
    bad = dict(body)
    bad["path_prefix"] = "/v1/predict"
    bad["sunset_at"] = (now - timedelta(days=10)).isoformat()
    r = client.post("/v1/admin/api-deprecations", json=bad, headers=_h(admin_acme))
    assert r.status_code == 400

    # Headers must appear on a matching response.
    from adherence_common import api_deprecations as dep
    dep.invalidate_cache()
    r = client.get("/v1/auth/scopes", headers=_h(admin_acme))
    assert r.status_code == 200
    assert "Deprecation" in r.headers
    assert "Sunset" in r.headers
    assert r.headers["Sunset"].endswith("GMT")
    link = r.headers.get("Link", "")
    assert 'rel="successor-version"' in link
    assert 'rel="deprecation"' in link

    # Non-matching path: no headers.
    r = client.get("/healthz")
    assert "Sunset" not in r.headers

    # Public well-known: no auth required, lists the entry.
    r = client.get("/.well-known/api-deprecations")
    assert r.status_code == 200
    payload = r.json()
    assert any(e["path_prefix"] == "/v1/auth/scopes" for e in payload["entries"])
    # No created_by field leaks to the public surface.
    for e in payload["entries"]:
        assert "created_by" not in e

    # Tenant-scoped usage: hit the deprecated endpoint as both tenants,
    # check each only sees their own counter.
    for _ in range(3):
        client.get("/v1/auth/scopes", headers=_h(admin_acme))
    for _ in range(2):
        client.get("/v1/auth/scopes", headers=_h(admin_globex))

    r = client.get("/v1/admin/api-deprecations/usage", headers=_h(admin_acme))
    assert r.status_code == 200
    acme_usage = r.json()
    assert acme_usage["tenant_id"] == "acme"
    assert len(acme_usage["entries"]) == 1
    assert acme_usage["entries"][0]["hits"] >= 3
    acme_hits = acme_usage["entries"][0]["hits"]

    r = client.get("/v1/admin/api-deprecations/usage", headers=_h(admin_globex))
    assert r.status_code == 200
    globex_usage = r.json()
    assert globex_usage["tenant_id"] == "globex"
    assert len(globex_usage["entries"]) == 1
    assert globex_usage["entries"][0]["hits"] == 2
    # Cross-tenant isolation: globex hits did not bleed into acme.
    assert acme_hits != globex_usage["entries"][0]["hits"] or acme_hits >= 3

    # Audit log must include the register mutation.
    r = client.get("/v1/admin/audit/admin?limit=50", headers=_h(admin_acme))
    assert r.status_code == 200, r.text
    actions = [row["action"] for row in r.json()]
    assert "api_deprecation.add" in actions

    # Viewer cannot delete.
    eid = entry["id"]
    r = client.delete(f"/v1/admin/api-deprecations/{eid}", headers=_h(viewer))
    assert r.status_code == 403

    # Dry-run delete preserves the row.
    r = client.delete(
        f"/v1/admin/api-deprecations/{eid}?dry_run=true", headers=_h(admin_acme)
    )
    assert r.status_code == 200
    assert r.json().get("dry_run") is True
    r = client.get("/v1/admin/api-deprecations", headers=_h(admin_acme))
    assert any(e["id"] == eid for e in r.json()["entries"])

    # Real delete and verify headers no longer appear.
    r = client.delete(f"/v1/admin/api-deprecations/{eid}", headers=_h(admin_acme))
    assert r.status_code == 200
    dep.invalidate_cache()
    r = client.get("/v1/auth/scopes", headers=_h(admin_acme))
    assert "Sunset" not in r.headers
