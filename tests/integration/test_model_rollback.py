"""Tests for model rollback: registry method, admin endpoint, CLI."""
from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/r.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


class _Dummy:
    """Fake model with the minimum surface ModelArtifact + load need."""
    feature_columns = ["a", "b"]


def _make_versions(tmp_path, monkeypatch, n=2):
    _setup(tmp_path, monkeypatch)
    from adherence_models.registry import ModelRegistry
    reg = ModelRegistry()
    arts = []
    for i in range(n):
        arts.append(reg.save("default", _Dummy(), metrics={"auc": 0.7 + 0.01 * i},
                             notes=f"v{i}"))
        time.sleep(1.05)  # version is YYYYMMDD-HHMMSS; ensure unique stamps
    return reg, arts


def test_rollback_to_previous_when_unspecified(tmp_path, monkeypatch):
    reg, arts = _make_versions(tmp_path, monkeypatch, n=3)
    assert reg.latest("default")[0].version == arts[-1].version
    rolled = reg.rollback("default", by="ops", reason="bad shadow metrics")
    assert rolled.version == arts[-2].version
    assert "rolled back from" in rolled.notes
    assert "by ops" in rolled.notes
    assert "bad shadow metrics" in rolled.notes
    assert reg.latest("default")[0].version == arts[-2].version


def test_rollback_to_specific_version(tmp_path, monkeypatch):
    reg, arts = _make_versions(tmp_path, monkeypatch, n=3)
    rolled = reg.rollback("default", to_version=arts[0].version)
    assert rolled.version == arts[0].version
    # File path is reused (cheap rollback)
    assert rolled.path == arts[0].path


def test_rollback_rejects_when_only_one_version(tmp_path, monkeypatch):
    reg, _ = _make_versions(tmp_path, monkeypatch, n=1)
    from adherence_common.errors import ModelNotFoundError
    with pytest.raises(ModelNotFoundError):
        reg.rollback("default")


def test_rollback_rejects_unknown_version(tmp_path, monkeypatch):
    reg, _ = _make_versions(tmp_path, monkeypatch, n=2)
    from adherence_common.errors import ModelNotFoundError
    with pytest.raises(ModelNotFoundError):
        reg.rollback("default", to_version="nope")


def test_rollback_rejects_when_target_is_already_latest(tmp_path, monkeypatch):
    reg, arts = _make_versions(tmp_path, monkeypatch, n=2)
    from adherence_common.errors import ModelNotFoundError
    with pytest.raises(ModelNotFoundError):
        reg.rollback("default", to_version=arts[-1].version)


def test_admin_endpoint_rolls_back(tmp_path, monkeypatch):
    _make_versions(tmp_path, monkeypatch, n=3)
    from adherence_api.app import create_app
    c = TestClient(create_app())
    r = c.post(
        "/v1/admin/models/default/rollback",
        json={"reason": "post-promote regression"},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "default"
    assert body["previous_version"] != body["rolled_back_to"]
    assert "rolled back from" in body["notes"]


def test_admin_endpoint_requires_admin_role(tmp_path, monkeypatch):
    _make_versions(tmp_path, monkeypatch, n=2)
    from adherence_api.app import create_app
    c = TestClient(create_app())
    r = c.post(
        "/v1/admin/models/default/rollback",
        json={}, headers={"x-api-key": "svc"},
    )
    assert r.status_code == 403


def test_admin_endpoint_404_when_unknown_model(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    c = TestClient(create_app())
    r = c.post(
        "/v1/admin/models/ghost/rollback",
        json={}, headers={"x-api-key": "adm"},
    )
    assert r.status_code == 404


def test_admin_endpoint_400_when_no_prior_version(tmp_path, monkeypatch):
    _make_versions(tmp_path, monkeypatch, n=1)
    from adherence_api.app import create_app
    c = TestClient(create_app())
    r = c.post(
        "/v1/admin/models/default/rollback",
        json={}, headers={"x-api-key": "adm"},
    )
    assert r.status_code == 400


def test_admin_endpoint_busts_inference_cache(tmp_path, monkeypatch):
    """The rollback handler must call load_model.cache_clear() so the next
    inference picks up the rolled-back artifact."""
    _make_versions(tmp_path, monkeypatch, n=2)
    from adherence_worker import inference as inf

    cleared = {"n": 0}
    real_clear = inf.load_model.cache_clear

    def _spy():
        cleared["n"] += 1
        real_clear()

    monkeypatch.setattr(inf.load_model, "cache_clear", _spy)
    from adherence_api.app import create_app
    c = TestClient(create_app())
    r = c.post(
        "/v1/admin/models/default/rollback",
        json={}, headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200
    assert cleared["n"] >= 1


def test_cli_rollback_command(tmp_path, monkeypatch):
    _make_versions(tmp_path, monkeypatch, n=2)
    from typer.testing import CliRunner
    from adherence_cli.main import app

    runner = CliRunner()
    result = runner.invoke(app, ["rollback", "default", "--reason", "cli test"])
    assert result.exit_code == 0, result.output
    assert "rolled back" in result.output


def test_cli_rollback_exits_2_when_no_prior(tmp_path, monkeypatch):
    _make_versions(tmp_path, monkeypatch, n=1)
    from typer.testing import CliRunner
    from adherence_cli.main import app
    runner = CliRunner()
    result = runner.invoke(app, ["rollback", "default"])
    assert result.exit_code == 2
