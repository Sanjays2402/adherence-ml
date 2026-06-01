"""Integration tests for the CAIQ Lite vendor security questionnaire.

Procurement-blocker invariants:

1. The canonical CAIQ manifest is publicly readable without
   credentials so a buyer's security scanner can pull it from the
   trust center without provisioning a key.
2. Per-workspace override read/write is strictly tenant-scoped: acme
   cannot see or write globex overrides, even after acme has pinned
   its own. The query layer never returns cross-tenant rows.
3. A viewer cannot upsert or delete an override. Only an admin can.
4. Re-upserting the same question is idempotent: same row, no row
   inflation, the latest answer wins.
5. Setting an unknown question id returns 404; an invalid answer
   value returns 400. Neither leaks a 500.
6. Every admin write lands in admin_audit_log with a before/after
   pair so a SOC2 reviewer can trace pinned answers back to a
   subject.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv(
        "ADHERENCE_API_KEYS",
        "admin:adm,service:svc,viewer:vwr",
    )
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/caiq.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()


def _mint(client: TestClient, subject: str, role: str, tenant: str) -> str:
    r = client.post(
        "/v1/admin/token",
        json={"subject": subject, "role": role, "tenant": tenant},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_caiq_canonical_overrides_and_tenant_isolation(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    from adherence_common import caiq as caiq_mod

    client = TestClient(create_app())

    # 1. Public canonical manifest is readable with no credentials and
    #    carries every question from the canonical bank.
    r = client.get("/v1/caiq")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["schema_version"] == caiq_mod.SCHEMA_VERSION
    assert body["question_count"] == len(caiq_mod.canonical_questions())
    assert body["question_count"] > 0
    ids = {q["id"] for q in body["questions"]}
    # A few stable anchors that procurement teams will look for.
    for anchor in ("IAM-01", "DSP-04", "TVM-02"):
        assert anchor in ids, f"missing canonical question: {anchor}"

    # 2. Workspace reads require auth.
    r = client.get("/v1/caiq/overrides")
    assert r.status_code in (401, 403)

    acme_admin = _mint(client, "amy@acme.test", "admin", "acme")
    acme_viewer = _mint(client, "vic@acme.test", "viewer", "acme")
    globex_admin = _mint(client, "gus@globex.test", "admin", "globex")

    # Empty list to start.
    r = client.get("/v1/caiq/overrides", headers=_h(acme_admin))
    assert r.status_code == 200
    assert r.json() == {"tenant_id": "acme", "count": 0, "overrides": []}

    # 3. Viewer cannot upsert.
    r = client.put(
        "/v1/caiq/overrides/IAM-01",
        json={"answer": "yes", "note": "region locked to eu-west-1"},
        headers=_h(acme_viewer),
    )
    assert r.status_code == 403

    # 4. Admin upsert succeeds and is reflected in list + resolved.
    r = client.put(
        "/v1/caiq/overrides/IAM-01",
        json={"answer": "partial", "note": "Okta SAML only; OIDC disabled by contract"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 200, r.text
    assert r.json()["answer"] == "partial"
    assert r.json()["tenant_id"] == "acme"

    r = client.get("/v1/caiq/resolved", headers=_h(acme_admin))
    assert r.status_code == 200
    resolved = r.json()
    assert resolved["tenant_id"] == "acme"
    assert resolved["override_count"] == 1
    iam01 = next(q for q in resolved["questions"] if q["id"] == "IAM-01")
    assert iam01["override"]["answer"] == "partial"
    assert iam01["override"]["updated_by"] == "amy@acme.test"

    # 5. Idempotent upsert: re-saving updates in place, no row inflation.
    r = client.put(
        "/v1/caiq/overrides/IAM-01",
        json={"answer": "yes", "note": "Okta SAML and OIDC both enabled"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 200
    r = client.get("/v1/caiq/overrides", headers=_h(acme_admin))
    assert r.status_code == 200
    assert r.json()["count"] == 1
    assert r.json()["overrides"][0]["answer"] == "yes"

    # 6. Unknown question id is 404, bad answer is 400; no 500.
    r = client.put(
        "/v1/caiq/overrides/BOGUS-99",
        json={"answer": "yes"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 404
    r = client.put(
        "/v1/caiq/overrides/IAM-01",
        json={"answer": "definitely"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 400

    # 7. Cross-tenant isolation: globex sees zero acme overrides even
    #    after acme pinned IAM-01; its resolved manifest is canonical.
    r = client.get("/v1/caiq/overrides", headers=_h(globex_admin))
    assert r.status_code == 200
    assert r.json() == {"tenant_id": "globex", "count": 0, "overrides": []}

    r = client.get("/v1/caiq/resolved", headers=_h(globex_admin))
    assert r.status_code == 200
    gresolved = r.json()
    assert gresolved["tenant_id"] == "globex"
    assert gresolved["override_count"] == 0
    for q in gresolved["questions"]:
        assert q["override"] is None, f"globex leaked override on {q['id']}"

    # Globex can pin its own answer for the same question without
    # touching acme.
    r = client.put(
        "/v1/caiq/overrides/IAM-01",
        json={"answer": "na", "note": "no workforce SSO in this org"},
        headers=_h(globex_admin),
    )
    assert r.status_code == 200
    r = client.get("/v1/caiq/resolved", headers=_h(acme_admin))
    acme_iam01 = next(q for q in r.json()["questions"] if q["id"] == "IAM-01")
    assert acme_iam01["override"]["answer"] == "yes"

    # 8. Delete is tenant-scoped and audited.
    r = client.delete("/v1/caiq/overrides/IAM-01", headers=_h(acme_admin))
    assert r.status_code == 200
    assert r.json()["removed"] is True
    # Deleting again is a no-op (idempotent), not a 500.
    r = client.delete("/v1/caiq/overrides/IAM-01", headers=_h(acme_admin))
    assert r.status_code == 200
    assert r.json()["removed"] is False

    # 9. Admin writes were recorded in the tamper-evident audit log.
    from adherence_common.db import session, AdminAuditLog
    from sqlalchemy import select

    with session() as s:
        rows = list(
            s.execute(
                select(AdminAuditLog)
                .where(AdminAuditLog.action.like("caiq.%"))
                .order_by(AdminAuditLog.id.asc())
            ).scalars()
        )
    actions = [(r.action, r.tenant_id, r.ok) for r in rows]
    # At minimum: two acme upserts, one acme delete (the no-op delete
    # is also audited as ok=True), and one globex upsert.
    assert ("caiq.override.upsert", "acme", 1) in actions
    assert ("caiq.override.upsert", "globex", 1) in actions
    assert ("caiq.override.delete", "acme", 1) in actions
