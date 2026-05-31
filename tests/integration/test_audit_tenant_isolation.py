"""Cross-tenant isolation tests for /v1/audit/{stats,shadow,verify}.

Two DB-backed admin keys are minted into separate tenants. Predictions
made under one tenant must not surface in the other tenant's audit
aggregates, and a non-admin caller must not be able to pass ``tenant=*``
to escape their tenant scope.
"""
from __future__ import annotations

from datetime import datetime

from adherence_common.settings import reload_settings
from fastapi.testclient import TestClient


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "service:svc")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/audit_tenant.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
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
    run_training(synthetic=True, users=80, days=10, seed=17,
                 register_as="default", use_mlflow=False, cv_splits=0)


def _mint(name: str, role: str, tenant: str) -> str:
    from adherence_common.api_keys import create_key
    plain, _ = create_key(name=name, role=role, tenant_id=tenant)
    return plain


def _seed(client: TestClient, key: str, user: str) -> None:
    schedule = [
        {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
         "dose_class": "cardio", "dose_strength_mg": 10.0},
    ]
    r = client.post(
        "/v1/predict",
        json={"user_id": user, "schedule": schedule, "top_k_reasons": 1},
        headers={"x-api-key": key},
    )
    assert r.status_code == 200, r.text


def test_audit_stats_scopes_to_caller_tenant(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app

    # Two tenants, each with its own admin + service key.
    acme_admin = _mint("acme-admin", "admin", "acme")
    acme_svc = _mint("acme-svc", "service", "acme")
    globex_admin = _mint("globex-admin", "admin", "globex")
    globex_svc = _mint("globex-svc", "service", "globex")

    client = TestClient(create_app())

    # 3 acme predictions, 1 globex.
    _seed(client, acme_svc, "u_000001")
    _seed(client, acme_svc, "u_000002")
    _seed(client, acme_svc, "u_000003")
    _seed(client, globex_svc, "u_000004")

    # acme admin sees its 3 rows only.
    r = client.get(
        "/v1/audit/stats?window_hours=24",
        headers={"x-api-key": acme_admin},
    )
    assert r.status_code == 200, r.text
    assert r.json()["n_calls"] == 3

    # globex admin sees its 1 row only.
    r = client.get(
        "/v1/audit/stats?window_hours=24",
        headers={"x-api-key": globex_admin},
    )
    assert r.status_code == 200, r.text
    assert r.json()["n_calls"] == 1

    # Non-admin DB keys can't reach this endpoint at all (role gate).
    r = client.get(
        "/v1/audit/stats?window_hours=24",
        headers={"x-api-key": acme_svc},
    )
    assert r.status_code == 403

    # Admins may opt in to cross-tenant rollups via tenant=*; that's the
    # documented escape hatch for fleet-wide compliance queries.
    bg = {"x-api-key": acme_admin, "X-Break-Glass-Justification": "compliance fleet audit"}
    # Without justification, cross-tenant calls now 400.
    r = client.get(
        "/v1/audit/stats?window_hours=24&tenant=*",
        headers={"x-api-key": acme_admin},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "break_glass_required"
    r = client.get("/v1/audit/stats?window_hours=24&tenant=*", headers=bg)
    assert r.status_code == 200, r.text
    assert r.json()["n_calls"] == 4

    # Explicitly asking for someone else's tenant id without '*' is also
    # admin-only, but it must not silently fall back to caller scope.
    r = client.get(
        "/v1/audit/stats?window_hours=24&tenant=globex",
        headers={"x-api-key": acme_admin, "X-Break-Glass-Justification": "customer support ticket 1234"},
    )
    assert r.status_code == 200
    assert r.json()["n_calls"] == 1

    # Non-admin (service) cannot even reach the route. Already asserted above
    # via the 403; if it could, it must not be able to use tenant=*.
    r = client.get(
        "/v1/audit/stats?window_hours=24&tenant=*",
        headers={"x-api-key": acme_svc},
    )
    assert r.status_code == 403


def test_audit_list_scopes_to_caller_tenant(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app

    acme_admin = _mint("acme-admin", "admin", "acme")
    acme_svc = _mint("acme-svc", "service", "acme")
    globex_admin = _mint("globex-admin", "admin", "globex")
    globex_svc = _mint("globex-svc", "service", "globex")

    client = TestClient(create_app())
    _seed(client, acme_svc, "u_acme_001")
    _seed(client, globex_svc, "u_globex_001")

    r = client.get("/v1/audit/list?limit=100", headers={"x-api-key": acme_admin})
    assert r.status_code == 200
    users = {row["user_id"] for row in r.json()["items"]}
    tenants = {row["tenant_id"] for row in r.json()["items"]}
    assert "u_acme_001" in users
    assert "u_globex_001" not in users
    assert tenants == {"acme"}

    r = client.get("/v1/audit/list?limit=100", headers={"x-api-key": globex_admin})
    assert r.status_code == 200
    users = {row["user_id"] for row in r.json()["items"]}
    assert "u_globex_001" in users
    assert "u_acme_001" not in users


def test_audit_verify_scopes_breaks_to_tenant(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app

    acme_admin = _mint("acme-admin", "admin", "acme")
    acme_svc = _mint("acme-svc", "service", "acme")
    globex_svc = _mint("globex-svc", "service", "globex")

    client = TestClient(create_app())
    _seed(client, acme_svc, "u_acme_001")
    _seed(client, globex_svc, "u_globex_001")
    _seed(client, acme_svc, "u_acme_002")

    r = client.get("/v1/audit/verify", headers={"x-api-key": acme_admin})
    assert r.status_code == 200, r.text
    body = r.json()
    # acme has 2 rows total
    assert body["n_rows"] == 2
    assert body["ok"] is True
