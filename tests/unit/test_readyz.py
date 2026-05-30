"""Unit tests for the /readyz Kubernetes readiness probe.

These tests monkeypatch the dep checks inside ``adherence_api.routes.health``
to avoid spinning up Postgres / Redis. They verify the contract that matters
to Kubernetes: 200 only when required deps are healthy, 503 otherwise.
"""
from __future__ import annotations

from adherence_common.settings import reload_settings
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _client(monkeypatch, *, db_ok=True, redis_ok=True, model_ok=True,
            require_redis=False, tmp_path=None):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv(
        "ADHERENCE_READYZ_REQUIRE_REDIS",
        "true" if require_redis else "false",
    )
    if tmp_path is not None:
        monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/r.db")
        monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    reload_settings()

    from adherence_api.routes import health as health_mod

    monkeypatch.setattr(health_mod, "_check_db", lambda url: db_ok)
    monkeypatch.setattr(health_mod, "_check_redis", lambda url: redis_ok)
    monkeypatch.setattr(health_mod, "_model_loaded", lambda: model_ok)

    app = FastAPI()
    app.include_router(health_mod.router)
    return TestClient(app)


def test_readyz_all_healthy_returns_200(monkeypatch, tmp_path):
    c = _client(monkeypatch, tmp_path=tmp_path)
    r = c.get("/readyz")
    assert r.status_code == 200
    body = r.json()
    assert body["ready"] is True
    assert body["checks"] == {"db": True, "redis": True, "model": True}
    assert body["require_redis"] is False


def test_readyz_db_down_returns_503(monkeypatch, tmp_path):
    c = _client(monkeypatch, db_ok=False, tmp_path=tmp_path)
    r = c.get("/readyz")
    assert r.status_code == 503
    body = r.json()
    assert body["ready"] is False
    assert body["checks"]["db"] is False


def test_readyz_no_model_returns_503(monkeypatch, tmp_path):
    c = _client(monkeypatch, model_ok=False, tmp_path=tmp_path)
    r = c.get("/readyz")
    assert r.status_code == 503
    assert r.json()["checks"]["model"] is False


def test_readyz_redis_soft_by_default(monkeypatch, tmp_path):
    c = _client(monkeypatch, redis_ok=False, tmp_path=tmp_path)
    r = c.get("/readyz")
    # redis down but not required: still ready.
    assert r.status_code == 200
    body = r.json()
    assert body["ready"] is True
    assert body["checks"]["redis"] is False


def test_readyz_redis_required_fails_when_down(monkeypatch, tmp_path):
    c = _client(monkeypatch, redis_ok=False, require_redis=True, tmp_path=tmp_path)
    r = c.get("/readyz")
    assert r.status_code == 503
    body = r.json()
    assert body["ready"] is False
    assert body["require_redis"] is True


def test_livez_always_ok(monkeypatch, tmp_path):
    c = _client(monkeypatch, db_ok=False, redis_ok=False, model_ok=False,
                tmp_path=tmp_path)
    r = c.get("/livez")
    assert r.status_code == 200
    assert r.json()["alive"] is True
