"""Cross-tenant isolation for webhook delivery rows + dead-letter queue.

Two admin keys in different tenants create their own webhook
subscription pointing at a localhost URL that always 500s. After
dispatch, each delivery row must carry the originating tenant_id,
each tenant's /deliveries listing must only show its own attempts,
and each tenant's /deliveries/dead-letter view must only show its
own exhausted failures.

A regression in the denormalised tenant_id (or in the listing route's
tenant filter) would cause one tenant to see the other's failed
delivery payloads. This test fails loudly if that ever happens.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "service:svc")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv(
        "ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/wh_tenant.db",
    )
    monkeypatch.setenv(
        "ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns",
    )
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    monkeypatch.setenv("ADHERENCE_OUTBOUND_ALLOW_PRIVATE", "true")
    monkeypatch.setenv("ADHERENCE_OUTBOUND_ALLOW_HTTP", "true")
    reload_settings()
    from adherence_common import audit as audit_mod
    from adherence_common import deliveries as dmod
    from adherence_common import outbound as omod
    audit_mod._INITIALIZED = False
    dmod._INITIALIZED = False
    omod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    monkeypatch.setattr(
        "adherence_common.outbound.RETRY_BACKOFF_S", (0.0, 0.0, 0.0),
    )


def _mint(name: str, tenant: str) -> str:
    from adherence_common.api_keys import create_key
    plain, _ = create_key(name=name, role="admin", tenant_id=tenant)
    return plain


def test_webhook_deliveries_isolated_per_tenant(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)

    from adherence_api.app import create_app
    from adherence_common import outbound as omod

    client = TestClient(create_app())

    acme_key = _mint("acme-admin", "acme")
    globex_key = _mint("globex-admin", "globex")

    # Each tenant registers its own subscription on the same event.
    for tenant_key, name, url in (
        (acme_key, "acme-hook", "https://acme.test/hook"),
        (globex_key, "globex-hook", "https://globex.test/hook"),
    ):
        r = client.put(
            "/v1/webhooks/outbound/subscriptions",
            json={
                "name": name,
                "url": url,
                "event_types": ["intervention.high_risk"],
                "active": True,
            },
            headers={"x-api-key": tenant_key},
        )
        assert r.status_code == 200, r.text

    # Force every HTTP attempt to fail so deliveries exhaust retries
    # and land in dead_letter. No real network IO occurs.
    def _always_500(url, body, headers, timeout, client=None):
        return 500, 1.0, "http_500"

    monkeypatch.setattr("adherence_common.outbound._post", _always_500)

    # Dispatch one event per tenant. dispatch() walks ALL active
    # subscriptions for the event regardless of tenant; both rows must
    # be written, each tagged with its own tenant_id.
    ids = omod.dispatch(
        "intervention.high_risk",
        {"user_id": "u1", "risk": 0.91},
    )
    assert len(ids) == 2, ids

    # Per-tenant DLQ counts: each tenant sees exactly one dead-letter.
    assert omod.dead_letter_count("acme") == 1
    assert omod.dead_letter_count("globex") == 1
    assert omod.dead_letter_count("nobody") == 0

    # Tenant-scoped helper never leaks rows across tenants.
    acme_rows = omod.recent_deliveries(limit=50, tenant_id="acme")
    globex_rows = omod.recent_deliveries(limit=50, tenant_id="globex")
    assert {r.tenant_id for r in acme_rows} == {"acme"}
    assert {r.tenant_id for r in globex_rows} == {"globex"}
    assert {r.id for r in acme_rows}.isdisjoint({r.id for r in globex_rows})

    # Route-level isolation: acme key must NOT see globex deliveries.
    r = client.get(
        "/v1/webhooks/outbound/deliveries",
        headers={"x-api-key": acme_key},
    )
    assert r.status_code == 200, r.text
    acme_listed = r.json()
    assert len(acme_listed) == 1
    assert acme_listed[0]["state"] == "dead_letter"

    r = client.get(
        "/v1/webhooks/outbound/deliveries",
        headers={"x-api-key": globex_key},
    )
    assert r.status_code == 200
    globex_listed = r.json()
    assert len(globex_listed) == 1
    assert globex_listed[0]["id"] != acme_listed[0]["id"]

    # New /deliveries/dead-letter endpoint mirrors the same isolation.
    r = client.get(
        "/v1/webhooks/outbound/deliveries/dead-letter",
        headers={"x-api-key": acme_key},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 1
    assert len(body["items"]) == 1
    assert body["items"][0]["id"] == acme_listed[0]["id"]
    assert body["items"][0]["state"] == "dead_letter"

    r = client.get(
        "/v1/webhooks/outbound/deliveries/dead-letter",
        headers={"x-api-key": globex_key},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 1
    assert body["items"][0]["id"] == globex_listed[0]["id"]

    # Cross-tenant replay attempt must 404, not replay another tenant's row.
    other_id = globex_listed[0]["id"]
    r = client.post(
        f"/v1/webhooks/outbound/deliveries/{other_id}/replay",
        headers={"x-api-key": acme_key},
    )
    assert r.status_code == 404, r.text
