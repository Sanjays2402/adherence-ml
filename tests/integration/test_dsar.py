"""Cross-tenant isolation + statutory-window tests for /v1/admin/dsar.

Procurement-blocker invariants:

1. A DSAR opened in workspace ``acme`` is invisible to ``globex``
   admins. List, get, event, and close calls scoped to a foreign id
   all return 404 (or an empty list). There is no way to enumerate
   or mutate the other tenant's requests.
2. The intake endpoint never persists the raw subject e-mail unless
   the operator opts in via ``store_raw_contact``. Closing the
   request purges the raw address in either case.
3. ``response_deadline_at`` is exactly 30 days after ``received_at``
   (GDPR Art. 12(3)).
4. Per-tenant email hashing means the same address registered against
   two different workspaces produces two different fingerprints, so
   the operator-wide audit log cannot be used as a cross-tenant join
   key on the subject identity.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "service:svc")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/dsar.db")
    monkeypatch.setenv(
        "ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns"
    )
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


def _mint(name: str, role: str, tenant: str) -> str:
    from adherence_common.api_keys import create_key
    plain, _ = create_key(name=name, role=role, tenant_id=tenant)
    return plain


def _client(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    return TestClient(create_app())


def test_compute_deadline_and_hash_unit():
    from adherence_common import dsar
    t = datetime(2026, 5, 1, 12, 0, 0)
    assert dsar.compute_deadline(t) == t + timedelta(days=30)
    # Per-tenant salt: same email hashes differently across tenants.
    a = dsar.hash_email("acme", "alice@example.com")
    b = dsar.hash_email("globex", "alice@example.com")
    assert a != b
    # Case-insensitive and whitespace-tolerant.
    assert dsar.hash_email("acme", "ALICE@example.com  ") == a
    # Redaction keeps the domain and the first character.
    assert dsar.redact_email("alice@example.com") == "a***@example.com"


def test_cross_tenant_isolation_and_intake(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    acme = _mint("acme-admin", "admin", "acme")
    globex = _mint("globex-admin", "admin", "globex")

    r = c.post(
        "/v1/admin/dsar",
        headers={"x-api-key": acme},
        json={
            "request_type": "access",
            "subject_name": "Alice Anderson",
            "subject_email": "alice@patient.example",
            "description": (
                "Patient requests an export of all medication "
                "adherence predictions held about her account."
            ),
            "received_via": "email",
        },
    )
    assert r.status_code == 201, r.text
    acme_req = r.json()
    assert acme_req["status"] == "received"
    assert acme_req["request_type"] == "access"
    assert acme_req["subject_email_redacted"] == "a***@patient.example"
    # Raw email is NOT echoed back and NOT stored by default.
    assert acme_req["has_raw_contact"] is False
    # Deadline = 30 days after intake.
    recv = datetime.fromisoformat(acme_req["received_at"])
    dead = datetime.fromisoformat(acme_req["response_deadline_at"])
    assert (dead - recv) == timedelta(days=30)
    acme_id = acme_req["id"]

    # globex opens an erasure request for the same e-mail address; the
    # tenant-salted hash must differ from acme's, so the register cannot
    # be joined across tenants on the subject identity.
    r = c.post(
        "/v1/admin/dsar",
        headers={"x-api-key": globex},
        json={
            "request_type": "erasure",
            "subject_name": "Alice Anderson",
            "subject_email": "alice@patient.example",
            "description": (
                "Subject asks for hard deletion of all data we hold."
            ),
        },
    )
    assert r.status_code == 201, r.text
    globex_req = r.json()
    assert globex_req["subject_email_hash"] != acme_req["subject_email_hash"]

    # Cross-tenant list: each side sees only its own.
    r = c.get("/v1/admin/dsar", headers={"x-api-key": acme})
    assert r.status_code == 200
    body = r.json()
    assert body["tenant_id"] == "acme"
    assert [e["id"] for e in body["entries"]] == [acme_id]
    assert body["summary"]["open"] == 1

    r = c.get("/v1/admin/dsar", headers={"x-api-key": globex})
    assert r.status_code == 200
    body = r.json()
    assert body["tenant_id"] == "globex"
    assert [e["request_type"] for e in body["entries"]] == ["erasure"]

    # Cross-tenant get: globex cannot fetch acme's request by id.
    r = c.get(f"/v1/admin/dsar/{acme_id}", headers={"x-api-key": globex})
    assert r.status_code == 404

    # Cross-tenant mutation: globex cannot append events or close
    # acme's request.
    r = c.post(
        f"/v1/admin/dsar/{acme_id}/events",
        headers={"x-api-key": globex},
        json={"kind": "ack_sent", "note": "tampering attempt"},
    )
    assert r.status_code == 404
    r = c.post(
        f"/v1/admin/dsar/{acme_id}/close",
        headers={"x-api-key": globex},
        json={"status": "rejected", "resolution_note": "nope"},
    )
    assert r.status_code == 404

    # Acme acknowledges its own request, which flips status to
    # in_progress and stamps acknowledged_at.
    r = c.post(
        f"/v1/admin/dsar/{acme_id}/events",
        headers={"x-api-key": acme},
        json={"kind": "ack_sent", "note": "sent intake confirmation"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "in_progress"
    assert body["acknowledged_at"] is not None

    # Extension event with "+60d" tag pushes the deadline forward.
    r = c.post(
        f"/v1/admin/dsar/{acme_id}/events",
        headers={"x-api-key": acme},
        json={
            "kind": "extension",
            "note": "+60d: complex request, invoked Art. 12(3) extension",
        },
    )
    assert r.status_code == 201, r.text
    new_deadline = datetime.fromisoformat(
        r.json()["response_deadline_at"]
    )
    assert (new_deadline - dead) == timedelta(days=60)

    # Fulfil and close.
    r = c.post(
        f"/v1/admin/dsar/{acme_id}/close",
        headers={"x-api-key": acme},
        json={
            "status": "fulfilled",
            "resolution_note": "delivered ZIP via secure portal",
        },
    )
    assert r.status_code == 200, r.text
    final = r.json()
    assert final["status"] == "fulfilled"
    assert final["closed_at"] is not None
    assert final["has_raw_contact"] is False

    # After fulfilment the open counter for acme drops to zero.
    r = c.get("/v1/admin/dsar", headers={"x-api-key": acme})
    assert r.json()["summary"]["open"] == 0


def test_store_raw_contact_is_purged_on_close(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    key = _mint("a", "admin", "tenantC")
    r = c.post(
        "/v1/admin/dsar",
        headers={"x-api-key": key},
        json={
            "request_type": "rectification",
            "subject_name": "Bob Builder",
            "subject_email": "bob@example.org",
            "description": "Please correct the dosage notes on my record.",
            "store_raw_contact": True,
        },
    )
    assert r.status_code == 201, r.text
    rid = r.json()["id"]

    # While open, raw contact is retained (has_raw_contact True).
    body = c.get(
        f"/v1/admin/dsar/{rid}", headers={"x-api-key": key}
    ).json()
    assert body["has_raw_contact"] is True

    # Closing purges the raw address regardless of resolution.
    r = c.post(
        f"/v1/admin/dsar/{rid}/close",
        headers={"x-api-key": key},
        json={"status": "withdrawn", "resolution_note": "subject withdrew"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["has_raw_contact"] is False


def test_dry_run_does_not_persist(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    key = _mint("a", "admin", "tenantD")
    r = c.post(
        "/v1/admin/dsar?dry_run=true",
        headers={"x-api-key": key},
        json={
            "request_type": "access",
            "subject_name": "Preview Only",
            "subject_email": "preview@example.com",
            "description": "this should not persist anywhere",
        },
    )
    assert r.status_code == 201, r.text
    assert r.json().get("dry_run") is True
    r = c.get("/v1/admin/dsar", headers={"x-api-key": key})
    assert r.json()["entries"] == []
