"""adherence-ml CLI: train, predict, backtest, generate-data, serve."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.table import Table

from adherence_common.logging import configure_logging, get_logger
from adherence_common.settings import get_settings

app = typer.Typer(add_completion=False, no_args_is_help=True, help="adherence-ml CLI")
console = Console()
log = get_logger(__name__)


@app.callback()
def _root(verbose: bool = typer.Option(False, "--verbose", "-v")) -> None:
    s = get_settings()
    configure_logging(level="DEBUG" if verbose else s.log_level, fmt=s.log_format)


@app.command()
def version() -> None:
    """Print package version."""
    from adherence_common.version import __version__
    console.print(f"adherence-ml {__version__}")


@app.command("generate-data")
def generate_data(
    out: Path = typer.Option(Path("data/generated/events.parquet"), "--out", "-o"),
    users: int = typer.Option(5000, "--users"),
    days: int = typer.Option(60, "--days"),
    seed: int = typer.Option(42, "--seed"),
) -> None:
    """Generate synthetic adherence events."""
    from adherence_data import SyntheticConfig, generate_events, save_events
    cfg = SyntheticConfig(n_users=users, n_days=days, seed=seed)
    df = generate_events(cfg)
    p = save_events(df, out)
    console.print(f"[green]wrote {len(df):,} events to {p}[/green]")


@app.command()
def train(
    synthetic: bool = typer.Option(True, "--synthetic/--no-synthetic"),
    events_path: Optional[Path] = typer.Option(None, "--events"),
    users: int = typer.Option(5000, "--users"),
    days: int = typer.Option(60, "--days"),
    seed: int = typer.Option(42, "--seed"),
    register_as: str = typer.Option("default", "--name"),
    use_mlflow: bool = typer.Option(True, "--mlflow/--no-mlflow"),
) -> None:
    """Train ensemble model (synthetic or from events file)."""
    from adherence_trainer.pipeline import run_training
    res = run_training(
        synthetic=synthetic,
        events_path=str(events_path) if events_path else None,
        users=users,
        days=days,
        seed=seed,
        register_as=register_as,
        use_mlflow=use_mlflow,
    )
    tbl = Table(title=f"Training complete: {register_as} v{res['model_version']}")
    tbl.add_column("metric"); tbl.add_column("value", justify="right")
    for k, v in res["metrics"].items():
        tbl.add_row(k, f"{v:.4f}" if isinstance(v, float) else str(v))
    console.print(tbl)


@app.command()
def backtest(
    events_path: Optional[Path] = typer.Option(None, "--events"),
    synthetic: bool = typer.Option(True, "--synthetic/--no-synthetic"),
    test_days: int = typer.Option(7, "--test-days"),
    users: int = typer.Option(2000, "--users"),
    days: int = typer.Option(45, "--days"),
) -> None:
    """Time-series backtest: train on past, evaluate on the most recent days."""
    from adherence_trainer.pipeline import run_backtest
    res = run_backtest(
        synthetic=synthetic,
        events_path=str(events_path) if events_path else None,
        test_days=test_days,
        users=users,
        days=days,
    )
    console.print_json(json.dumps(res, default=str))


@app.command()
def predict(
    user_id: str = typer.Argument(...),
    schedule_path: Path = typer.Option(..., "--schedule"),
    history_path: Optional[Path] = typer.Option(None, "--history"),
    model_name: str = typer.Option("default", "--model"),
    top_k: int = typer.Option(3, "--top-k"),
) -> None:
    """Score upcoming doses from a JSON schedule file."""
    from adherence_worker.inference import predict_doses
    schedule = json.loads(schedule_path.read_text())
    history = None
    if history_path:
        from adherence_data.loaders import load_events_csv, load_events_parquet
        if history_path.suffix == ".csv":
            history = load_events_csv(history_path)
        else:
            history = load_events_parquet(history_path)
    out = predict_doses(user_id, schedule, history, model_name=model_name, top_k=top_k)
    console.print_json(json.dumps(out, default=str))


@app.command()
def serve(
    host: str = typer.Option(None, "--host"),
    port: int = typer.Option(None, "--port"),
    reload: bool = typer.Option(False, "--reload"),
) -> None:
    """Run the FastAPI server."""
    import uvicorn
    s = get_settings()
    uvicorn.run(
        "adherence_api.app:create_app",
        factory=True,
        host=host or s.api_host,
        port=port or s.api_port,
        reload=reload,
    )


@app.command("list-models")
def list_models() -> None:
    from adherence_models.registry import ModelRegistry
    reg = ModelRegistry()
    items = reg.list()
    tbl = Table(title="Registered models")
    tbl.add_column("name"); tbl.add_column("version"); tbl.add_column("auc", justify="right"); tbl.add_column("path")
    for i in items:
        tbl.add_row(i.name, i.version, f"{i.metrics.get('auc', i.metrics.get('auc_calibrated', 0.0)):.4f}", i.path)
    console.print(tbl)


@app.command("promote")
def promote_cmd(
    challenger: str = typer.Argument(..., help="challenger model name"),
    target: str = typer.Option("default", "--target"),
    window_hours: int = typer.Option(168, "--window-hours"),
    min_shadow_calls: int = typer.Option(100, "--min-shadow-calls"),
    max_p95_divergence: float = typer.Option(0.15, "--max-p95-divergence"),
    min_matched_outcomes: int = typer.Option(50, "--min-matched-outcomes"),
    max_brier_regression: float = typer.Option(0.01, "--max-brier-regression"),
    min_auc_delta: float = typer.Option(-0.01, "--min-auc-delta"),
    dry_run: bool = typer.Option(False, "--dry-run",
                                 help="evaluate gates, do not modify registry"),
    force: bool = typer.Option(False, "--force",
                               help="promote even if gates fail"),
) -> None:
    """Run safety gates and promote a challenger model to `target`.

    Exit code is 0 on a promotion (or a green dry-run) and 2 when gates
    block promotion, so this slots straight into CI.
    """
    from adherence_models.promotion import (
        evaluate_promotion,
        promote_challenger,
    )
    kw = dict(
        challenger=challenger, target=target,
        window_hours=window_hours,
        min_shadow_calls=min_shadow_calls,
        max_p95_divergence=max_p95_divergence,
        min_matched_outcomes=min_matched_outcomes,
        max_brier_regression=max_brier_regression,
        min_auc_delta=min_auc_delta,
    )
    if dry_run:
        decision = evaluate_promotion(**kw)
    else:
        decision = promote_challenger(force=force, **kw)

    tbl = Table(title=f"promote {challenger} -> {target}")
    tbl.add_column("gate")
    tbl.add_column("ok")
    tbl.add_column("value", justify="right")
    tbl.add_column("threshold", justify="right")
    tbl.add_column("detail")
    for g in decision.gates:
        tbl.add_row(
            g.name,
            "[green]yes[/green]" if g.ok else "[red]no[/red]",
            "" if g.value is None else f"{g.value:.4f}" if isinstance(g.value, float) else str(g.value),
            "" if g.threshold is None else f"{g.threshold}",
            g.detail,
        )
    console.print(tbl)
    console.print(json.dumps(decision.summary, indent=2, default=str))
    if decision.artifact:
        console.print(
            f"[green]promoted {challenger}@{decision.artifact.version} -> {target}[/green]"
        )
    elif dry_run:
        verdict = "would promote" if decision.promote else "would NOT promote"
        console.print(f"[yellow]dry-run: {verdict}[/yellow]")
    else:
        console.print("[red]not promoted: one or more gates failed[/red]")
        raise typer.Exit(code=2)


@app.command("expire-interventions")
def expire_interventions(
    max_age_minutes: int = typer.Option(
        None, "--max-age-minutes",
        help="Override the configured max age (default: setting).",
    ),
) -> None:
    """Flip stale `recommended` intervention deliveries to `expired`.

    Intended to be invoked from cron or systemd timers in deployments that
    do not run the in-process scheduler.
    """
    from adherence_common import deliveries as dmod
    age = max_age_minutes or get_settings().intervention_max_age_minutes
    n = dmod.expire_stale(age)
    console.print(f"expired {n} deliveries older than {age} minutes")


@app.command("delivery-stats")
def delivery_stats(
    window_hours: int = typer.Option(24, "--window-hours"),
) -> None:
    """Print intervention delivery counts over the given window."""
    from adherence_common import deliveries as dmod
    out = dmod.stats(window_hours)
    console.print_json(data=out)


if __name__ == "__main__":
    app()
