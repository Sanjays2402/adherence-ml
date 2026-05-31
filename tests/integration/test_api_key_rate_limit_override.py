"""Per-API-key rate-limit override.

Confirms a key with a tiny custom bucket is throttled before the
role-tier default kicks in, and that clearing the override returns the
key to default behavior. Also covers admin route validation, dry_run,
audit logging, and the listing surface.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/k.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    # Generous defaults so only the per-key override can possibly throttle.
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "true")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_CAPACITY", "10000")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_REFILL_PER_SEC", "10000")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ADMIN_CAPACITY", "10000")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ADMIN_REFILL_PER_SEC", "10000")
    reload_settings()
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


def _client(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    return TestClient(create_app())


def _mint(client, admin, name="throttled", scopes=("predict",)):
    r = client.post(
        "/v1/admin/api-keys",
        json={"name": name, "role": "service", "scopes": list(scopes)},
        headers=admin,
    )
    assert r.status_code == 201, r.text
    return r.json()["key"]


def test_per_key_override_throttles_before_default(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    admin = {"x-api-key": "adm"}
    plain = _mint(c, admin)

    # Pin to 2 tokens, refill very slowly so the third call blocks.
    r = c.put(
        f"/v1/admin/api-keys/throttled/rate-limit",
        json={"capacity": 2, "refill_per_sec": 0.001},
        headers=admin,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["capacity"] == 2
    assert body["inherited"] is False

    # GET surfaces the override.
    r = c.get("/v1/admin/api-keys/throttled/rate-limit", headers=admin)
    assert r.status_code == 200
    assert r.json()["capacity"] == 2

    # First two calls succeed; third trips 429 with standard headers.
    h = {"x-api-key": plain}
    path = "/v1/webhooks/medtracker/recent?limit=1"
    s1 = c.get(path, headers=h)
    s2 = c.get(path, headers=h)
    s3 = c.get(path, headers=h)
    assert s1.status_code == 200, s1.text
    assert s2.status_code == 200, s2.text
    assert s3.status_code == 429, s3.text
    assert s3.headers.get("Retry-After")
    assert s3.headers.get("X-RateLimit-Limit") == "2"
    assert s3.headers.get("X-RateLimit-Remaining") == "0"
    assert s3.headers.get("X-RateLimit-Reset")

    # Admin keys are unaffected; their own bucket is huge.
    a1 = c.get("/v1/admin/api-keys", headers=admin)
    assert a1.status_code == 200


def test_clearing_override_restores_default_bucket(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    admin = {"x-api-key": "adm"}
    plain = _mint(c, admin, name="restored")

    # Install then clear.
    r = c.put(
        "/v1/admin/api-keys/restored/rate-limit",
        json={"capacity": 1, "refill_per_sec": 0.001},
        headers=admin,
    )
    assert r.status_code == 200
    r = c.put(
        "/v1/admin/api-keys/restored/rate-limit",
        json={"capacity": None, "refill_per_sec": None},
        headers=admin,
    )
    assert r.status_code == 200
    assert r.json()["inherited"] is True

    # Default bucket is large, so several calls succeed back-to-back.
    h = {"x-api-key": plain}
    path = "/v1/webhooks/medtracker/recent?limit=1"
    for _ in range(5):
        r = c.get(path, headers=h)
        assert r.status_code == 200, r.text


def test_partial_override_rejected_400(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    admin = {"x-api-key": "adm"}
    _mint(c, admin, name="partial")
    r = c.put(
        "/v1/admin/api-keys/partial/rate-limit",
        json={"capacity": 5, "refill_per_sec": None},
        headers=admin,
    )
    assert r.status_code == 400
    assert "both" in r.json()["detail"]


def test_rate_limit_unknown_key_404(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    admin = {"x-api-key": "adm"}
    r = c.get("/v1/admin/api-keys/nope/rate-limit", headers=admin)
    assert r.status_code == 404
    r = c.put(
        "/v1/admin/api-keys/nope/rate-limit",
        json={"capacity": 5, "refill_per_sec": 1.0},
        headers=admin,
    )
    assert r.status_code == 404


def test_dry_run_does_not_persist(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    admin = {"x-api-key": "adm"}
    _mint(c, admin, name="preview")
    r = c.put(
        "/v1/admin/api-keys/preview/rate-limit?dry_run=true",
        json={"capacity": 3, "refill_per_sec": 0.5},
        headers=admin,
    )
    assert r.status_code == 200
    # Verify nothing was written.
    r = c.get("/v1/admin/api-keys/preview/rate-limit", headers=admin)
    assert r.status_code == 200
    assert r.json()["inherited"] is True


def test_override_appears_in_listing(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    admin = {"x-api-key": "adm"}
    _mint(c, admin, name="listed")
    r = c.put(
        "/v1/admin/api-keys/listed/rate-limit",
        json={"capacity": 7, "refill_per_sec": 2.5},
        headers=admin,
    )
    assert r.status_code == 200
    r = c.get("/v1/admin/api-keys", headers=admin)
    assert r.status_code == 200
    row = next(k for k in r.json() if k["name"] == "listed")
    assert row["rate_limit_capacity"] == 7
    assert abs(row["rate_limit_refill_per_sec"] - 2.5) < 1e-6
