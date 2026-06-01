"""Integration tests for the sub-processor registry, change log, and
per-workspace acknowledgments.

Procurement-blocker invariants:

1. The registry list and change log are publicly readable without
   credentials so a prospective customer can audit the data flow from
   their trust-center scanner.
2. Registering, updating, and removing a sub-processor each emits one
   append-only change row with an effective date, and each writes an
   admin audit row.
3. Acknowledgment is workspace-scoped: ``acme`` cannot see or write
   ``globex`` acknowledgments. Acknowledging in ``acme`` does not
   shrink the outstanding set in ``globex``.
4. A viewer cannot acknowledge a change. Only an admin can.
5. Re-acknowledging the same change by the same subject is idempotent:
   same row id, no duplicate audit storm.
6. Acknowledging an unknown change id returns 404, not 500.
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
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/sp.db")
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


def test_subprocessor_registry_and_workspace_acks(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app

    client = TestClient(create_app())

    # Public read works without credentials and is initially empty.
    r = client.get("/v1/subprocessors")
    assert r.status_code == 200, r.text
    assert r.json() == {"count": 0, "subprocessors": []}

    r = client.get("/v1/subprocessors/changes")
    assert r.status_code == 200, r.text
    assert r.json() == {"count": 0, "changes": []}

    # Operator (admin in deployment-default tenant) registers two
    # sub-processors; each emits one announced change.
    operator = _mint(client, "operator@vendor.test", "admin", "default")
    r = client.post(
        "/v1/subprocessors",
        json={
            "name": "AWS RDS",
            "purpose": "Managed Postgres",
            "data_categories": "All customer data",
            "region": "us-east-1",
            "url": "https://aws.amazon.com",
        },
        headers=_h(operator),
    )
    assert r.status_code == 201, r.text
    aws_change_id = r.json()["change"]["id"]
    assert r.json()["subprocessor"]["status"] == "active"
    assert r.json()["change"]["change_type"] == "added"

    r = client.post(
        "/v1/subprocessors",
        json={
            "name": "Resend",
            "purpose": "Transactional email",
            "data_categories": "Recipient email, message body",
            "region": "us-east-1",
        },
        headers=_h(operator),
    )
    assert r.status_code == 201, r.text
    resend_change_id = r.json()["change"]["id"]

    # Duplicate register conflicts.
    r = client.post(
        "/v1/subprocessors",
        json={
            "name": "AWS RDS", "purpose": "x",
            "data_categories": "y", "region": "z",
        },
        headers=_h(operator),
    )
    assert r.status_code == 409

    # Public list now shows both sub-processors and both change rows.
    r = client.get("/v1/subprocessors")
    assert r.status_code == 200
    names = {row["name"] for row in r.json()["subprocessors"]}
    assert names == {"AWS RDS", "Resend"}

    r = client.get("/v1/subprocessors/changes")
    assert r.status_code == 200
    assert r.json()["count"] == 2

    # acme and globex each have two outstanding acknowledgments.
    acme_admin = _mint(client, "owner@acme.test", "admin", "acme")
    acme_viewer = _mint(client, "viewer@acme.test", "viewer", "acme")
    globex_admin = _mint(client, "owner@globex.test", "admin", "globex")

    r = client.get("/v1/subprocessors/outstanding", headers=_h(acme_admin))
    assert r.status_code == 200
    assert r.json()["count"] == 2
    assert r.json()["tenant_id"] == "acme"

    r = client.get("/v1/subprocessors/outstanding", headers=_h(globex_admin))
    assert r.status_code == 200
    assert r.json()["count"] == 2
    assert r.json()["tenant_id"] == "globex"

    # Viewer cannot acknowledge.
    r = client.post(
        "/v1/subprocessors/acknowledge",
        json={"change_id": aws_change_id},
        headers=_h(acme_viewer),
    )
    assert r.status_code == 403, r.text

    # Admin acknowledges in acme. Idempotent on repeat.
    r = client.post(
        "/v1/subprocessors/acknowledge",
        json={"change_id": aws_change_id},
        headers=_h(acme_admin),
    )
    assert r.status_code == 201, r.text
    first_ack_id = r.json()["id"]
    assert r.json()["tenant_id"] == "acme"

    r2 = client.post(
        "/v1/subprocessors/acknowledge",
        json={"change_id": aws_change_id},
        headers=_h(acme_admin),
    )
    assert r2.status_code == 201
    assert r2.json()["id"] == first_ack_id

    # Outstanding shrinks for acme only, not for globex.
    r = client.get("/v1/subprocessors/outstanding", headers=_h(acme_admin))
    assert r.json()["count"] == 1
    remaining = [c["id"] for c in r.json()["changes"]]
    assert aws_change_id not in remaining
    assert resend_change_id in remaining

    r = client.get("/v1/subprocessors/outstanding", headers=_h(globex_admin))
    assert r.json()["count"] == 2

    # Cross-tenant isolation: acme's ack log never exposes globex,
    # and vice versa.
    r = client.get("/v1/subprocessors/acknowledgments", headers=_h(acme_admin))
    assert r.status_code == 200
    body = r.json()
    assert body["tenant_id"] == "acme"
    assert body["count"] == 1
    assert {a["tenant_id"] for a in body["acknowledgments"]} == {"acme"}

    r = client.get("/v1/subprocessors/acknowledgments", headers=_h(globex_admin))
    assert r.status_code == 200
    assert r.json()["count"] == 0

    # Unknown change id returns 404.
    r = client.post(
        "/v1/subprocessors/acknowledge",
        json={"change_id": 999_999},
        headers=_h(acme_admin),
    )
    assert r.status_code == 404

    # Update emits a new change row that everyone owes again.
    r = client.patch(
        "/v1/subprocessors/AWS RDS",
        json={"region": "eu-west-1", "summary": "Moved to EU region"},
        headers=_h(operator),
    )
    assert r.status_code == 200, r.text
    update_change_id = r.json()["change"]["id"]
    assert r.json()["change"]["change_type"] == "updated"
    assert r.json()["subprocessor"]["region"] == "eu-west-1"

    r = client.get("/v1/subprocessors/outstanding", headers=_h(acme_admin))
    out_ids = [c["id"] for c in r.json()["changes"]]
    assert update_change_id in out_ids
    assert aws_change_id not in out_ids  # still acked

    # Remove emits a removed change row and flips status.
    r = client.delete(
        "/v1/subprocessors/Resend?summary=Replaced+with+in-house+mailer",
        headers=_h(operator),
    )
    assert r.status_code == 200, r.text
    assert r.json()["subprocessor"]["status"] == "removed"
    assert r.json()["change"]["change_type"] == "removed"

    # Default list hides removed; include_removed surfaces it.
    r = client.get("/v1/subprocessors")
    names = {row["name"] for row in r.json()["subprocessors"]}
    assert names == {"AWS RDS"}
    r = client.get("/v1/subprocessors?include_removed=true")
    names = {row["name"] for row in r.json()["subprocessors"]}
    assert names == {"AWS RDS", "Resend"}

    # Admin audit recorded every operator + workspace action.
    r = client.get(
        "/v1/admin/audit/admin?tenant=*&limit=200",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    actions = [row["action"] for row in r.json()]
    assert "subprocessor.register" in actions
    assert "subprocessor.update" in actions
    assert "subprocessor.remove" in actions
    assert "subprocessor.acknowledge" in actions
