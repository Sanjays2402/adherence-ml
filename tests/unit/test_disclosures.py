"""Tests for the per-tenant HIPAA Accounting of Disclosures register.

Covers:

* Record / list / get round trip, immutability (correction appends a
  new row referencing the prior id rather than mutating it).
* Subject accounting returns only the requested subject's events,
  in chronological order, within the lookback window.
* Cross-tenant isolation: tenant B cannot see, get, correct, or
  produce an accounting for tenant A's entries. This is the
  multi-tenancy gate procurement cares about.
* Validation: unknown purpose, future disclosed_at, missing required
  fields, ``other`` purpose requires a non-trivial description,
  correction targeting a foreign tenant's entry is rejected.
* Summary returns counts by purpose and unique subject count.
"""
from __future__ import annotations

import os
import tempfile

import pytest

_TMP = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP.close()
os.environ["ADHERENCE_DB_URL"] = f"sqlite:///{_TMP.name}"
os.environ.setdefault("JWT_SECRET", "x" * 32)

from datetime import datetime, timedelta  # noqa: E402

from sqlalchemy import delete  # noqa: E402

from adherence_common import disclosures as disc_mod  # noqa: E402
from adherence_common.disclosures import DisclosureEntry  # noqa: E402
from adherence_common.db import init_db, session  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh():
    init_db()
    with session() as s:
        s.execute(delete(DisclosureEntry))
        s.commit()
    yield
    with session() as s:
        s.execute(delete(DisclosureEntry))
        s.commit()


def _mk(tenant="acme", subject="patient-42", **kw):
    return disc_mod.record_disclosure(
        tenant_id=tenant,
        subject_id=subject,
        recipient_name=kw.pop("recipient_name", "Public Health Dept"),
        recipient_org=kw.pop("recipient_org", "State PHD"),
        purpose=kw.pop("purpose", "public_health"),
        phi_description=kw.pop(
            "phi_description", "lab result for reportable condition"
        ),
        legal_basis=kw.pop("legal_basis", "45 CFR 164.512(b)"),
        requested_by=kw.pop("requested_by", "compliance@acme"),
        disclosed_at=kw.pop("disclosed_at", datetime.utcnow() - timedelta(days=10)),
        notes=kw.pop("notes", None),
        created_by=kw.pop("created_by", "ops@acme"),
        corrects_entry_id=kw.pop("corrects_entry_id", None),
    )


def test_record_and_get_roundtrip():
    v = _mk()
    assert v.id > 0
    assert v.tenant_id == "acme"
    assert v.subject_id == "patient-42"
    assert v.purpose == "public_health"
    assert v.retain_until > v.disclosed_at
    got = disc_mod.get_entry(tenant_id="acme", entry_id=v.id)
    assert got is not None
    assert got.id == v.id


def test_correction_is_append_only():
    original = _mk(recipient_name="Wrong Name")
    corrected = disc_mod.record_disclosure(
        tenant_id="acme",
        subject_id=original.subject_id,
        recipient_name="Correct Name",
        purpose="public_health",
        phi_description="lab result for reportable condition",
        requested_by="compliance@acme",
        created_by="ops@acme",
        corrects_entry_id=original.id,
    )
    assert corrected.id != original.id
    assert corrected.corrects_entry_id == original.id
    # Original row is unchanged.
    again = disc_mod.get_entry(tenant_id="acme", entry_id=original.id)
    assert again.recipient_name == "Wrong Name"
    assert again.corrects_entry_id is None


def test_cross_tenant_isolation():
    a = _mk(tenant="acme", subject="patient-a")
    _mk(tenant="other", subject="patient-x")

    other_list = disc_mod.list_entries(tenant_id="other")
    assert all(r.tenant_id == "other" for r in other_list)
    assert all(r.subject_id != "patient-a" for r in other_list)

    # Other tenant cannot fetch acme's entry by id.
    assert disc_mod.get_entry(tenant_id="other", entry_id=a.id) is None

    # Other tenant's accounting for acme's patient is empty.
    acct = disc_mod.subject_accounting(
        tenant_id="other", subject_id="patient-a"
    )
    assert acct == []

    # Correction targeting a foreign tenant's entry is rejected.
    with pytest.raises(disc_mod.DisclosureError):
        disc_mod.record_disclosure(
            tenant_id="other",
            subject_id="patient-a",
            recipient_name="X",
            purpose="public_health",
            phi_description="attempting to amend foreign tenant entry",
            requested_by="attacker@other",
            created_by="attacker@other",
            corrects_entry_id=a.id,
        )


def test_subject_accounting_filters_and_orders():
    now = datetime.utcnow()
    _mk(subject="p1", disclosed_at=now - timedelta(days=5))
    _mk(subject="p1", disclosed_at=now - timedelta(days=1))
    _mk(subject="p2", disclosed_at=now - timedelta(days=2))
    acct = disc_mod.subject_accounting(tenant_id="acme", subject_id="p1")
    assert len(acct) == 2
    assert all(r.subject_id == "p1" for r in acct)
    # chronological ascending
    assert acct[0].disclosed_at <= acct[1].disclosed_at


def test_validation_rejects_bad_inputs():
    with pytest.raises(disc_mod.DisclosureError):
        _mk(purpose="not_a_category")
    with pytest.raises(disc_mod.DisclosureError):
        _mk(disclosed_at=datetime.utcnow() + timedelta(days=30))
    with pytest.raises(disc_mod.DisclosureError):
        _mk(subject="", )
    with pytest.raises(disc_mod.DisclosureError):
        _mk(recipient_name="x")  # too short
    # "other" requires a longer description
    with pytest.raises(disc_mod.DisclosureError):
        _mk(purpose="other", phi_description="abc")


def test_summary_counts():
    _mk(subject="p1", purpose="public_health")
    _mk(subject="p1", purpose="research")
    _mk(subject="p2", purpose="public_health")
    s = disc_mod.summary(tenant_id="acme")
    assert s["total"] == 3
    assert s["unique_subjects"] == 2
    assert s["by_purpose"]["public_health"] == 2
    assert s["by_purpose"]["research"] == 1
    assert s["last_disclosed_at"] is not None


def test_list_filters():
    now = datetime.utcnow()
    _mk(subject="p1", disclosed_at=now - timedelta(days=20), purpose="research")
    _mk(subject="p1", disclosed_at=now - timedelta(days=2), purpose="public_health")
    rows = disc_mod.list_entries(
        tenant_id="acme", purpose="research"
    )
    assert len(rows) == 1
    assert rows[0].purpose == "research"
    rows = disc_mod.list_entries(
        tenant_id="acme", since=now - timedelta(days=5)
    )
    assert len(rows) == 1
    assert rows[0].purpose == "public_health"
