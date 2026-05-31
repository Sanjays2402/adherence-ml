"""Cross-tenant admin access is logged and gated by a justification.

These tests exercise the break-glass control end-to-end:

* An admin pinned to tenant ``acme`` calling ``/v1/audit/list`` for
  tenant ``globex`` without a justification gets ``400
  break_glass_required``.
* The same call with ``X-Break-Glass-Justification`` succeeds and
  appends a row visible to the impacted tenant's owner via
  ``/v1/admin/break-glass``.
* A non-admin (service) caller still gets ``403`` and never reaches
  the break-glass path.
* Same-tenant calls never write a break-glass row.
"""
from __future__ import annotations

from adherence_common.settings import reload_settings
from fastapi.testclient import TestClient


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "service:svc")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/bg.db")
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
    run_training(
        synthetic=True, users=40, days=8, seed=11,
        register_as="default", use_mlflow=False, cv_splits=0,
    )


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


def test_break_glass_required_then_logged(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app

    acme_admin = _mint("acme-admin", "admin", "acme")
    acme_svc = _mint("acme-svc", "service", "acme")
    globex_admin = _mint("globex-admin", "admin", "globex")
    globex_svc = _mint("globex-svc", "service", "globex")

    client = TestClient(create_app())
    _seed(client, globex_svc, "u_g_1")
    _seed(client, acme_svc, "u_a_1")

    # 1) Cross-tenant without justification: 400 with structured detail.
    r = client.get(
        "/v1/audit/list?limit=10&tenant=globex",
        headers={"x-api-key": acme_admin},
    )
    assert r.status_code == 400, r.text
    body = r.json()
    assert body["detail"]["code"] == "break_glass_required"
    assert body["detail"]["target_tenant"] == "globex"
    assert body["detail"]["source_tenant"] == "acme"

    # 2) Too-short justification rejected the same way.
    r = client.get(
        "/v1/audit/list?limit=10&tenant=globex",
        headers={"x-api-key": acme_admin, "X-Break-Glass-Justification": "x"},
    )
    assert r.status_code == 400

    # 3) Service role can never cross tenants regardless of header.
    r = client.get(
        "/v1/audit/list?limit=10&tenant=globex",
        headers={
            "x-api-key": acme_svc,
            "X-Break-Glass-Justification": "trying to bypass",
        },
    )
    assert r.status_code == 403

    # 4) With justification: 200 and a row appended.
    r = client.get(
        "/v1/audit/list?limit=10&tenant=globex",
        headers={
            "x-api-key": acme_admin,
            "X-Break-Glass-Justification": "support escalation ticket SR-9001",
        },
    )
    assert r.status_code == 200, r.text

    # 5) The impacted tenant's admin sees the event.
    r = client.get(
        "/v1/admin/break-glass",
        headers={"x-api-key": globex_admin},
    )
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["total"] >= 1
    events = payload["events"]
    assert any(
        e["source_tenant"] == "acme"
        and e["target_tenant"] == "globex"
        and "SR-9001" in e["justification"]
        and e["route"].endswith("/v1/audit/list")
        and e["method"] == "GET"
        for e in events
    )

    # 6) Same-tenant call does NOT add another row.
    before = payload["total"]
    r = client.get("/v1/audit/list?limit=10", headers={"x-api-key": globex_admin})
    assert r.status_code == 200
    r = client.get("/v1/admin/break-glass", headers={"x-api-key": globex_admin})
    assert r.status_code == 200
    assert r.json()["total"] == before

    # 7) acme's owner does not see globex's events (tenant isolation on the
    # break-glass log itself).
    r = client.get("/v1/admin/break-glass", headers={"x-api-key": acme_admin})
    assert r.status_code == 200
    for e in r.json()["events"]:
        assert e["target_tenant"] == "acme"

    # 8) CSV export works for the target tenant.
    r = client.get(
        "/v1/admin/break-glass/export.csv",
        headers={"x-api-key": globex_admin},
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    text = r.text
    assert "source_tenant" in text.splitlines()[0]
    assert "acme" in text
