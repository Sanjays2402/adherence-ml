"""Tests for the per-workspace password policy.

Covers:

* Default policy returned when no row exists.
* set_policy / clear_policy roundtrip.
* validate_password enforces every configured constraint.
* Cross-tenant isolation: a policy set in workspace ``acme`` does not
  affect workspace ``globex``. This is the procurement-blocker
  invariant for multi-tenant settings.
* Out-of-bounds inputs raise ValueError (defence in depth, even though
  the HTTP layer also validates).
"""
from __future__ import annotations

import sys

import pytest


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    db_file = tmp_path / "pwpolicy.db"
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith("adherence_common") or mod.startswith("adherence_api"):
            sys.modules.pop(mod, None)
    yield


def _fresh():
    from adherence_common import db
    from adherence_common import password_policy as pp
    db.init_db()
    return pp


def test_default_policy_when_no_row():
    pp = _fresh()
    pv = pp.get_policy("acme")
    assert pv.tenant_id is None  # signals default
    assert pv.min_length == 12
    assert pv.require_upper and pv.require_lower and pv.require_digit
    assert pv.require_symbol is False
    assert pv.history_size == 5


def test_set_and_clear_roundtrip():
    pp = _fresh()
    pv = pp.set_policy(
        "acme",
        min_length=16,
        require_upper=True,
        require_lower=True,
        require_digit=True,
        require_symbol=True,
        max_age_days=90,
        history_size=10,
        updated_by="alice",
    )
    assert pv.tenant_id == "acme"
    assert pv.min_length == 16
    assert pv.require_symbol is True
    assert pv.max_age_days == 90
    assert pv.history_size == 10
    assert pv.updated_by == "alice"

    fetched = pp.get_policy("acme")
    assert fetched.min_length == 16
    assert fetched.require_symbol is True

    assert pp.clear_policy("acme") is True
    assert pp.get_policy("acme").tenant_id is None  # back to default
    assert pp.clear_policy("acme") is False  # idempotent


def test_validate_password_enforces_every_constraint():
    pp = _fresh()
    policy = pp.PolicyView(
        tenant_id="acme",
        min_length=12,
        require_upper=True,
        require_lower=True,
        require_digit=True,
        require_symbol=True,
        max_age_days=0,
        history_size=0,
        updated_at=None,
        updated_by=None,
    )

    # Too short, missing digit, missing symbol.
    reasons = pp.validate_password("Short", policy=policy)
    assert any("at least 12" in r for r in reasons)
    assert any("digit" in r for r in reasons)
    assert any("symbol" in r for r in reasons)

    # Missing uppercase only.
    reasons = pp.validate_password("alllower1!aaa", policy=policy)
    assert reasons == ["must contain an uppercase letter"]

    # Missing lowercase only.
    reasons = pp.validate_password("ALLUPPER1!AAA", policy=policy)
    assert reasons == ["must contain a lowercase letter"]

    # Acceptable candidate.
    assert pp.validate_password("Correct-Horse-Battery-9", policy=policy) == []


def test_validate_password_handles_non_string():
    pp = _fresh()
    policy = pp.DEFAULT_POLICY
    assert pp.validate_password(None, policy=policy) == [  # type: ignore[arg-type]
        "password must be a string"
    ]


def test_cross_tenant_isolation():
    """A policy in tenant ``acme`` does not bleed into tenant ``globex``.

    Procurement-blocker invariant: one workspace cannot weaken or
    strengthen the controls of another.
    """
    pp = _fresh()
    pp.set_policy(
        "acme",
        min_length=20,
        require_upper=True,
        require_lower=True,
        require_digit=True,
        require_symbol=True,
        max_age_days=30,
        history_size=12,
        updated_by="alice",
    )
    # ``globex`` still sees the default policy.
    g = pp.get_policy("globex")
    assert g.tenant_id is None
    assert g.min_length == 12
    assert g.require_symbol is False
    assert g.max_age_days == 0

    # Validation reflects the per-tenant view.
    acme_reasons = pp.validate_password("Abcdef1!aaaa", policy=pp.get_policy("acme"))
    globex_reasons = pp.validate_password(
        "Abcdef1!aaaa", policy=pp.get_policy("globex")
    )
    assert any("at least 20" in r for r in acme_reasons)
    assert globex_reasons == []  # passes the laxer default

    # Clearing acme must not touch globex.
    pp.clear_policy("acme")
    assert pp.get_policy("globex").min_length == 12


def test_set_policy_rejects_out_of_bounds():
    pp = _fresh()
    with pytest.raises(ValueError):
        pp.set_policy(
            "acme",
            min_length=2,  # below floor
            require_upper=True, require_lower=True,
            require_digit=True, require_symbol=False,
            max_age_days=0, history_size=0,
        )
    with pytest.raises(ValueError):
        pp.set_policy(
            "acme",
            min_length=12,
            require_upper=True, require_lower=True,
            require_digit=True, require_symbol=False,
            max_age_days=pp.MAX_AGE_DAYS_CEILING + 1,
            history_size=0,
        )
    with pytest.raises(ValueError):
        pp.set_policy(
            "acme",
            min_length=12,
            require_upper=True, require_lower=True,
            require_digit=True, require_symbol=False,
            max_age_days=0,
            history_size=pp.HISTORY_CEILING + 1,
        )
    with pytest.raises(ValueError):
        pp.set_policy(
            "",
            min_length=12,
            require_upper=True, require_lower=True,
            require_digit=True, require_symbol=False,
            max_age_days=0, history_size=0,
        )
