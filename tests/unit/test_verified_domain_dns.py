"""DNS TXT verification gating for workspace verified domains.

Covers: an unverified claim never wins ``resolve_auto_join`` even when
``auto_join_enabled=True``; the TXT challenge surface is per-tenant;
posting the correct TXT value flips the row to verified and unlocks
auto-join; a tampered token is rejected; rotating the token returns the
row to pending so a previously verified domain cannot be silently
captured by an attacker who later guesses an old token; and cross-tenant
isolation holds (workspace A's claim cannot be verified using workspace
B's published TXT).
"""
from __future__ import annotations

import sys

import pytest


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    db_file = tmp_path / "verified_domain_dns.db"
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith("adherence_common") or mod.startswith("adherence_api"):
            sys.modules.pop(mod, None)
    yield


def _fresh():
    from adherence_common import db, verified_domains as vd
    db.init_db()
    return vd


def test_unverified_claim_does_not_auto_join_even_when_enabled():
    vd = _fresh()
    vd.add_domain("acme", "acme.test", default_role="viewer", auto_join_enabled=True)
    # No DNS verification performed: resolver MUST refuse to bind.
    assert vd.resolve_auto_join("alice@acme.test") is None


def test_verify_with_correct_dns_unlocks_auto_join():
    vd = _fresh()
    view = vd.add_domain("acme", "acme.test", auto_join_enabled=True)
    assert view.status == "pending"
    expected_value = vd.dns_txt_value(view.verification_token)

    def resolver(name: str) -> list[str]:
        assert name == vd.dns_txt_name("acme.test")
        return ["some-other-record=ignored", expected_value]

    verified = vd.verify_domain_dns("acme", "acme.test", resolver=resolver)
    assert verified.status == "verified"
    assert verified.verified_at is not None

    res = vd.resolve_auto_join("alice@acme.test")
    assert res is not None
    assert res.tenant_id == "acme"
    assert res.role == "viewer"


def test_verify_rejects_token_mismatch_and_missing_txt():
    vd = _fresh()
    view = vd.add_domain("acme", "acme.test")

    def empty(_name: str) -> list[str]:
        return []

    with pytest.raises(vd.DnsVerificationError) as ei:
        vd.verify_domain_dns("acme", "acme.test", resolver=empty)
    assert str(ei.value) == "txt_not_found"

    def wrong(_name: str) -> list[str]:
        return ["adherence-ml-verify=deadbeef" * 2]

    with pytest.raises(vd.DnsVerificationError) as ei2:
        vd.verify_domain_dns("acme", "acme.test", resolver=wrong)
    assert str(ei2.value) == "token_mismatch_dns"

    # Still pending, still no auto-join.
    again = vd.get_domain("acme", "acme.test")
    assert again is not None and again.status == "pending"
    assert vd.resolve_auto_join("alice@acme.test") is None


def test_rotate_token_resets_to_pending_and_blocks_auto_join():
    vd = _fresh()
    view = vd.add_domain("acme", "acme.test", auto_join_enabled=True)
    expected = vd.dns_txt_value(view.verification_token)
    vd.verify_domain_dns("acme", "acme.test", resolver=lambda n: [expected])
    assert vd.resolve_auto_join("alice@acme.test") is not None

    rotated = vd.rotate_verification_token("acme", "acme.test")
    assert rotated is not None
    assert rotated.status == "pending"
    assert rotated.verification_token != view.verification_token
    # Auto-join disabled again until the new token is re-verified.
    assert vd.resolve_auto_join("alice@acme.test") is None

    # Old TXT value no longer wins.
    with pytest.raises(vd.DnsVerificationError):
        vd.verify_domain_dns(
            "acme", "acme.test", resolver=lambda n: [expected]
        )


def test_cross_tenant_isolation_on_verify():
    vd = _fresh()
    a = vd.add_domain("acme", "shared.test", auto_join_enabled=True)
    b = vd.add_domain("beta", "shared.test", auto_join_enabled=True)
    assert a.verification_token != b.verification_token

    # Publish acme's TXT only. Verifying beta with acme's value must fail.
    acme_value = vd.dns_txt_value(a.verification_token)
    with pytest.raises(vd.DnsVerificationError) as ei:
        vd.verify_domain_dns("beta", "shared.test", resolver=lambda n: [acme_value])
    assert str(ei.value) == "token_mismatch_dns"

    # Verify acme correctly. Resolver still returns single value; both
    # claims are enabled but only acme is verified, so auto-join must
    # bind to acme without confusion.
    vd.verify_domain_dns("acme", "shared.test", resolver=lambda n: [acme_value])
    res = vd.resolve_auto_join("z@shared.test")
    assert res is not None and res.tenant_id == "acme"

    # If beta later also verifies (different token, separately published),
    # the resolver refuses to pick a winner between two verified claims.
    beta_value = vd.dns_txt_value(b.verification_token)
    vd.verify_domain_dns("beta", "shared.test", resolver=lambda n: [beta_value])
    assert vd.resolve_auto_join("z@shared.test") is None
