"""Cross-tenant isolation + 72h deadline tests for /v1/admin/incidents.

Procurement-blocker invariants:

1. An incident opened in workspace ``acme`` is invisible to ``globex``
   admins. List, get, and milestone calls scoped to a foreign id all
   return empty or 404. There is no way to enumerate or mutate the
   other tenant's incidents.
2. Severity ``high`` or ``critical``, or the ``personal_data_breach``
   flag, makes the API stamp a ``notification_deadline_at`` that is
   exactly 72 hours after ``discovered_at`` (GDPR Art. 33(1)).
3. Severity ``low`` / ``medium`` without the breach flag has no
   deadline (an operational sev-2 incident isn't a regulator-reportable
   personal data breach).
4. Append-only timeline: a tenant cannot post updates to an incident
   they don't own.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "service:svc")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/inc.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
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


def test_compute_deadline_unit():
    from adherence_common import incidents as inc
    t = datetime(2026, 1, 1, 12, 0, 0)
    assert inc.compute_deadline(
        discovered_at=t, severity="low", personal_data_breach=False
    ) is None
    assert inc.compute_deadline(
        discovered_at=t, severity="medium", personal_data_breach=False
    ) is None
    assert inc.compute_deadline(
        discovered_at=t, severity="high", personal_data_breach=False
    ) == t + timedelta(hours=72)
    assert inc.compute_deadline(
        discovered_at=t, severity="critical", personal_data_breach=False
    ) == t + timedelta(hours=72)
    # personal data breach forces the deadline even at low severity.
    assert inc.compute_deadline(
        discovered_at=t, severity="low", personal_data_breach=True
    ) == t + timedelta(hours=72)


def test_cross_tenant_isolation_and_deadline_stamping(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    acme = _mint("acme-admin", "admin", "acme")
    globex = _mint("globex-admin", "admin", "globex")

    # acme opens a high-severity incident: 72h deadline must be set.
    r = c.post(
        "/v1/admin/incidents",
        headers={"x-api-key": acme},
        json={
            "title": "unauthorized access to acme staging predictions",
            "summary": "Anomalous /v1/predict traffic from unknown IP.",
            "severity": "high",
            "personal_data_breach": False,
        },
    )
    assert r.status_code == 201, r.text
    acme_inc = r.json()
    assert acme_inc["status"] == "open"
    assert acme_inc["notification_deadline_at"] is not None
    disc = datetime.fromisoformat(acme_inc["discovered_at"])
    dead = datetime.fromisoformat(acme_inc["notification_deadline_at"])
    assert (dead - disc) == timedelta(hours=72)
    acme_id = acme_inc["id"]

    # globex opens a low-severity incident: no deadline.
    r = c.post(
        "/v1/admin/incidents",
        headers={"x-api-key": globex},
        json={
            "title": "globex dashboard slow render",
            "summary": "Cosmetic perf issue, no data exposure suspected.",
            "severity": "low",
            "personal_data_breach": False,
        },
    )
    assert r.status_code == 201, r.text
    globex_inc = r.json()
    assert globex_inc["notification_deadline_at"] is None

    # Cross-tenant list: acme sees only its own.
    r = c.get("/v1/admin/incidents", headers={"x-api-key": acme})
    assert r.status_code == 200
    body = r.json()
    assert body["tenant_id"] == "acme"
    assert [e["id"] for e in body["entries"]] == [acme_id]
    assert body["summary"]["open"] == 1

    r = c.get("/v1/admin/incidents", headers={"x-api-key": globex})
    assert r.status_code == 200
    body = r.json()
    assert body["tenant_id"] == "globex"
    assert [e["title"] for e in body["entries"]] == [
        "globex dashboard slow render"
    ]

    # Cross-tenant get: globex cannot fetch acme's incident by id.
    r = c.get(f"/v1/admin/incidents/{acme_id}", headers={"x-api-key": globex})
    assert r.status_code == 404

    # Cross-tenant mutation: globex cannot append a timeline update or
    # stamp a milestone on acme's incident.
    r = c.post(
        f"/v1/admin/incidents/{acme_id}/updates",
        headers={"x-api-key": globex},
        json={"note": "tampering attempt"},
    )
    assert r.status_code == 404
    r = c.post(
        f"/v1/admin/incidents/{acme_id}/milestone",
        headers={"x-api-key": globex},
        json={"milestone": "resolved"},
    )
    assert r.status_code == 404

    # Acme can append + resolve its own; resolved flips status.
    r = c.post(
        f"/v1/admin/incidents/{acme_id}/updates",
        headers={"x-api-key": acme},
        json={"note": "isolated offending IP at edge."},
    )
    assert r.status_code == 201, r.text
    r = c.post(
        f"/v1/admin/incidents/{acme_id}/milestone",
        headers={"x-api-key": acme},
        json={"milestone": "resolved", "note": "no PII accessed."},
    )
    assert r.status_code == 200, r.text
    final = r.json()
    assert final["status"] == "resolved"
    assert final["resolved_at"] is not None
    assert any(u["note"].startswith("isolated") for u in final["updates"])

    # After resolution, the open counter for acme is 0.
    r = c.get("/v1/admin/incidents", headers={"x-api-key": acme})
    assert r.json()["summary"]["open"] == 0


def test_personal_data_breach_low_severity_still_starts_clock(
    tmp_path, monkeypatch
):
    c = _client(tmp_path, monkeypatch)
    key = _mint("a", "admin", "tenantA")
    r = c.post(
        "/v1/admin/incidents",
        headers={"x-api-key": key},
        json={
            "title": "lost laptop with cached predictions",
            "summary": "Field laptop unaccounted for after conference.",
            "severity": "low",
            "personal_data_breach": True,
            "affected_user_count": 42,
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["personal_data_breach"] is True
    assert body["notification_deadline_at"] is not None
    assert body["affected_user_count"] == 42


def test_dry_run_does_not_persist(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    key = _mint("a", "admin", "tenantB")
    r = c.post(
        "/v1/admin/incidents?dry_run=true",
        headers={"x-api-key": key},
        json={
            "title": "preview only",
            "summary": "this should not persist",
            "severity": "high",
        },
    )
    assert r.status_code == 201, r.text
    assert r.json().get("dry_run") is True
    # list is empty
    r = c.get("/v1/admin/incidents", headers={"x-api-key": key})
    assert r.json()["entries"] == []
