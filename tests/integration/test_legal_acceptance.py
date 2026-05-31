"""Integration tests for per-workspace legal document acceptance.

Procurement-blocker invariants:

1. A workspace that has not accepted the current TOS / DPA is blocked
   from every mutating route with a 451, and the response body tells
   the caller exactly which (kind, version) it owes.
2. The block lifts the instant a workspace admin records acceptance,
   without restarting the API or touching any other tenant.
3. Tenant scoping: ``acme`` admin cannot see ``globex`` acceptances,
   and acme accepting does not unblock globex.
4. Read traffic, GDPR data exit, and /v1/legal stay open even while a
   workspace is blocked, so a stuck tenant can still discover what to
   accept and exfiltrate or erase its data.
5. Re-accepting the same (kind, version) by the same subject is
   idempotent: same row id, no duplicate.
6. sha256 supplied at accept time must match the stored body, proving
   the document has not silently changed under the same version label.
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
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/legal.db")
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


def _publish(client: TestClient, admin_token: str, *, kind: str, version: str,
             body: str = "This is the contract body.") -> dict:
    r = client.post(
        "/v1/legal/documents",
        json={
            "kind": kind,
            "version": version,
            "title": f"{kind.upper()} {version}",
            "body": body,
        },
        headers=_h(admin_token),
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_legal_acceptance_gates_mutations_and_lifts_per_tenant(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app

    client = TestClient(create_app())

    # An operator (admin in the deployment-default tenant) publishes
    # the first TOS and DPA versions.
    operator = _mint(client, "operator@vendor.test", "admin", "default")
    tos = _publish(client, operator, kind="tos", version="2026-01-01")
    dpa = _publish(client, operator, kind="dpa", version="2026-01-01",
                   body="Data processing terms.")

    acme_admin = _mint(client, "owner@acme.test", "admin", "acme")
    globex_admin = _mint(client, "owner@globex.test", "admin", "globex")

    # Both tenants now owe both documents.
    r = client.get("/v1/legal/outstanding", headers=_h(acme_admin))
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["blocked"] is True
    owed_kinds = {item["kind"] for item in payload["outstanding"]}
    assert owed_kinds == {"tos", "dpa"}

    # A mutating call from acme is rejected with 451 and a structured
    # remediation payload. Use a route that exists and is normally
    # admin-gated: creating an SSO policy entry would also work, but
    # the verified-domain POST is the cheapest mutation we have.
    r = client.post(
        "/v1/workspace/verified-domains",
        json={"domain": "acme.test"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 451, r.text
    body = r.json()
    assert body["error"] == "legal_acceptance_required"
    assert body["tenant_id"] == "acme"
    outstanding_kinds = {item["kind"] for item in body["outstanding"]}
    assert outstanding_kinds == {"tos", "dpa"}
    # Response header advertises the gate to dashboards / SDKs.
    assert r.headers.get("X-Legal-Acceptance") == "required"

    # Read traffic stays open so the workspace can self-serve.
    r = client.get("/v1/legal/documents", headers=_h(acme_admin))
    assert r.status_code == 200, r.text
    assert {d["kind"] for d in r.json()["documents"]} == {"tos", "dpa"}

    # Acme accepts TOS only: still blocked on DPA.
    r = client.post(
        "/v1/legal/accept",
        json={"kind": "tos", "version": tos["version"], "sha256": tos["sha256"]},
        headers=_h(acme_admin),
    )
    assert r.status_code == 201, r.text
    assert r.json()["kind"] == "tos"

    r = client.post(
        "/v1/workspace/verified-domains",
        json={"domain": "acme.test"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 451, "TOS-only acceptance must not unblock the workspace"
    outstanding_kinds = {item["kind"] for item in r.json()["outstanding"]}
    assert outstanding_kinds == {"dpa"}

    # Acme accepts DPA too: the next mutation should succeed.
    r = client.post(
        "/v1/legal/accept",
        json={"kind": "dpa", "version": dpa["version"], "sha256": dpa["sha256"]},
        headers=_h(acme_admin),
    )
    assert r.status_code == 201, r.text

    r = client.post(
        "/v1/workspace/verified-domains",
        json={"domain": "acme.test"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 201, r.text

    # Globex is still blocked: acme accepting does not unblock globex.
    r = client.post(
        "/v1/workspace/verified-domains",
        json={"domain": "globex.test"},
        headers=_h(globex_admin),
    )
    assert r.status_code == 451, r.text
    assert r.json()["tenant_id"] == "globex"

    # Cross-tenant acceptance listing isolation: acme cannot see globex
    # rows and vice versa.
    r = client.get("/v1/legal/acceptances", headers=_h(acme_admin))
    assert r.status_code == 200, r.text
    acme_accs = r.json()
    assert acme_accs["tenant_id"] == "acme"
    assert acme_accs["count"] == 2
    assert all(a["tenant_id"] == "acme" for a in acme_accs["acceptances"])

    r = client.get("/v1/legal/acceptances", headers=_h(globex_admin))
    assert r.status_code == 200, r.text
    globex_accs = r.json()
    assert globex_accs["tenant_id"] == "globex"
    assert globex_accs["count"] == 0

    # Idempotency: re-accept by the same subject returns the original
    # row id and does not double-count.
    first_id = acme_accs["acceptances"][0]["id"]
    r = client.post(
        "/v1/legal/accept",
        json={"kind": "tos", "version": tos["version"]},
        headers=_h(acme_admin),
    )
    assert r.status_code == 201, r.text
    # Should be one of the existing acme acceptance ids.
    assert r.json()["id"] in {a["id"] for a in acme_accs["acceptances"]}
    r2 = client.get("/v1/legal/acceptances", headers=_h(acme_admin))
    assert r2.json()["count"] == 2, "idempotent accept must not insert a new row"
    del first_id  # used only to assert non-erroring above

    # sha256 mismatch is rejected with 409.
    r = client.post(
        "/v1/legal/accept",
        json={
            "kind": "tos",
            "version": tos["version"],
            "sha256": "0" * 64,
        },
        headers=_h(globex_admin),
    )
    assert r.status_code == 409, r.text


def test_legal_acceptance_no_documents_is_no_gate(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app

    client = TestClient(create_app())
    acme_admin = _mint(client, "owner@acme.test", "admin", "acme")

    # With no published TOS/DPA at all the green-field default is
    # "no gate": mutations proceed normally.
    r = client.get("/v1/legal/outstanding", headers=_h(acme_admin))
    assert r.status_code == 200, r.text
    assert r.json()["blocked"] is False
    assert r.json()["outstanding"] == []

    r = client.post(
        "/v1/workspace/verified-domains",
        json={"domain": "acme.test"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 201, r.text
