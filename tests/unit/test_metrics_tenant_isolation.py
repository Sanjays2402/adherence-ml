"""Cross-tenant isolation for /v1/metrics/online.

Regression: ground-truth dose_outcomes used to be a global table with no
tenant_id, so a workspace admin could compute live AUC/Brier from
another workspace's predictions joined against shared outcomes. This
test pins the contract that:

  * DoseOutcome now carries tenant_id at write time.
  * _collect / _collect_rich filter outcomes AND prediction_audit rows
    by the caller's tenant.
  * Two tenants with identical user_ids and dose_ids see only their
    own rows, never each other's.
"""
from __future__ import annotations

import os
import tempfile
from datetime import datetime, timedelta

import pytest

_TMP = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP.close()
os.environ["ADHERENCE_DB_URL"] = f"sqlite:///{_TMP.name}"
os.environ.setdefault("JWT_SECRET", "x" * 32)

from adherence_common.db import (  # noqa: E402
    DoseOutcome,
    PredictionAudit,
    init_db,
    session,
)
from sqlalchemy import delete  # noqa: E402

from adherence_api.routes.metrics import _collect, _collect_rich  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_db():
    init_db()
    with session() as s:
        s.execute(delete(DoseOutcome))
        s.execute(delete(PredictionAudit))
        s.commit()
    yield


def _seed(tenant: str, user: str, dose: str, miss_prob: float, outcome: str) -> None:
    now = datetime.utcnow()
    with session() as s:
        s.add(DoseOutcome(
            tenant_id=tenant,
            source="medtracker",
            external_event_id=f"{tenant}-{dose}",
            user_id=user,
            dose_id=dose,
            scheduled_at=now - timedelta(hours=1),
            observed_at=now,
            outcome=outcome,
            received_at=now,
        ))
        s.add(PredictionAudit(
            tenant_id=tenant,
            request_id=f"req-{tenant}-{dose}",
            route="/v1/predict",
            user_id=user,
            caller=f"api-key:{tenant}",
            caller_role="service",
            model_name="m",
            model_version="v1",
            n_doses=1,
            ok=1,
            response_summary={"predictions": [
                {"dose_id": dose, "miss_probability": miss_prob}
            ]},
            created_at=now,
        ))
        s.commit()


def test_dose_outcome_has_tenant_column():
    # If the column is missing, write below fails with a SQLAlchemy error.
    _seed("acme", "u-1", "d-1", 0.9, "missed")
    from sqlalchemy import select
    with session() as s:
        rows = list(s.scalars(select(DoseOutcome)))
    assert rows, "dose_outcome was not persisted"
    assert rows[0].tenant_id == "acme"


def test_collect_does_not_leak_across_tenants():
    # Two tenants, identical user/dose ids, opposite outcomes.
    _seed("acme",  "u-1", "d-1", 0.9, "missed")
    _seed("globex", "u-1", "d-1", 0.1, "taken")

    acme_rows, _ = _collect(window_hours=24, model_name=None, tenant_id="acme")
    globex_rows, _ = _collect(window_hours=24, model_name=None, tenant_id="globex")

    assert len(acme_rows) == 1
    assert len(globex_rows) == 1

    # Acme sees only its missed outcome (y=1, p=0.9). Globex sees the
    # opposite. If the join leaked across tenants we would see y values
    # from the other workspace, or two rows, or mismatched probabilities.
    _, p_a, y_a, _ = acme_rows[0]
    _, p_g, y_g, _ = globex_rows[0]
    assert (round(p_a, 2), y_a) == (0.9, 1)
    assert (round(p_g, 2), y_g) == (0.1, 0)


def test_collect_rich_also_scoped():
    _seed("acme", "u-2", "d-2", 0.7, "missed")
    _seed("globex", "u-2", "d-2", 0.2, "taken")

    rich_acme = _collect_rich(window_hours=24, model_name=None, tenant_id="acme")
    rich_globex = _collect_rich(window_hours=24, model_name=None, tenant_id="globex")
    assert len(rich_acme) == 1 and len(rich_globex) == 1
    assert rich_acme[0][2] == 1   # y for acme
    assert rich_globex[0][2] == 0  # y for globex


def test_collect_unknown_tenant_returns_empty():
    _seed("acme", "u-3", "d-3", 0.5, "missed")
    rows, n = _collect(window_hours=24, model_name=None, tenant_id="someone-else")
    assert rows == [] and n == 0
