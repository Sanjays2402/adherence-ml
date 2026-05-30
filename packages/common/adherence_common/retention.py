"""Audit table retention sweeper.

Bounded-size retention for high-churn observability tables:
``prediction_audit``, ``dose_outcomes``, ``webhook_deliveries``,
``idempotency_records``. Deployments accumulate millions of rows over
months and most clinical replay only needs the last 30-90 days. This
module deletes rows older than a per-table TTL and returns counts.

Designed to be called from cron, a systemd timer, or the admin endpoint
``POST /v1/admin/audit/retention``. All deletes happen in a single
transaction per table so we never half-prune.

Defaults are conservative; pass explicit ``ttl_days`` overrides to be
more aggressive.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Iterable

from sqlalchemy import delete, func, select

from adherence_common.db import (
    DoseOutcome,
    IdempotencyRecord,
    PredictionAudit,
    WebhookDelivery,
    init_db,
    session,
)
from adherence_common.logging import get_logger

log = get_logger(__name__)

DEFAULT_TTLS_DAYS: dict[str, int] = {
    "prediction_audit": 90,
    "dose_outcomes": 180,
    "webhook_deliveries": 30,
    "idempotency_records": 2,
}

_MODEL_BY_NAME = {
    "prediction_audit": (PredictionAudit, PredictionAudit.created_at),
    "dose_outcomes": (DoseOutcome, DoseOutcome.received_at),
    "webhook_deliveries": (WebhookDelivery, WebhookDelivery.created_at),
    "idempotency_records": (IdempotencyRecord, IdempotencyRecord.expires_at),
}


@dataclass
class TableSweep:
    table: str
    cutoff: datetime
    candidates: int
    deleted: int


def _normalize(ttls: dict[str, int] | None) -> dict[str, int]:
    out = dict(DEFAULT_TTLS_DAYS)
    if ttls:
        for k, v in ttls.items():
            if k not in _MODEL_BY_NAME:
                raise ValueError(f"unknown retention table: {k}")
            if int(v) < 0:
                raise ValueError(f"ttl_days for {k} must be >= 0")
            out[k] = int(v)
    return out


def sweep(
    *,
    ttls_days: dict[str, int] | None = None,
    tables: Iterable[str] | None = None,
    now: datetime | None = None,
    dry_run: bool = False,
) -> list[TableSweep]:
    """Delete rows older than ``ttl_days`` per table.

    Returns one ``TableSweep`` per table touched. ``dry_run`` reports
    candidate counts without deleting.
    """
    init_db()
    now = now or datetime.utcnow()
    ttls = _normalize(ttls_days)
    target_tables = list(tables) if tables else list(_MODEL_BY_NAME.keys())
    for t in target_tables:
        if t not in _MODEL_BY_NAME:
            raise ValueError(f"unknown retention table: {t}")
    results: list[TableSweep] = []
    with session() as s:
        for tname in target_tables:
            model, ts_col = _MODEL_BY_NAME[tname]
            cutoff = now - timedelta(days=ttls[tname])
            n = s.execute(
                select(func.count()).select_from(model).where(ts_col < cutoff)
            ).scalar_one()
            deleted = 0
            if not dry_run and n:
                res = s.execute(delete(model).where(ts_col < cutoff))
                deleted = int(res.rowcount or 0)
            results.append(
                TableSweep(
                    table=tname,
                    cutoff=cutoff,
                    candidates=int(n),
                    deleted=deleted,
                )
            )
        if not dry_run:
            s.commit()
    log.info(
        "retention_sweep",
        dry_run=dry_run,
        results=[r.__dict__ for r in results],
    )
    return results
