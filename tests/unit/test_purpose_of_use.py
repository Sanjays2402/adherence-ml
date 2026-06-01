"""Tests for the per-workspace HIPAA Purpose of Use policy + middleware."""
from __future__ import annotations

import os
import tempfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# Bind to a throwaway sqlite db before any ORM class imports.
_TMP = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP.close()
os.environ["ADHERENCE_DB_URL"] = f"sqlite:///{_TMP.name}"
os.environ.setdefault("JWT_SECRET", "x" * 32)

from adherence_common.db import init_db  # noqa: E402
from adherence_common import purpose_of_use as pou  # noqa: E402
from adherence_common.settings import get_settings  # noqa: E402
from adherence_api.purpose_of_use_middleware import (  # noqa: E402
    PurposeOfUseMiddleware,
)


@pytest.fixture(autouse=True)
def _fresh_db():
    init_db()
    from sqlalchemy import delete
    from adherence_common.db import session
    with session() as s:
        s.execute(delete(pou.WorkspacePurposeOfUsePolicy))
        s.execute(delete(pou.PHIAccessLogRow))
        s.commit()
    yield


# ---------------- module-level ----------------


def test_normalize_uppercases_and_strips():
    assert pou.normalize_code("  treatment ") == "TREATMENT"
    assert pou.normalize_code(None) is None
    assert pou.normalize_code("") is None


def test_set_policy_rejects_unknown_code():
    with pytest.raises(ValueError):
        pou.set_policy(
            tenant_id="acme", allowed=["TREATMENT", "WHATEVER"],
            enforce=False, default_purpose=None, updated_by="me",
        )


def test_set_policy_requires_at_least_one_when_enforcing():
    with pytest.raises(ValueError):
        pou.set_policy(
            tenant_id="acme", allowed=[], enforce=True,
            default_purpose=None, updated_by="me",
        )


def test_set_policy_default_must_be_in_allowed():
    with pytest.raises(ValueError):
        pou.set_policy(
            tenant_id="acme", allowed=["TREATMENT"], enforce=False,
            default_purpose="PAYMENT", updated_by="me",
        )


def test_evaluate_when_not_enforcing_falls_back_to_default():
    pou.set_policy(
        tenant_id="acme", allowed=["TREATMENT", "PAYMENT"],
        enforce=False, default_purpose="TREATMENT", updated_by="me",
    )
    ok, eff, _ = pou.evaluate(tenant_id="acme", caller_purpose=None)
    assert ok is True
    assert eff == "TREATMENT"


def test_evaluate_when_enforcing_rejects_missing():
    pou.set_policy(
        tenant_id="acme", allowed=["TREATMENT"], enforce=True,
        default_purpose=None, updated_by="me",
    )
    ok, eff, _ = pou.evaluate(tenant_id="acme", caller_purpose=None)
    assert ok is False
    assert eff is None


def test_evaluate_when_enforcing_rejects_outside_set():
    pou.set_policy(
        tenant_id="acme", allowed=["TREATMENT"], enforce=True,
        default_purpose=None, updated_by="me",
    )
    ok, _, _ = pou.evaluate(tenant_id="acme", caller_purpose="PAYMENT")
    assert ok is False


def test_evaluate_when_enforcing_accepts_allowed():
    pou.set_policy(
        tenant_id="acme", allowed=["TREATMENT", "PAYMENT"], enforce=True,
        default_purpose=None, updated_by="me",
    )
    ok, eff, _ = pou.evaluate(tenant_id="acme", caller_purpose="payment")
    assert ok is True
    assert eff == "PAYMENT"


# ---------------- access log ----------------


def test_record_and_list_access_is_tenant_scoped():
    pou.record_access(
        tenant_id="acme", request_id="r1", route="/v1/predict",
        method="POST", purpose="TREATMENT", actor="key-a",
        actor_role="admin", key_name="key-a", client_ip="1.1.1.1",
        status_code=200, latency_ms=5.0, user_id="u1",
    )
    pou.record_access(
        tenant_id="other", request_id="r2", route="/v1/predict",
        method="POST", purpose="RESEARCH", actor="key-b",
        actor_role="admin", key_name="key-b", client_ip="2.2.2.2",
        status_code=200, latency_ms=4.0, user_id="u2",
    )
    rows_acme = pou.list_access(tenant_id="acme")
    rows_other = pou.list_access(tenant_id="other")
    assert len(rows_acme) == 1 and rows_acme[0].purpose == "TREATMENT"
    assert len(rows_other) == 1 and rows_other[0].purpose == "RESEARCH"
    # No row from "other" leaks into "acme".
    assert all(r.tenant_id == "acme" for r in rows_acme)
    assert pou.count_access(tenant_id="acme") == 1
    assert pou.count_access(tenant_id="other") == 1


# ---------------- middleware ----------------


def _build_app() -> TestClient:
    s = get_settings()
    app = FastAPI()
    app.add_middleware(PurposeOfUseMiddleware, settings=s)

    @app.get("/v1/predict/sample")
    def phi():
        return {"ok": True}

    @app.get("/v1/health")
    def health():
        return {"ok": True}

    return TestClient(app)


def test_middleware_passes_non_phi_path_without_header():
    """Non-PHI surfaces (health) never require POU even when enforced."""
    pou.set_policy(
        tenant_id="default", allowed=["TREATMENT"], enforce=True,
        default_purpose=None, updated_by="t",
    )
    client = _build_app()
    r = client.get("/v1/health")
    assert r.status_code == 200


def test_middleware_blocks_phi_without_header_when_enforcing():
    pou.set_policy(
        tenant_id="default", allowed=["TREATMENT", "PAYMENT"], enforce=True,
        default_purpose=None, updated_by="t",
    )
    client = _build_app()
    r = client.get("/v1/predict/sample")
    assert r.status_code == 412
    body = r.json()
    assert body["error"] == "purpose_of_use_required"
    assert set(body["allowed"]) == {"TREATMENT", "PAYMENT"}
    assert r.headers["X-Purpose-Required"]
    # Denied attempt is logged for the workspace owner to see.
    rows = pou.list_access(tenant_id="default")
    assert any(
        r.status_code == 412 and r.route == "/v1/predict/sample"
        for r in rows
    )


def test_middleware_allows_phi_with_valid_header_when_enforcing():
    pou.set_policy(
        tenant_id="default", allowed=["TREATMENT"], enforce=True,
        default_purpose=None, updated_by="t",
    )
    client = _build_app()
    r = client.get(
        "/v1/predict/sample",
        headers={"X-Purpose-Of-Use": "treatment"},
    )
    assert r.status_code == 200
    assert r.headers["X-Purpose-Of-Use"] == "TREATMENT"
    rows = pou.list_access(tenant_id="default")
    assert any(
        r.status_code == 200 and r.purpose == "TREATMENT"
        for r in rows
    )


def test_middleware_rejects_purpose_outside_allowed_set():
    pou.set_policy(
        tenant_id="default", allowed=["TREATMENT"], enforce=True,
        default_purpose=None, updated_by="t",
    )
    client = _build_app()
    r = client.get(
        "/v1/predict/sample",
        headers={"X-Purpose-Of-Use": "RESEARCH"},
    )
    assert r.status_code == 412


def test_middleware_off_passes_and_stamps_default():
    # No policy row at all: enforce off, default-off view.
    client = _build_app()
    r = client.get("/v1/predict/sample")
    assert r.status_code == 200
    # Without a configured default the global default code is stamped.
    assert r.headers["X-Purpose-Of-Use"] == pou.DEFAULT_POU
