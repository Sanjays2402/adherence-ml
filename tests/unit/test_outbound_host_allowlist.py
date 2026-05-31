"""Tests for the per-tenant outbound webhook host allowlist."""
from __future__ import annotations

import os
import tempfile

import pytest

_TMP = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP.close()
os.environ["ADHERENCE_DB_URL"] = f"sqlite:///{_TMP.name}"
os.environ.setdefault("JWT_SECRET", "x" * 32)
# Allow private IPs so DNS resolution failures during evaluate() do not
# mask the per-tenant allowlist decision we care about here.
os.environ["ADHERENCE_OUTBOUND_ALLOW_PRIVATE"] = "true"
os.environ["ADHERENCE_OUTBOUND_ALLOW_HTTP"] = "true"

from adherence_common.db import init_db  # noqa: E402
from adherence_common import outbound_host_allowlist as tha  # noqa: E402
from adherence_common import outbound_policy  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh():
    init_db()
    from sqlalchemy import delete
    from adherence_common.db import TenantOutboundHostAllowlist, session
    with session() as s:
        s.execute(delete(TenantOutboundHostAllowlist))
        s.commit()
    tha.reset_cache()
    yield
    tha.reset_cache()


def test_empty_allowlist_is_off_for_tenant():
    ok, reason = tha.is_allowed("acme", "api.partner.com")
    assert ok is True
    assert reason is None


def test_exact_host_match():
    tha.add_entry(
        tenant_id="acme", host="api.partner.com",
        label="prod partner", created_by="root",
    )
    ok, _ = tha.is_allowed("acme", "api.partner.com")
    assert ok is True
    ok, reason = tha.is_allowed("acme", "evil.example.com")
    assert ok is False
    assert "not in tenant outbound host allowlist" in (reason or "")


def test_subdomain_wildcard():
    tha.add_entry(
        tenant_id="acme", host=".partner.com",
        label="any partner.com", created_by=None,
    )
    assert tha.is_allowed("acme", "api.partner.com")[0] is True
    assert tha.is_allowed("acme", "deep.nested.partner.com")[0] is True
    # The bare apex does NOT match the leading-dot form.
    assert tha.is_allowed("acme", "partner.com")[0] is False


def test_cross_tenant_isolation():
    """The core multi-tenancy guarantee: acme's allowlist must not affect beta."""
    tha.add_entry(
        tenant_id="acme", host="api.partner.com",
        label=None, created_by=None,
    )
    # acme is locked down to api.partner.com only.
    assert tha.is_allowed("acme", "api.partner.com")[0] is True
    assert tha.is_allowed("acme", "elsewhere.com")[0] is False
    # beta has zero rows, so its gate is OFF.
    assert tha.is_allowed("beta", "anywhere.example")[0] is True
    assert tha.is_allowed("beta", "api.partner.com")[0] is True
    # beta locks itself down to a different host; acme is unaffected.
    tha.add_entry(
        tenant_id="beta", host="hooks.beta.example",
        label=None, created_by=None,
    )
    assert tha.is_allowed("beta", "hooks.beta.example")[0] is True
    assert tha.is_allowed("beta", "api.partner.com")[0] is False
    assert tha.is_allowed("acme", "api.partner.com")[0] is True
    assert tha.is_allowed("acme", "hooks.beta.example")[0] is False


def test_duplicate_rejected():
    tha.add_entry(tenant_id="acme", host="api.partner.com", label=None, created_by=None)
    with pytest.raises(tha.HostAllowlistError):
        tha.add_entry(tenant_id="acme", host="API.partner.com", label=None, created_by=None)


def test_bad_host_rejected():
    with pytest.raises(tha.HostAllowlistError):
        tha.add_entry(tenant_id="acme", host="not a host!", label=None, created_by=None)
    with pytest.raises(tha.HostAllowlistError):
        tha.add_entry(tenant_id="acme", host="", label=None, created_by=None)


def test_remove_entry_clears_gate():
    e = tha.add_entry(
        tenant_id="acme", host="api.partner.com", label=None, created_by=None,
    )
    assert tha.is_allowed("acme", "elsewhere.com")[0] is False
    assert tha.remove_entry(tenant_id="acme", entry_id=e.id) is True
    # Gate goes back to OFF for the tenant once the last row is removed.
    assert tha.is_allowed("acme", "elsewhere.com")[0] is True


def test_policy_evaluate_respects_tenant_allowlist():
    """outbound_policy.evaluate must consult the per-tenant allowlist."""
    tha.add_entry(
        tenant_id="acme", host="api.partner.com",
        label=None, created_by=None,
    )
    # No tenant context: tenant gate skipped, evaluation passes.
    d = outbound_policy.evaluate("http://elsewhere.test/hook")
    assert d.allowed is True, d.reason
    # With acme context, elsewhere.test is blocked.
    d = outbound_policy.evaluate(
        "http://elsewhere.test/hook", tenant_id="acme",
    )
    assert d.allowed is False
    assert "tenant outbound host allowlist" in (d.reason or "")
    # acme can still reach its own approved host.
    d = outbound_policy.evaluate(
        "http://api.partner.com/hook", tenant_id="acme",
    )
    assert d.allowed is True, d.reason
    # beta is unaffected.
    d = outbound_policy.evaluate(
        "http://elsewhere.test/hook", tenant_id="beta",
    )
    assert d.allowed is True, d.reason


def test_normalize_strips_trailing_dot_and_case():
    e = tha.add_entry(
        tenant_id="acme", host="API.Partner.COM.",
        label=None, created_by=None,
    )
    assert e.host == "api.partner.com"
    assert tha.is_allowed("acme", "api.partner.com")[0] is True
