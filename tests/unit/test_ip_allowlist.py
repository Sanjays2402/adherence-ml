"""Tests for the per-tenant IP allowlist module and middleware."""
from __future__ import annotations

import os
import tempfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# Use a throwaway sqlite db so the package-level engine cache binds to it
# before any model class touches the filesystem.
_TMP = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP.close()
os.environ["ADHERENCE_DB_URL"] = f"sqlite:///{_TMP.name}"
os.environ.setdefault("JWT_SECRET", "x" * 32)

from adherence_common.db import init_db  # noqa: E402
from adherence_common import ip_allowlist as ipa  # noqa: E402
from adherence_common.settings import get_settings  # noqa: E402
from adherence_api.ip_allowlist_middleware import IpAllowlistMiddleware  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_db():
    init_db()
    # Wipe any rows left over from earlier tests in the same session.
    from sqlalchemy import delete
    from adherence_common.db import TenantIpAllowlist, session
    with session() as s:
        s.execute(delete(TenantIpAllowlist))
        s.commit()
    ipa.reset_cache()
    yield
    ipa.reset_cache()


def test_empty_allowlist_allows_everything():
    assert ipa.is_allowed("acme", "203.0.113.5") is True
    assert ipa.is_allowed("acme", "10.0.0.1") is True


def test_add_then_block_outside_cidr():
    ipa.add_entry(tenant_id="acme", cidr="203.0.113.0/24", label="office", created_by="root")
    assert ipa.is_allowed("acme", "203.0.113.7") is True
    assert ipa.is_allowed("acme", "198.51.100.1") is False


def test_bare_ip_pins_to_host():
    e = ipa.add_entry(tenant_id="acme", cidr="203.0.113.42", label=None, created_by=None)
    assert e.cidr == "203.0.113.42/32"
    assert ipa.is_allowed("acme", "203.0.113.42") is True
    assert ipa.is_allowed("acme", "203.0.113.43") is False


def test_cross_tenant_isolation():
    ipa.add_entry(tenant_id="acme", cidr="203.0.113.0/24", label=None, created_by=None)
    # acme is locked down, beta is wide open
    assert ipa.is_allowed("acme", "10.0.0.1") is False
    assert ipa.is_allowed("beta", "10.0.0.1") is True
    # beta locks itself down; acme is unaffected
    ipa.add_entry(tenant_id="beta", cidr="10.0.0.0/8", label=None, created_by=None)
    assert ipa.is_allowed("beta", "10.0.0.1") is True
    assert ipa.is_allowed("beta", "203.0.113.7") is False
    assert ipa.is_allowed("acme", "203.0.113.7") is True


def test_duplicate_rejected():
    ipa.add_entry(tenant_id="acme", cidr="10.0.0.0/24", label=None, created_by=None)
    with pytest.raises(ipa.IpAllowlistError):
        ipa.add_entry(tenant_id="acme", cidr="10.0.0.0/24", label=None, created_by=None)


def test_bad_cidr_rejected():
    with pytest.raises(ipa.IpAllowlistError):
        ipa.add_entry(tenant_id="acme", cidr="not-an-ip", label=None, created_by=None)


def test_remove_entry_clears_gate():
    e = ipa.add_entry(tenant_id="acme", cidr="203.0.113.0/24", label=None, created_by=None)
    assert ipa.is_allowed("acme", "10.0.0.1") is False
    assert ipa.remove_entry(tenant_id="acme", entry_id=e.id) is True
    assert ipa.is_allowed("acme", "10.0.0.1") is True
    assert ipa.remove_entry(tenant_id="acme", entry_id=e.id) is False


def _build_app() -> TestClient:
    s = get_settings()
    app = FastAPI()
    app.add_middleware(IpAllowlistMiddleware, settings=s, exempt_prefixes=("/health",))

    @app.get("/ping")
    def ping():
        return {"ok": True}

    @app.get("/health")
    def health():
        return {"ok": True}

    return TestClient(app)


def test_middleware_blocks_unallowed_ip_for_default_tenant():
    ipa.add_entry(tenant_id="default", cidr="10.99.99.99/32", label=None, created_by=None)
    client = _build_app()
    r = client.get("/ping", headers={"x-forwarded-for": "203.0.113.1"})
    assert r.status_code == 403
    assert r.json()["error"] == "ip_not_allowed"
    # Allowed source passes
    r2 = client.get("/ping", headers={"x-forwarded-for": "10.99.99.99"})
    assert r2.status_code == 200
    # Exempt path always passes
    r3 = client.get("/health", headers={"x-forwarded-for": "203.0.113.1"})
    assert r3.status_code == 200
