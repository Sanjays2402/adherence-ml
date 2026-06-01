"""Tests for the per-tenant browser Origin allowlist module and middleware."""
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
from adherence_common import origin_allowlist as oa  # noqa: E402
from adherence_common.settings import get_settings  # noqa: E402
from adherence_api.origin_allowlist_middleware import OriginAllowlistMiddleware  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_db():
    init_db()
    from sqlalchemy import delete
    from adherence_common.db import TenantOriginAllowlist, session
    with session() as s:
        s.execute(delete(TenantOriginAllowlist))
        s.commit()
    oa.reset_cache()
    yield
    oa.reset_cache()


# ---------- normalization ----------

def test_normalize_strips_path_and_lowercases_host():
    assert oa.normalize_origin("HTTPS://App.Example.COM") == "https://app.example.com"
    assert oa.normalize_origin("https://app.example.com/") == "https://app.example.com"


def test_normalize_keeps_explicit_port():
    assert oa.normalize_origin("http://localhost:3000") == "http://localhost:3000"


def test_normalize_rejects_paths_and_queries():
    with pytest.raises(oa.OriginAllowlistError):
        oa.normalize_origin("https://app.example.com/admin")
    with pytest.raises(oa.OriginAllowlistError):
        oa.normalize_origin("https://app.example.com/?x=1")


def test_normalize_rejects_userinfo_and_whitespace():
    with pytest.raises(oa.OriginAllowlistError):
        oa.normalize_origin("https://user@app.example.com")
    with pytest.raises(oa.OriginAllowlistError):
        oa.normalize_origin("https://app .example.com")


def test_normalize_rejects_bad_scheme_and_bare_host():
    with pytest.raises(oa.OriginAllowlistError):
        oa.normalize_origin("ftp://app.example.com")
    with pytest.raises(oa.OriginAllowlistError):
        oa.normalize_origin("app.example.com")


def test_normalize_accepts_wildcard_leftmost_label_only():
    assert oa.normalize_origin("https://*.example.com") == "https://*.example.com"
    with pytest.raises(oa.OriginAllowlistError):
        oa.normalize_origin("https://*foo.example.com")
    with pytest.raises(oa.OriginAllowlistError):
        oa.normalize_origin("https://app.*.example.com")


# ---------- gate behavior ----------

def test_empty_allowlist_allows_everything():
    assert oa.is_allowed("acme", "https://anything.example.com") is True
    assert oa.is_enforced("acme") is False


def test_exact_match_only_when_enforced():
    oa.add_entry(
        tenant_id="acme", origin="https://app.example.com",
        label=None, created_by=None,
    )
    assert oa.is_enforced("acme") is True
    assert oa.is_allowed("acme", "https://app.example.com") is True
    # Different host
    assert oa.is_allowed("acme", "https://evil.example.com") is False
    # Different scheme
    assert oa.is_allowed("acme", "http://app.example.com") is False


def test_wildcard_matches_subdomains_not_apex():
    oa.add_entry(
        tenant_id="acme", origin="https://*.example.com",
        label=None, created_by=None,
    )
    assert oa.is_allowed("acme", "https://app.example.com") is True
    assert oa.is_allowed("acme", "https://deep.app.example.com") is True
    assert oa.is_allowed("acme", "https://example.com") is False
    assert oa.is_allowed("acme", "https://evil.org") is False


def test_port_must_match():
    oa.add_entry(
        tenant_id="acme", origin="http://localhost:3000",
        label=None, created_by=None,
    )
    assert oa.is_allowed("acme", "http://localhost:3000") is True
    assert oa.is_allowed("acme", "http://localhost:3001") is False
    assert oa.is_allowed("acme", "http://localhost") is False


def test_cross_tenant_isolation():
    """Locking acme down to one origin must not affect beta."""
    oa.add_entry(
        tenant_id="acme", origin="https://app.acme.example",
        label=None, created_by=None,
    )
    # acme is locked, beta is wide open
    assert oa.is_allowed("acme", "https://other.example.com") is False
    assert oa.is_allowed("acme", "https://app.acme.example") is True
    assert oa.is_allowed("beta", "https://anything.example.com") is True
    # beta locks itself; acme is unaffected
    oa.add_entry(
        tenant_id="beta", origin="https://app.beta.example",
        label=None, created_by=None,
    )
    assert oa.is_allowed("beta", "https://app.beta.example") is True
    assert oa.is_allowed("beta", "https://app.acme.example") is False
    assert oa.is_allowed("acme", "https://app.acme.example") is True


def test_duplicate_rejected():
    oa.add_entry(
        tenant_id="acme", origin="https://app.example.com",
        label=None, created_by=None,
    )
    with pytest.raises(oa.OriginAllowlistError):
        oa.add_entry(
            tenant_id="acme", origin="https://app.example.com/",
            label=None, created_by=None,
        )


def test_remove_entry_clears_gate():
    e = oa.add_entry(
        tenant_id="acme", origin="https://app.example.com",
        label=None, created_by=None,
    )
    assert oa.is_allowed("acme", "https://other.example.com") is False
    assert oa.remove_entry(tenant_id="acme", entry_id=e.id) is True
    assert oa.is_allowed("acme", "https://other.example.com") is True
    assert oa.remove_entry(tenant_id="acme", entry_id=e.id) is False


# ---------- middleware ----------

def _build_app() -> TestClient:
    s = get_settings()
    app = FastAPI()
    app.add_middleware(
        OriginAllowlistMiddleware, settings=s, exempt_prefixes=("/health",)
    )

    @app.get("/ping")
    def ping():
        return {"ok": True}

    @app.get("/health")
    def health():
        return {"ok": True}

    return TestClient(app)


def test_middleware_allows_when_no_origin_header():
    """Server to server callers never set Origin: they must not be blocked."""
    oa.add_entry(
        tenant_id="default", origin="https://app.example.com",
        label=None, created_by=None,
    )
    client = _build_app()
    r = client.get("/ping")  # no Origin
    assert r.status_code == 200


def test_middleware_blocks_disallowed_origin_for_default_tenant():
    oa.add_entry(
        tenant_id="default", origin="https://app.example.com",
        label=None, created_by=None,
    )
    client = _build_app()
    r = client.get("/ping", headers={"origin": "https://evil.example.com"})
    assert r.status_code == 403
    body = r.json()
    assert body["error"] == "origin_not_allowed"
    assert body["tenant_id"] == "default"
    # Allowed origin passes
    r2 = client.get("/ping", headers={"origin": "https://app.example.com"})
    assert r2.status_code == 200
    # Exempt path always passes
    r3 = client.get("/health", headers={"origin": "https://evil.example.com"})
    assert r3.status_code == 200


def test_middleware_skips_preflight_options():
    oa.add_entry(
        tenant_id="default", origin="https://app.example.com",
        label=None, created_by=None,
    )
    client = _build_app()
    # OPTIONS is not bound to a handler in our test app, but the
    # middleware should pass it through without a 403 first.
    r = client.options("/ping", headers={"origin": "https://evil.example.com"})
    assert r.status_code != 403


def test_middleware_off_when_tenant_has_no_entries():
    client = _build_app()
    r = client.get("/ping", headers={"origin": "https://anywhere.example.com"})
    assert r.status_code == 200
