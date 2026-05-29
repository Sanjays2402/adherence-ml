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


if __name__ == "__main__":
    app()
