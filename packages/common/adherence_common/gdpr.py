"""Per-user data lifecycle: export and erasure.

Implements the data-subject access (export) and right-to-erasure (delete)
operations required by GDPR / HIPAA-aligned data minimization for every
table that carries a ``user_id`` column. Operations run in a single
transaction per call so partial exports / deletes never leak state.

Tables touched:

* ``predictions``                 (PredictionRow)
* ``prediction_audit``            (PredictionAudit)
* ``dose_outcomes``               (DoseOutcome)
* ``intervention_deliveries``     (InterventionDelivery)
* ``user_mutes``                  (UserMute)
* ``quiet_hours_policies``        (QuietHoursPolicy)
* ``notification_budgets``        (NotificationBudget)
* ``user_risk_policies``          (UserRiskPolicy, scope_type='user')
* ``experiment_exposures``        (ExperimentExposure)
* ``experiment_events``           (ExperimentEvent)

The export shape is stable JSON so callers can diff snapshots between
runs. The erasure path returns a per-table delete count for audit.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import delete, select

from adherence_common.db import (
    DoseOutcome,
    ExperimentEvent,
    ExperimentExposure,
    InterventionDelivery,
    NotificationBudget,
    PredictionAudit,
    PredictionRow,
    QuietHoursPolicy,
    UserMute,
    UserRiskPolicy,
    init_db,
    session,
)
from adherence_common.logging import get_logger

log = get_logger(__name__)

_INITIALIZED = False


def _ensure_tables() -> None:
    global _INITIALIZED
    if _INITIALIZED:
        return
    try:
        init_db()
        _INITIALIZED = True
    except Exception as exc:  # pragma: no cover - depends on db backend
        log.warning("gdpr_init_failed", error=str(exc))


# (table_name, ORM model, user_id column, extra filter callable or None)
_USER_TABLES: list[tuple[str, Any, Any, Any]] = [
    ("predictions", PredictionRow, PredictionRow.user_id, None),
    ("prediction_audit", PredictionAudit, PredictionAudit.user_id, None),
    ("dose_outcomes", DoseOutcome, DoseOutcome.user_id, None),
    ("intervention_deliveries", InterventionDelivery, InterventionDelivery.user_id, None),
    ("user_mutes", UserMute, UserMute.user_id, None),
    ("quiet_hours_policies", QuietHoursPolicy, QuietHoursPolicy.user_id, None),
    ("notification_budgets", NotificationBudget, NotificationBudget.user_id, None),
    (
        "user_risk_policies",
        UserRiskPolicy,
        UserRiskPolicy.scope_id,
        lambda model: model.scope_type == "user",
    ),
    ("experiment_exposures", ExperimentExposure, ExperimentExposure.user_id, None),
    ("experiment_events", ExperimentEvent, ExperimentEvent.user_id, None),
]


def _row_to_dict(row: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for col in row.__table__.columns:
        val = getattr(row, col.key, None)
        if isinstance(val, datetime):
            val = val.isoformat()
        out[col.key] = val
    return out


@dataclass
class ExportResult:
    user_id: str
    generated_at: str
    counts: dict[str, int] = field(default_factory=dict)
    tables: dict[str, list[dict[str, Any]]] = field(default_factory=dict)


@dataclass
class EraseResult:
    user_id: str
    erased_at: str
    deleted: dict[str, int] = field(default_factory=dict)
    total: int = 0


def export_user(user_id: str) -> ExportResult:
    """Return every row across the system that references ``user_id``.

    Read-only; safe to call from any role with the appropriate scope.
    """
    if not user_id:
        raise ValueError("user_id required")
    _ensure_tables()
    res = ExportResult(user_id=user_id, generated_at=datetime.utcnow().isoformat())
    with session() as s:
        for name, model, col, extra in _USER_TABLES:
            stmt = select(model).where(col == user_id)
            if extra is not None:
                stmt = stmt.where(extra(model))
            rows = s.execute(stmt).scalars().all()
            res.tables[name] = [_row_to_dict(r) for r in rows]
            res.counts[name] = len(rows)
    return res


def erase_user(user_id: str) -> EraseResult:
    """Hard-delete every row across the system that references ``user_id``.

    Single transaction per call. Returns per-table delete counts.

    Note: ``training_runs`` and aggregate model registries are deliberately
    untouched because they hold population-level statistics that no longer
    identify the subject after row-level deletion. Callers wanting full
    re-training without the user's data should kick off ``POST /v1/train/async``
    after erasure.
    """
    if not user_id:
        raise ValueError("user_id required")
    _ensure_tables()
    res = EraseResult(user_id=user_id, erased_at=datetime.utcnow().isoformat())
    with session() as s:
        for name, model, col, extra in _USER_TABLES:
            stmt = delete(model).where(col == user_id)
            if extra is not None:
                stmt = stmt.where(extra(model))
            result = s.execute(stmt)
            n = int(result.rowcount or 0)
            res.deleted[name] = n
            res.total += n
        s.commit()
    log.info("gdpr_erase", user_id=user_id, total=res.total, per_table=res.deleted)
    return res
