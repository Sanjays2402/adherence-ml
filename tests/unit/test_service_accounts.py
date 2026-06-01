"""Tests for per-tenant Service Account / Non-Human Identity register.

Covers:

* Create / list / update / archive round trip with monotonic version
  bump on every update.
* Cross-tenant isolation: tenant B cannot see, update, rotate, review,
  or archive tenant A's entry. Procurement cares about this gate.
* Rotation and review record paths refresh timestamps and bump version.
* Validation: short name, bad name chars, unknown kind, unknown
  credential kind, bad email, future last_rotated_at, duplicate
  active name within tenant, out-of-range cadence, bad scope chars,
  too many scopes.
* Overdue accounting: rotation_overdue and review_overdue flip when
  cadence elapses; rotation_overdue_count and review_overdue_count
  reflect it.
* Dormant_days reflects time since last_used_at.
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

from adherence_common import service_accounts as sa_mod  # noqa: E402
from adherence_common.service_accounts import ServiceAccount  # noqa: E402
from adherence_common.db import init_db, session  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh():
    init_db()
    with session() as s:
        s.execute(delete(ServiceAccount))
        s.commit()
    yield
    with session() as s:
        s.execute(delete(ServiceAccount))
        s.commit()


def _mk(tenant="acme", name="github-actions-ci", **kw):
    return sa_mod.create_entry(
        tenant_id=tenant,
        name=name,
        kind=kw.pop("kind", "ci"),
        system_of_record=kw.pop("system_of_record", "github-actions"),
        credential_kind=kw.pop("credential_kind", "oauth_client"),
        owner_email=kw.pop("owner_email", "secops@acme.example"),
        created_by=kw.pop("created_by", "secops@acme.example"),
        scopes=kw.pop("scopes", ["read:repo", "write:packages"]),
        vault_managed=kw.pop("vault_managed", True),
        rotation_cadence_days=kw.pop("rotation_cadence_days", 90),
        review_cadence_days=kw.pop("review_cadence_days", 180),
        last_rotated_at=kw.pop(
            "last_rotated_at", datetime.utcnow() - timedelta(days=10)
        ),
        last_used_at=kw.pop(
            "last_used_at", datetime.utcnow() - timedelta(days=2)
        ),
        status=kw.pop("status", "active"),
        notes=kw.pop("notes", "Builds main, pushes container images."),
    )


def test_empty_register():
    assert sa_mod.list_entries(tenant_id="acme") == []
    assert sa_mod.active_count("acme") == 0
    assert sa_mod.rotation_overdue_count("acme") == 0
    assert sa_mod.review_overdue_count("acme") == 0


def test_create_list_update_archive_round_trip():
    v = _mk()
    assert v.active is True
    assert v.version == 1
    assert v.kind == "ci"
    assert v.system_of_record == "github-actions"
    assert v.credential_kind == "oauth_client"
    assert v.owner_email == "secops@acme.example"
    assert v.scopes == ["read:repo", "write:packages"]
    assert v.vault_managed is True
    assert v.rotation_overdue is False
    assert v.review_overdue is False
    assert v.dormant_days is not None and v.dormant_days <= 3

    listed = sa_mod.list_entries(tenant_id="acme")
    assert len(listed) == 1 and listed[0].id == v.id

    updated = sa_mod.update_entry(
        tenant_id="acme",
        entry_id=v.id,
        updated_by="ciso@acme.example",
        owner_email="platform@acme.example",
        scopes=["read:repo"],
        vault_managed=False,
        status="suspended",
        notes="Suspended pending review.",
    )
    assert updated is not None
    assert updated.version == 2
    assert updated.owner_email == "platform@acme.example"
    assert updated.scopes == ["read:repo"]
    assert updated.vault_managed is False
    assert updated.status == "suspended"
    assert updated.notes == "Suspended pending review."

    archived = sa_mod.archive_entry(
        tenant_id="acme", entry_id=v.id, archived_by="ciso@acme.example"
    )
    assert archived is not None
    assert archived.active is False
    assert sa_mod.list_entries(tenant_id="acme") == []
    listed_all = sa_mod.list_entries(tenant_id="acme", include_archived=True)
    assert len(listed_all) == 1 and not listed_all[0].active


def test_rotation_and_review_bumps_and_clears_overdue():
    v = _mk(
        last_rotated_at=datetime.utcnow() - timedelta(days=200),
        rotation_cadence_days=90,
        review_cadence_days=30,
    )
    # Created_at is now, so review_overdue defers to created_at + 30d.
    assert v.rotation_overdue is True
    assert v.review_overdue is False
    assert sa_mod.rotation_overdue_count("acme") == 1

    rot = sa_mod.record_rotation(
        tenant_id="acme", entry_id=v.id, rotated_by="ops@acme.example"
    )
    assert rot is not None
    assert rot.version == v.version + 1
    assert rot.rotation_overdue is False
    assert sa_mod.rotation_overdue_count("acme") == 0

    rev = sa_mod.record_review(
        tenant_id="acme", entry_id=v.id, reviewed_by="ciso@acme.example"
    )
    assert rev is not None
    assert rev.version == rot.version + 1
    assert rev.last_reviewed_at is not None
    assert rev.review_overdue is False


def test_rotation_blocked_on_decommissioned():
    v = _mk()
    sa_mod.update_entry(
        tenant_id="acme",
        entry_id=v.id,
        updated_by="ciso@acme.example",
        status="decommissioned",
    )
    with pytest.raises(sa_mod.ServiceAccountError):
        sa_mod.record_rotation(
            tenant_id="acme", entry_id=v.id, rotated_by="ops@acme.example"
        )


def test_cross_tenant_isolation():
    a = _mk(tenant="acme", name="ci-runner")
    b = _mk(tenant="globex", name="etl-snowflake", kind="etl",
            system_of_record="snowflake", credential_kind="oidc_sa",
            owner_email="data@globex.example",
            created_by="data@globex.example",
            scopes=["role:LOADER"])
    # Each tenant only sees their own entry.
    assert [e.id for e in sa_mod.list_entries(tenant_id="acme")] == [a.id]
    assert [e.id for e in sa_mod.list_entries(tenant_id="globex")] == [b.id]
    # Cross-tenant get returns None.
    assert sa_mod.get_entry(tenant_id="globex", entry_id=a.id) is None
    assert sa_mod.get_entry(tenant_id="acme", entry_id=b.id) is None
    # Cross-tenant update is a no-op.
    assert (
        sa_mod.update_entry(
            tenant_id="globex",
            entry_id=a.id,
            updated_by="evil@globex.example",
            owner_email="evil@globex.example",
        )
        is None
    )
    # Cross-tenant rotate is a no-op.
    assert (
        sa_mod.record_rotation(
            tenant_id="globex",
            entry_id=a.id,
            rotated_by="evil@globex.example",
        )
        is None
    )
    # Cross-tenant review is a no-op.
    assert (
        sa_mod.record_review(
            tenant_id="globex",
            entry_id=a.id,
            reviewed_by="evil@globex.example",
        )
        is None
    )
    # Cross-tenant archive is a no-op.
    assert (
        sa_mod.archive_entry(
            tenant_id="globex",
            entry_id=a.id,
            archived_by="evil@globex.example",
        )
        is None
    )
    # And the original entry remains untouched and active.
    again = sa_mod.get_entry(tenant_id="acme", entry_id=a.id)
    assert again is not None
    assert again.active is True
    assert again.owner_email == "secops@acme.example"
    assert again.version == 1


def test_validation_short_name():
    with pytest.raises(sa_mod.ServiceAccountError):
        _mk(name="x")


def test_validation_bad_name_chars():
    with pytest.raises(sa_mod.ServiceAccountError):
        _mk(name="bad name with spaces")


def test_validation_unknown_kind():
    with pytest.raises(sa_mod.ServiceAccountError):
        _mk(kind="zombie")


def test_validation_unknown_credential_kind():
    with pytest.raises(sa_mod.ServiceAccountError):
        _mk(credential_kind="telepathy")


def test_validation_bad_owner_email():
    with pytest.raises(sa_mod.ServiceAccountError):
        _mk(owner_email="not-an-email")


def test_validation_future_last_rotated_at():
    with pytest.raises(sa_mod.ServiceAccountError):
        _mk(last_rotated_at=datetime.utcnow() + timedelta(days=30))


def test_validation_duplicate_active_name():
    _mk(name="ci-runner")
    with pytest.raises(sa_mod.ServiceAccountError):
        _mk(name="ci-runner")


def test_validation_cadence_out_of_range():
    with pytest.raises(sa_mod.ServiceAccountError):
        _mk(rotation_cadence_days=1)
    with pytest.raises(sa_mod.ServiceAccountError):
        _mk(review_cadence_days=10_000)


def test_validation_bad_scope_chars():
    with pytest.raises(sa_mod.ServiceAccountError):
        _mk(scopes=["read repo"])  # space disallowed


def test_validation_too_many_scopes():
    with pytest.raises(sa_mod.ServiceAccountError):
        _mk(scopes=[f"scope-{i}" for i in range(sa_mod.MAX_SCOPES + 5)])


def test_status_filter():
    a = _mk(name="ci-a")
    b = _mk(name="ci-b")
    sa_mod.update_entry(
        tenant_id="acme",
        entry_id=b.id,
        updated_by="ciso@acme.example",
        status="suspended",
    )
    actives = sa_mod.list_entries(tenant_id="acme", status_filter="active")
    suspended = sa_mod.list_entries(tenant_id="acme", status_filter="suspended")
    assert [e.id for e in actives] == [a.id]
    assert [e.id for e in suspended] == [b.id]
