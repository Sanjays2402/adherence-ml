"""Tests for adherence_models.promotion (gates + registry promote)."""
from __future__ import annotations

from datetime import datetime

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/promo.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod, db as db_mod
    audit_mod._INITIALIZED = False
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    from adherence_worker import inference as inf
    inf.load_model.cache_clear()
    from adherence_trainer.pipeline import run_training
    run_training(synthetic=True, users=60, days=10, seed=1,
                 register_as="default", use_mlflow=False, cv_splits=0)
    run_training(synthetic=True, users=60, days=10, seed=2,
                 register_as="challenger", use_mlflow=False, cv_splits=0)


def _generate_shadow_traffic(n: int, divergence: float = 0.02) -> None:
    """Insert fake audit rows with a fixed shadow divergence."""
    from adherence_common.db import PredictionAudit, init_db, session
    init_db()
    with session() as s:
        for i in range(n):
            s.add(PredictionAudit(
                request_id=f"r{i:08x}", route="/v1/predict",
                user_id=f"u{i % 5}", caller="svc:test", caller_role="service",
                model_name="default", model_version="v1",
                shadow_model_name="challenger", shadow_model_version="v2",
                shadow_max_divergence=divergence,
                n_doses=1, mean_miss_prob=0.3, max_miss_prob=0.4,
                high_risk_count=0, latency_ms=5.0, ok=1,
                response_summary={"predictions": []},
                created_at=datetime.utcnow(),
            ))
        s.commit()


def test_evaluate_blocks_when_no_shadow_traffic(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_models.promotion import evaluate_promotion
    d = evaluate_promotion(challenger="challenger", target="default")
    assert d.promote is False
    by_name = {g.name: g for g in d.gates}
    assert by_name["shadow_volume"].ok is False
    assert by_name["shadow_divergence_p95"].ok is False


def test_evaluate_passes_with_low_divergence_and_no_outcomes(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _generate_shadow_traffic(150, divergence=0.02)
    from adherence_models.promotion import evaluate_promotion
    d = evaluate_promotion(challenger="challenger", target="default",
                           min_shadow_calls=100)
    assert d.promote is True, [(g.name, g.ok, g.detail) for g in d.gates]
    assert d.summary["n_shadow"] == 150
    assert d.summary["shadow_p95_divergence"] == 0.02


def test_evaluate_blocks_on_high_divergence(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _generate_shadow_traffic(150, divergence=0.30)
    from adherence_models.promotion import evaluate_promotion
    d = evaluate_promotion(challenger="challenger", target="default")
    assert d.promote is False
    by_name = {g.name: g for g in d.gates}
    assert by_name["shadow_divergence_p95"].ok is False


def test_promote_registry_creates_entry(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _generate_shadow_traffic(150, divergence=0.02)
    from adherence_models.promotion import promote_challenger
    from adherence_models.registry import ModelRegistry
    reg = ModelRegistry()
    before = [(a.name, a.version) for a in reg.list(name="default")]
    d = promote_challenger(challenger="challenger", target="default")
    assert d.promote is True
    assert d.artifact is not None
    assert d.artifact.name == "default"
    after = reg.list(name="default")
    assert len(after) == len(before) + 1
    assert "promoted from challenger" in after[-1].notes


def test_promote_force_bypasses_red_gate(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    # No shadow traffic at all -> gates will be red.
    from adherence_models.promotion import promote_challenger
    d = promote_challenger(challenger="challenger", target="default",
                           force=True)
    assert d.promote is True
    assert d.summary.get("forced") is True
    assert d.artifact is not None


def test_cli_promote_dry_run(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _generate_shadow_traffic(150, divergence=0.02)
    from typer.testing import CliRunner
    from adherence_cli.main import app
    res = CliRunner().invoke(app, [
        "promote", "challenger", "--dry-run", "--min-shadow-calls", "100"
    ])
    assert res.exit_code == 0, res.output
    assert "would promote" in res.output


def test_cli_promote_blocks_on_red_gate(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from typer.testing import CliRunner
    from adherence_cli.main import app
    res = CliRunner().invoke(app, ["promote", "challenger"])
    # No shadow traffic -> gates red -> exit 2, no promotion
    assert res.exit_code == 2, res.output
    assert "not promoted" in res.output
