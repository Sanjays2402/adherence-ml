"""Tests for the per-workspace CMEK / BYOK registration registry.

Covers:

* ``get_registration`` returns None when no row exists.
* ``set_registration`` -> ``get_registration`` roundtrip preserves every field.
* ``record_rotation`` increments the counter and only works on active rows.
* Validation rejects unknown providers, blank key references, out-of-range
  rotation cadences, and embedded newlines.
* Cross-tenant isolation: a registration in workspace ``acme`` is
  invisible to workspace ``globex``. Procurement-blocker invariant: one
  workspace can never see or mutate another workspace's CMEK record.
"""
from __future__ import annotations

import sys
import time

import pytest


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    db_file = tmp_path / "cmek.db"
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith("adherence_common") or mod.startswith("adherence_api"):
            sys.modules.pop(mod, None)
    yield


def _fresh():
    from adherence_common import db
    from adherence_common import cmek_registry as cr
    db.init_db()
    return cr


def test_missing_returns_none():
    cr = _fresh()
    assert cr.get_registration("acme") is None


def test_set_and_read_roundtrip():
    cr = _fresh()
    rv = cr.set_registration(
        "acme",
        provider="aws_kms",
        key_reference="arn:aws:kms:us-east-1:111:key/abc",
        rotation_period_days=90,
        state="active",
        description="prod encryption key",
        contact="security@acme.test",
        updated_by="alice",
    )
    assert rv.tenant_id == "acme"
    assert rv.provider == "aws_kms"
    assert rv.key_reference == "arn:aws:kms:us-east-1:111:key/abc"
    assert rv.rotation_period_days == 90
    assert rv.state == "active"
    assert rv.description == "prod encryption key"
    assert rv.contact == "security@acme.test"
    assert rv.registered_by == "alice"
    assert rv.rotation_count == 0
    assert rv.last_rotated_at is None
    assert rv.rotation_due_at == rv.registered_at + 90 * 86400
    assert rv.rotation_overdue is False

    fetched = cr.get_registration("acme")
    assert fetched is not None
    assert fetched.key_reference == "arn:aws:kms:us-east-1:111:key/abc"
    assert fetched.rotation_count == 0


def test_rotation_increments_counter_and_swaps_reference():
    cr = _fresh()
    cr.set_registration(
        "acme",
        provider="aws_kms",
        key_reference="arn:aws:kms:us-east-1:111:key/old",
        rotation_period_days=30,
        state="active",
        updated_by="alice",
    )
    rv = cr.record_rotation(
        "acme",
        new_key_reference="arn:aws:kms:us-east-1:111:key/new",
        note="ticket SEC-42",
        updated_by="bob",
    )
    assert rv.key_reference == "arn:aws:kms:us-east-1:111:key/new"
    assert rv.rotation_count == 1
    assert rv.last_rotated_at is not None
    assert rv.last_rotated_by == "bob"

    # second rotation increments again
    rv2 = cr.record_rotation("acme", updated_by="bob")
    assert rv2.rotation_count == 2
    # no new reference -> keeps the previous one
    assert rv2.key_reference == "arn:aws:kms:us-east-1:111:key/new"


def test_rotation_requires_active_state():
    cr = _fresh()
    cr.set_registration(
        "acme",
        provider="aws_kms",
        key_reference="arn:aws:kms:us-east-1:111:key/abc",
        rotation_period_days=30,
        state="pending",
        updated_by="alice",
    )
    with pytest.raises(ValueError):
        cr.record_rotation("acme", updated_by="alice")


def test_rotation_requires_existing_registration():
    cr = _fresh()
    with pytest.raises(LookupError):
        cr.record_rotation("acme", updated_by="alice")


def test_validation_rejects_bad_input():
    cr = _fresh()
    with pytest.raises(ValueError):
        cr.set_registration(
            "acme",
            provider="not_a_real_kms",
            key_reference="x",
            rotation_period_days=30,
        )
    with pytest.raises(ValueError):
        cr.set_registration(
            "acme",
            provider="aws_kms",
            key_reference="   ",
            rotation_period_days=30,
        )
    with pytest.raises(ValueError):
        cr.set_registration(
            "acme",
            provider="aws_kms",
            key_reference="line1\nline2",
            rotation_period_days=30,
        )
    with pytest.raises(ValueError):
        cr.set_registration(
            "acme",
            provider="aws_kms",
            key_reference="arn:aws:kms:...",
            rotation_period_days=0,
        )
    with pytest.raises(ValueError):
        cr.set_registration(
            "acme",
            provider="aws_kms",
            key_reference="arn:aws:kms:...",
            rotation_period_days=30,
            state="totally_invalid",
        )


def test_clear_is_idempotent():
    cr = _fresh()
    cr.set_registration(
        "acme",
        provider="gcp_kms",
        key_reference="projects/p/locations/global/keyRings/r/cryptoKeys/k",
        rotation_period_days=60,
        updated_by="alice",
    )
    assert cr.clear_registration("acme") is True
    assert cr.get_registration("acme") is None
    assert cr.clear_registration("acme") is False


def test_cross_tenant_isolation():
    """A registration in workspace ``acme`` is invisible to ``globex``.

    Procurement-blocker invariant: one workspace cannot read, mutate,
    or rotate another workspace's CMEK record.
    """
    cr = _fresh()
    cr.set_registration(
        "acme",
        provider="aws_kms",
        key_reference="arn:aws:kms:us-east-1:111:key/acme",
        rotation_period_days=90,
        state="active",
        updated_by="alice",
    )
    # globex sees nothing.
    assert cr.get_registration("globex") is None

    # globex cannot rotate acme's key by happening to call into the
    # registry with its own tenant id.
    with pytest.raises(LookupError):
        cr.record_rotation("globex", updated_by="mallory")

    # globex's own registration coexists without touching acme's row.
    cr.set_registration(
        "globex",
        provider="azure_keyvault",
        key_reference="https://globex.vault.azure.net/keys/k/v",
        rotation_period_days=180,
        state="pending",
        updated_by="erin",
    )
    a = cr.get_registration("acme")
    g = cr.get_registration("globex")
    assert a is not None and g is not None
    assert a.key_reference != g.key_reference
    assert a.provider == "aws_kms"
    assert g.provider == "azure_keyvault"
    assert a.state == "active"
    assert g.state == "pending"

    # Clearing globex does not touch acme.
    assert cr.clear_registration("globex") is True
    assert cr.get_registration("acme") is not None


def test_overdue_flag_flips_when_due_date_passes(monkeypatch):
    cr = _fresh()
    rv = cr.set_registration(
        "acme",
        provider="aws_kms",
        key_reference="arn:aws:kms:us-east-1:111:key/abc",
        rotation_period_days=1,
        state="active",
        updated_by="alice",
    )
    assert rv.rotation_overdue is False
    # Force "now" forward past the due window and re-read.
    real_now = cr._now_ts
    monkeypatch.setattr(cr, "_now_ts", lambda: real_now() + 86400 * 3)
    fetched = cr.get_registration("acme")
    assert fetched is not None
    assert fetched.rotation_overdue is True
