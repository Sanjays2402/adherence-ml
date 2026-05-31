"""Tests for per-tenant legal hold (preservation order).

Covers:

* Place / list / release with audit-friendly fields populated.
* The cross-tenant isolation guarantee: a hold on tenant A must not
  block deletes on tenant B, and a release on tenant A's hold id from
  tenant B's scope must be a no-op.
* The two gated operations: GDPR erase and retention sweep both
  refuse to delete while any hold is active, and resume once the hold
  is released. Dry-run remains available throughout.
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

from sqlalchemy import delete  # noqa: E402

from adherence_common import legal_hold as lh  # noqa: E402
from adherence_common.legal_hold import LegalHold  # noqa: E402
from adherence_common.db import (  # noqa: E402
    PredictionAudit,
    init_db,
    session,
)


@pytest.fixture(autouse=True)
def _fresh():
    init_db()
    with session() as s:
        s.execute(delete(LegalHold))
        s.execute(delete(PredictionAudit))
        s.commit()
    yield
    with session() as s:
        s.execute(delete(LegalHold))
        s.execute(delete(PredictionAudit))
        s.commit()


# ---------------------------------------------------------------------------
# Module-level behaviour
# ---------------------------------------------------------------------------


def test_no_hold_means_not_on_hold():
    assert lh.is_on_hold("acme") is False
    assert lh.active_hold_summary("acme") is None
    assert lh.list_holds(tenant_id="acme") == []


def test_place_and_release_round_trip():
    view = lh.place_hold(
        tenant_id="acme",
        reason="matter SUP-4218 preservation order from counsel",
        placed_by="root@acme",
        label="SUP-4218",
        ticket_ref="JIRA-LEGAL-77",
    )
    assert view.active is True
    assert view.placed_by == "root@acme"
    assert view.released_at is None
    assert lh.is_on_hold("acme") is True

    released = lh.release_hold(
        tenant_id="acme",
        hold_id=view.id,
        released_by="legal@acme",
        release_reason="matter closed per signed runbook",
    )
    assert released is not None
    assert released.active is False
    assert released.released_by == "legal@acme"
    assert released.release_reason == "matter closed per signed runbook"
    assert lh.is_on_hold("acme") is False


def test_reason_validation():
    with pytest.raises(lh.LegalHoldError):
        lh.place_hold(
            tenant_id="acme", reason="too short", placed_by="x"
        )
    with pytest.raises(lh.LegalHoldError):
        lh.place_hold(
            tenant_id="acme", reason="   ", placed_by="x"
        )


def test_cross_tenant_isolation_for_release():
    """Tenant B must not be able to release tenant A's hold by id."""
    a = lh.place_hold(
        tenant_id="acme",
        reason="acme litigation hold for matter ACM-1",
        placed_by="acme-admin",
    )
    # Tenant beta sees no holds and cannot resolve acme's id.
    assert lh.get_hold(tenant_id="beta", hold_id=a.id) is None
    assert (
        lh.release_hold(
            tenant_id="beta",
            hold_id=a.id,
            released_by="beta-admin",
        )
        is None
    )
    # The hold on acme remains active.
    assert lh.is_on_hold("acme") is True
    fresh = lh.get_hold(tenant_id="acme", hold_id=a.id)
    assert fresh is not None and fresh.active is True


def test_cross_tenant_isolation_for_is_on_hold():
    lh.place_hold(
        tenant_id="acme",
        reason="acme preservation order in effect",
        placed_by="root",
    )
    assert lh.is_on_hold("acme") is True
    # Another tenant is unaffected by acme's hold.
    assert lh.is_on_hold("beta") is False


def test_double_release_returns_none():
    v = lh.place_hold(
        tenant_id="acme",
        reason="preserve everything until further notice",
        placed_by="root",
    )
    assert lh.release_hold(
        tenant_id="acme", hold_id=v.id, released_by="root"
    ) is not None
    # Second release on the same id is a no-op (already released).
    assert lh.release_hold(
        tenant_id="acme", hold_id=v.id, released_by="root"
    ) is None


# ---------------------------------------------------------------------------
# Integration: hold blocks GDPR erase + retention sweep
# ---------------------------------------------------------------------------


def _seed_audit_row(tenant: str, user: str, days_old: int = 400) -> None:
    """Insert a prediction_audit row old enough for any reasonable TTL."""
    with session() as s:
        s.add(
            PredictionAudit(
                tenant_id=tenant,
                request_id="req-test",
                route="/v1/predict",
                user_id=user,
                caller="tester",
                caller_role="admin",
                model_name="m",
                model_version="v1",
                n_doses=0,
                ok=1,
                created_at=datetime.utcnow() - timedelta(days=days_old),
            )
        )
        s.commit()


def test_gdpr_erase_blocked_by_legal_hold(monkeypatch):
    from fastapi.testclient import TestClient

    # Bypass JWT/IP middleware by minting a same-tenant admin principal.
    from adherence_api.app import create_app
    from adherence_api import deps

    app = create_app()

    def fake_principal():
        return {"sub": "root@acme", "role": "admin", "tenant": "acme"}

    app.dependency_overrides[deps.current_principal] = fake_principal
    client = TestClient(app)

    _seed_audit_row("acme", "user-1")

    # No hold yet: dry-run erase returns a preview.
    r = client.request(
        "DELETE", "/v1/users/user-1/data", params={"dry_run": "true"}
    )
    assert r.status_code == 200, r.text
    assert r.json().get("dry_run") is True

    # Place a hold on acme.
    lh.place_hold(
        tenant_id="acme",
        reason="acme preservation order for matter ACM-9",
        placed_by="root@acme",
    )

    # Real erase is now blocked with 423 Locked and the structured code.
    r2 = client.request("DELETE", "/v1/users/user-1/data")
    assert r2.status_code == 423, r2.text
    body = r2.json()
    assert body["detail"]["code"] == "legal_hold_active"

    # Dry-run still works (legal/IT can preview during a hold).
    r3 = client.request(
        "DELETE", "/v1/users/user-1/data", params={"dry_run": "true"}
    )
    assert r3.status_code == 200, r3.text

    # Beta tenant is unaffected.
    def fake_principal_beta():
        return {"sub": "root@beta", "role": "admin", "tenant": "beta"}

    app.dependency_overrides[deps.current_principal] = fake_principal_beta
    _seed_audit_row("beta", "user-2")
    r4 = client.request("DELETE", "/v1/users/user-2/data")
    assert r4.status_code == 200, r4.text
