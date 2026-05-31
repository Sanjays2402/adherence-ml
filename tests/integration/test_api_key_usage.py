"""Integration test: per-API-key daily usage counters.

Enterprise customers need per-key call attribution for chargeback and
abuse detection. This test proves the end-to-end wiring:

1. The auth dependency increments a usage row on every successful key
   resolution, scoped to the key name and the current UTC day.
2. Two different keys keep independent counters (no cross-key leakage).
3. The admin read endpoint returns a zero-filled window of N days.
4. The list endpoint rolls up traffic per key and sorts by total desc.
5. Reading a key's usage is itself recorded in the admin audit log.
6. Unknown keys return 404 (distinct from "exists but never used").
"""
from __future__ import annotations

from datetime import date, timedelta

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/akusage.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()


def _create_key(client: TestClient, name: str, role: str = "viewer", tenant: str = "default") -> str:
    r = client.post(
        "/v1/admin/api-keys",
        json={"name": name, "role": role, "tenant_id": tenant},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 201, r.text
    return r.json()["key"]


def test_per_key_daily_usage_counters_are_isolated_and_audited(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    plain_a = _create_key(client, "ci-pipeline", role="service")
    plain_b = _create_key(client, "analyst-laptop", role="viewer")

    # Drive traffic: 3 calls on key A, 1 call on key B. /v1/health is
    # auth-free on some deployments, so use an authenticated endpoint.
    for _ in range(3):
        r = client.get("/v1/admin/api-keys", headers={"x-api-key": plain_a})
        # service role can't list api keys; the auth dep still ran.
        assert r.status_code in (200, 403), r.text

    r = client.get("/v1/admin/api-keys", headers={"x-api-key": plain_b})
    assert r.status_code in (200, 403), r.text

    # --- per-key read ---
    r = client.get(
        "/v1/admin/api-keys/ci-pipeline/usage?days=7",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "ci-pipeline"
    assert body["window_days"] == 7
    assert len(body["points"]) == 7
    today = date.today().isoformat()
    today_pt = next(p for p in body["points"] if p["day"] == today)
    # 3 driven calls + 1 from this admin read of a *different* key (no),
    # but the admin read is via "adm" env-key, not a DB key, so it does
    # not increment. Counter for ci-pipeline must be exactly 3.
    assert today_pt["count"] == 3, body
    # plus the admin read on /v1/admin/api-keys/<name>/usage itself was
    # made with the env "adm" key, which is not a DB key, so it does not
    # appear in the per-key counters.
    assert body["total"] == 3
    assert body["peak_day"] == today
    assert body["peak_count"] == 3

    # --- isolation: key B has its own count ---
    r = client.get(
        "/v1/admin/api-keys/analyst-laptop/usage?days=7",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200
    body_b = r.json()
    today_b = next(p for p in body_b["points"] if p["day"] == today)
    assert today_b["count"] == 1
    assert body_b["total"] == 1

    # --- list rollup, sorted by total desc ---
    r = client.get(
        "/v1/admin/api-keys/usage?days=14",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    rows = r.json()["rows"]
    names = [r_["name"] for r_ in rows]
    assert "ci-pipeline" in names and "analyst-laptop" in names
    ci_idx = names.index("ci-pipeline")
    an_idx = names.index("analyst-laptop")
    assert ci_idx < an_idx, "highest-traffic key must sort first"
    assert rows[ci_idx]["total"] == 3
    assert rows[an_idx]["total"] == 1

    # --- unknown key is 404, not an empty success ---
    r = client.get(
        "/v1/admin/api-keys/nope/usage",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 404

    # --- viewers cannot read usage (admin only) ---
    r = client.get(
        "/v1/admin/api-keys/ci-pipeline/usage",
        headers={"x-api-key": "vwr"},
    )
    assert r.status_code in (401, 403)

    # --- audit log captured the reads ---
    from adherence_common.admin_audit import list_admin_actions
    actions = list_admin_actions(limit=200)
    read_events = [a for a in actions if a.get("action") == "api_key.usage.read"]
    targets = {a.get("target") for a in read_events}
    assert {"ci-pipeline", "analyst-laptop", "nope"}.issubset(targets)
    list_events = [a for a in actions if a.get("action") == "api_key.usage.list"]
    assert any(a.get("target") == "*" for a in list_events)


def test_usage_window_is_zero_filled_and_bounded(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    _create_key(client, "cold-key", role="viewer")

    # No traffic on this key yet.
    r = client.get(
        "/v1/admin/api-keys/cold-key/usage?days=10",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["window_days"] == 10
    assert len(body["points"]) == 10
    assert all(p["count"] == 0 for p in body["points"])
    assert body["total"] == 0
    assert body["peak_count"] == 0
    assert body["peak_day"] is None

    # Days are contiguous and end today.
    days = [p["day"] for p in body["points"]]
    assert days[-1] == date.today().isoformat()
    assert days[0] == (date.today() - timedelta(days=9)).isoformat()

    # Bounds enforced by FastAPI Query validator.
    r = client.get(
        "/v1/admin/api-keys/cold-key/usage?days=0",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 422
    r = client.get(
        "/v1/admin/api-keys/cold-key/usage?days=999",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 422
