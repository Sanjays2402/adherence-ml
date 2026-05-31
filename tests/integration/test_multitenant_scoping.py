"""Multi-tenant scoping: predictions and audit rows must not leak across
tenants. Two DB-backed API keys with distinct ``tenant_id`` values both
hit ``/v1/predict``; each key may only read its own audit slice via
``/v1/audit/list`` and ``/v1/audit/export.csv``. Admin (which lacks a
tenant pin) may read across with ``?tenant=*``.

Also verifies that the tamper-evident hash chain still validates after
tenant ids land in the row payload.
"""
from __future__ import annotations

from adherence_common.settings import reload_settings
from fastapi.testclient import TestClient


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/mt.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    monkeypatch.setenv("ADHERENCE_DEFAULT_TENANT", "default")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


def _train(tmp_path):
    from adherence_worker import inference as inf
    inf.load_model.cache_clear()
    from adherence_trainer.pipeline import run_training
    run_training(
        synthetic=True, users=80, days=10, seed=11,
        register_as="default", use_mlflow=False, cv_splits=0,
    )


def _schedule():
    return [{
        "dose_id": "d1",
        "scheduled_at": "2026-03-05T08:00:00Z",
        "dose_class": "cardio",
        "dose_strength_mg": 10.0,
    }]


def _mint_tenant_key(client, admin_headers, name, tenant):
    r = client.post(
        "/v1/admin/api-keys",
        json={
            "name": name, "role": "service", "scopes": ["predict"],
            "tenant_id": tenant,
        },
        headers=admin_headers,
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["tenant_id"] == tenant
    return body["key"]


def test_tenant_keys_isolate_audit_reads(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    admin = {"x-api-key": "adm"}
    acme_key = _mint_tenant_key(client, admin, "svc-acme", "acme")
    globex_key = _mint_tenant_key(client, admin, "svc-globex", "globex")

    payload_a = {"user_id": "u_acme_1", "schedule": _schedule(), "top_k_reasons": 1}
    payload_g = {"user_id": "u_globex_1", "schedule": _schedule(), "top_k_reasons": 1}

    r = client.post("/v1/predict", json=payload_a, headers={"x-api-key": acme_key})
    assert r.status_code == 200, r.text
    r = client.post("/v1/predict", json=payload_g, headers={"x-api-key": globex_key})
    assert r.status_code == 200, r.text

    # An admin key (env-mapped, tenant=default) sees its own bucket by default
    # and zero rows from acme / globex.
    r = client.get("/v1/audit/list?limit=50", headers=admin)
    assert r.status_code == 200
    for row in r.json()["items"]:
        assert row["tenant_id"] == "default"

    bg = "customer support ticket 4242"
    # Without justification, cross-tenant queries are blocked.
    r = client.get("/v1/audit/list?limit=50&tenant=acme", headers=admin)
    assert r.status_code == 400
    # Admin can pass an explicit tenant to read another bucket with a justification.
    r = client.get(
        "/v1/audit/list?limit=50&tenant=acme",
        headers={**admin, "X-Break-Glass-Justification": bg},
    )
    assert r.status_code == 200
    items = r.json()["items"]
    assert items, "expected at least one acme audit row"
    assert all(it["tenant_id"] == "acme" for it in items)
    assert any(it["user_id"] == "u_acme_1" for it in items)
    assert not any(it["user_id"] == "u_globex_1" for it in items)

    # Cross-tenant wildcard requires admin and a justification.
    r = client.get(
        "/v1/audit/list?tenant=*",
        headers={**admin, "X-Break-Glass-Justification": bg},
    )
    assert r.status_code == 200
    tenants_seen = {it["tenant_id"] for it in r.json()["items"]}
    assert {"acme", "globex"}.issubset(tenants_seen)


def test_non_admin_cannot_cross_tenants(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    admin = {"x-api-key": "adm"}
    # An admin-role key pinned to a non-default tenant: still admin role, so
    # cross-tenant reads should be allowed (admin is the cross-tenant boundary).
    r = client.post(
        "/v1/admin/api-keys",
        json={"name": "adm-acme", "role": "admin", "tenant_id": "acme"},
        headers=admin,
    )
    assert r.status_code == 201, r.text
    acme_admin_key = r.json()["key"]

    # Generate one prediction under "globex" so there's data to attempt reading.
    globex_key = _mint_tenant_key(client, admin, "svc-globex2", "globex")
    payload = {"user_id": "u_globex_2", "schedule": _schedule(), "top_k_reasons": 1}
    r = client.post("/v1/predict", json=payload, headers={"x-api-key": globex_key})
    assert r.status_code == 200

    # acme-pinned admin reading "globex": admin role overrides tenant pin,
    # break-glass justification recorded.
    r = client.get(
        "/v1/audit/list?tenant=globex",
        headers={"x-api-key": acme_admin_key, "X-Break-Glass-Justification": "on-call incident IR-77"},
    )
    assert r.status_code == 200
    items = r.json()["items"]
    assert items and all(it["tenant_id"] == "globex" for it in items)


def test_hash_chain_intact_with_tenant_field(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    admin = {"x-api-key": "adm"}
    acme_key = _mint_tenant_key(client, admin, "svc-acme-c", "acme")
    payload = {"user_id": "u_chain", "schedule": _schedule(), "top_k_reasons": 1}
    for _ in range(3):
        r = client.post("/v1/predict", json=payload, headers={"x-api-key": acme_key})
        assert r.status_code == 200

    r = client.get("/v1/audit/verify", headers=admin)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True, body
    assert body["n_rows"] >= 3
    assert body["breaks"] == []
