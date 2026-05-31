"""Integration test: per-workspace data retention policy.

Proves the enterprise guarantee that a workspace admin can declare
their own data-retention ceiling for tenant-scoped audit tables and
that a sweep using that policy:

1. Deletes only rows older than the configured TTL.
2. Is strictly scoped to the caller's tenant; rows belonging to another
   workspace are never touched, even if the two workspaces share the
   same database.
3. Honours ``dry_run`` (counts candidates, deletes nothing).
4. Rejects unknown table names and out-of-range TTLs with HTTP 400.
5. Writes an entry to the admin audit log for every mutation.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/retpol.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()


def _mint(client: TestClient, *, subject: str, tenant: str, role: str = "admin") -> str:
    r = client.post(
        "/v1/admin/token",
        json={"subject": subject, "role": role, "tenant": tenant},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _seed_audit(tenant: str, *, ages_days: list[int]) -> list[int]:
    """Insert PredictionAudit rows for ``tenant`` aged ``ages_days`` days.

    Returns the row IDs in insert order so tests can assert which rows
    survived. Uses a fresh session so commits land on the engine that
    the API process also opened against the same sqlite URL.
    """
    from adherence_common.db import PredictionAudit, session
    now = datetime.utcnow()
    ids: list[int] = []
    with session() as s:
        for age in ages_days:
            row = PredictionAudit(
                tenant_id=tenant,
                request_id="rid",
                route="/v1/predict",
                user_id="u",
                caller="test",
                caller_role="admin",
                model_name="m",
                model_version="v",
                n_doses=1,
                high_risk_count=0,
                ok=1,
                created_at=now - timedelta(days=age),
            )
            s.add(row)
            s.flush()
            ids.append(int(row.id))
        s.commit()
    return ids


def _count_audit(tenant: str) -> int:
    from sqlalchemy import func, select
    from adherence_common.db import PredictionAudit, session
    with session() as s:
        return int(
            s.execute(
                select(func.count())
                .select_from(PredictionAudit)
                .where(PredictionAudit.tenant_id == tenant)
            ).scalar_one()
        )


def test_retention_policy_scoped_sweep_isolates_tenants(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    acme_admin = _mint(client, subject="alice", tenant="acme")
    globex_admin = _mint(client, subject="bob", tenant="globex")
    acme_viewer = _mint(client, subject="vee", tenant="acme", role="viewer")

    # Default: no policy on file.
    r0 = client.get(
        "/v1/workspace/retention-policy",
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r0.status_code == 200, r0.text
    body0 = r0.json()
    assert body0["tenant_id"] == "acme"
    assert body0["ttls_days"] == {}
    assert "prediction_audit" in body0["allowed_tables"]

    # Viewer can read policy but cannot write.
    rv = client.get(
        "/v1/workspace/retention-policy",
        headers={"Authorization": f"Bearer {acme_viewer}"},
    )
    assert rv.status_code == 200
    rv_put = client.put(
        "/v1/workspace/retention-policy",
        json={"ttls_days": {"prediction_audit": 7}},
        headers={"Authorization": f"Bearer {acme_viewer}"},
    )
    assert rv_put.status_code in (401, 403)

    # Validation: unknown table.
    r_bad = client.put(
        "/v1/workspace/retention-policy",
        json={"ttls_days": {"not_a_table": 7}},
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_bad.status_code == 400, r_bad.text

    # Validation: out-of-range TTL.
    r_bad2 = client.put(
        "/v1/workspace/retention-policy",
        json={"ttls_days": {"prediction_audit": 0}},
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_bad2.status_code == 400, r_bad2.text

    # Acme sets a 7-day retention on prediction_audit.
    r_set = client.put(
        "/v1/workspace/retention-policy",
        json={"ttls_days": {"prediction_audit": 7}},
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_set.status_code == 200, r_set.text
    assert r_set.json()["ttls_days"] == {"prediction_audit": 7}
    assert r_set.json()["updated_by"] == "alice"

    # Globex sets a much longer retention so we can prove isolation.
    r_set_g = client.put(
        "/v1/workspace/retention-policy",
        json={"ttls_days": {"prediction_audit": 365}},
        headers={"Authorization": f"Bearer {globex_admin}"},
    )
    assert r_set_g.status_code == 200, r_set_g.text

    # Seed audit rows: a mix of fresh and old for both tenants.
    _seed_audit("acme", ages_days=[0, 1, 8, 30])     # 2 old (>=8d)
    _seed_audit("globex", ages_days=[0, 1, 8, 30])   # all young vs 365d cap
    assert _count_audit("acme") == 4
    assert _count_audit("globex") == 4

    # Dry-run from acme: counts old rows but deletes nothing.
    r_dry = client.post(
        "/v1/workspace/retention-policy/sweep",
        json={"dry_run": True},
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_dry.status_code == 200, r_dry.text
    body_dry = r_dry.json()
    assert body_dry["dry_run"] is True
    assert body_dry["tenant_id"] == "acme"
    pa_row = next(r for r in body_dry["results"] if r["table"] == "prediction_audit")
    assert pa_row["candidates"] == 2
    assert pa_row["deleted"] == 0
    assert _count_audit("acme") == 4
    assert _count_audit("globex") == 4

    # Real sweep from acme.
    r_run = client.post(
        "/v1/workspace/retention-policy/sweep",
        json={"dry_run": False},
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_run.status_code == 200, r_run.text
    pa_row = next(r for r in r_run.json()["results"] if r["table"] == "prediction_audit")
    assert pa_row["deleted"] == 2

    # Acme lost two rows. Globex must be untouched.
    assert _count_audit("acme") == 2
    assert _count_audit("globex") == 4, "cross-tenant retention leak"

    # Even if globex admin runs their own sweep, the 365d policy keeps
    # everything; acme rows are still untouched by globex's call.
    r_run_g = client.post(
        "/v1/workspace/retention-policy/sweep",
        json={"dry_run": False},
        headers={"Authorization": f"Bearer {globex_admin}"},
    )
    assert r_run_g.status_code == 200, r_run_g.text
    assert _count_audit("acme") == 2
    assert _count_audit("globex") == 4

    # Admin audit log should record both set + sweep actions for acme.
    r_audit = client.get(
        "/v1/admin/audit/admin?action=workspace.retention_policy.set",
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_audit.status_code == 200, r_audit.text
    actions = [row["action"] for row in r_audit.json()]
    assert "workspace.retention_policy.set" in actions

    r_audit_sweep = client.get(
        "/v1/admin/audit/admin?action=workspace.retention_policy.sweep",
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_audit_sweep.status_code == 200
    sweep_rows = r_audit_sweep.json()
    assert any(r["action"] == "workspace.retention_policy.sweep" for r in sweep_rows)

    # DELETE clears the policy; subsequent sweep is a no-op.
    r_del = client.delete(
        "/v1/workspace/retention-policy",
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_del.status_code == 200, r_del.text
    assert r_del.json()["ttls_days"] == {}

    r_run2 = client.post(
        "/v1/workspace/retention-policy/sweep",
        json={"dry_run": False},
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_run2.status_code == 200
    assert r_run2.json()["results"] == []
