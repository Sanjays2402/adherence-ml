"""Per-subscription delivery health summary.

Verifies the /v1/webhooks/outbound/subscriptions/{name}/health endpoint:

- counts success vs failed vs dead_letter within the window,
- computes a sensible success_rate (1.0 when no traffic, otherwise success / total),
- exposes p95 latency only over successful attempts,
- surfaces last_attempt_at and last_success_at,
- enforces tenant isolation: tenant A asking for tenant B's subscription
  name returns 404 (not zeros, not another tenant's numbers),
- excludes deliveries older than window_minutes.

A regression in any of these would either flag a healthy receiver red
or, worse, leak another workspace's delivery counts.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "service:svc")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv(
        "ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/wh_health.db",
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


def _mint(name: str, tenant: str) -> str:
    from adherence_common.api_keys import create_key
    plain, _ = create_key(name=name, role="admin", tenant_id=tenant)
    return plain


def _seed_delivery(
    *, subscription_id: int, tenant_id: str, state: str,
    status_code: int | None, latency_ms: float | None,
    error: str | None = None, age_minutes: float = 1.0,
) -> int:
    """Write a WebhookDelivery row directly with a back-dated created_at."""
    from adherence_common.db import WebhookDelivery, session
    created = datetime.utcnow() - timedelta(minutes=age_minutes)
    with session() as s:
        row = WebhookDelivery(
            subscription_id=subscription_id,
            tenant_id=tenant_id,
            event_type="intervention.high_risk",
            payload_json={"u": "u1"},
            attempt=1,
            status_code=status_code,
            latency_ms=latency_ms,
            error=error,
            state=state,
            created_at=created,
            updated_at=created,
        )
        s.add(row)
        s.commit()
        s.refresh(row)
        return int(row.id)


def test_subscription_health_summary_and_tenant_isolation(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)

    from adherence_api.app import create_app
    from adherence_common.db import WebhookSubscription, session

    client = TestClient(create_app())
    acme_key = _mint("acme-admin", "acme")
    globex_key = _mint("globex-admin", "globex")

    # Each tenant registers its own subscription.
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

    # Resolve subscription ids per tenant.
    with session() as s:
        acme_sub = s.execute(
            __import__("sqlalchemy").select(WebhookSubscription).where(
                WebhookSubscription.name == "acme-hook",
            )
        ).scalar_one()
        globex_sub = s.execute(
            __import__("sqlalchemy").select(WebhookSubscription).where(
                WebhookSubscription.name == "globex-hook",
            )
        ).scalar_one()
        acme_sub_id = acme_sub.id
        globex_sub_id = globex_sub.id

    # Seed acme: 3 successes (latencies 10, 20, 50ms), 1 failed, 1 dead_letter.
    for lat in (10.0, 20.0, 50.0):
        _seed_delivery(
            subscription_id=acme_sub_id, tenant_id="acme",
            state="success", status_code=200, latency_ms=lat,
        )
    _seed_delivery(
        subscription_id=acme_sub_id, tenant_id="acme",
        state="failed", status_code=502, latency_ms=300.0, error="bad_gateway",
    )
    _seed_delivery(
        subscription_id=acme_sub_id, tenant_id="acme",
        state="dead_letter", status_code=500, latency_ms=400.0,
        error="http_500",
    )
    # An ancient row that must be EXCLUDED by the default 24h window.
    _seed_delivery(
        subscription_id=acme_sub_id, tenant_id="acme",
        state="failed", status_code=500, latency_ms=999.0,
        age_minutes=60 * 24 * 3,  # 3 days old
    )
    # Seed globex with a single success so we can verify acme's numbers
    # are unaffected by another tenant's traffic.
    _seed_delivery(
        subscription_id=globex_sub_id, tenant_id="globex",
        state="success", status_code=200, latency_ms=5.0,
    )

    # acme health summary
    r = client.get(
        "/v1/webhooks/outbound/subscriptions/acme-hook/health",
        headers={"x-api-key": acme_key},
    )
    assert r.status_code == 200, r.text
    h = r.json()
    assert h["name"] == "acme-hook"
    assert h["subscription_id"] == acme_sub_id
    assert h["window_minutes"] == 1440
    assert h["total"] == 5  # ancient row excluded
    assert h["success"] == 3
    assert h["failed"] == 1
    assert h["dead_letter"] == 1
    assert h["queued"] == 0
    assert h["blocked"] == 0
    assert h["success_rate"] == round(3 / 5, 4)
    # p95 over successes-only: sorted [10, 20, 50] -> nearest-rank p95 = 50.
    assert h["p95_latency_ms"] == 50.0
    assert h["p50_latency_ms"] == 20.0
    assert h["last_attempt_at"] is not None
    assert h["last_success_at"] is not None
    assert h["active"] is True

    # Tenant isolation: globex key asking for acme-hook must 404, never see
    # acme's numbers, and never be told the resource exists elsewhere.
    r = client.get(
        "/v1/webhooks/outbound/subscriptions/acme-hook/health",
        headers={"x-api-key": globex_key},
    )
    assert r.status_code == 404, r.text

    # Globex's own subscription: 1 success, 0 failures, success_rate = 1.0.
    r = client.get(
        "/v1/webhooks/outbound/subscriptions/globex-hook/health",
        headers={"x-api-key": globex_key},
    )
    assert r.status_code == 200, r.text
    g = r.json()
    assert g["total"] == 1
    assert g["success"] == 1
    assert g["failed"] == 0
    assert g["success_rate"] == 1.0
    assert g["p95_latency_ms"] == 5.0

    # Quiet receiver (no traffic in a 1-minute window) reports success_rate=1.0,
    # not 0.0. A green light when nothing has happened is the right default
    # so we don't page on idle subscriptions.
    r = client.get(
        "/v1/webhooks/outbound/subscriptions/acme-hook/health?window_minutes=1",
        headers={"x-api-key": acme_key},
    )
    assert r.status_code == 200, r.text
    quiet = r.json()
    # All seeded rows are >= 1 minute old (age_minutes=1.0); none falls in
    # the last 60 seconds, so totals must be zero and success_rate = 1.0.
    assert quiet["total"] == 0
    assert quiet["success_rate"] == 1.0
    assert quiet["p95_latency_ms"] is None
    # But the all-time last_attempt_at / last_success_at still surface so
    # operators know the receiver has fired before.
    assert quiet["last_attempt_at"] is not None
    assert quiet["last_success_at"] is not None

    # Unknown subscription name: 404, not 200 with zeros (no existence oracle).
    r = client.get(
        "/v1/webhooks/outbound/subscriptions/nope-hook/health",
        headers={"x-api-key": acme_key},
    )
    assert r.status_code == 404
