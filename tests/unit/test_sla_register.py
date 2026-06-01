"""Tests for the per-tenant SLA commitment register."""
from __future__ import annotations

import os
import tempfile

import pytest

_TMP = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP.close()
os.environ["ADHERENCE_DB_URL"] = "sqlite:///%s" % _TMP.name
os.environ.setdefault("JWT_SECRET", "x" * 32)

from datetime import datetime, timedelta  # noqa: E402

from sqlalchemy import delete  # noqa: E402

from adherence_common import sla_register as sla  # noqa: E402
from adherence_common.sla_register import SLACommitment, SLAError  # noqa: E402
from adherence_common.db import init_db, session  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh():
    init_db()
    with session() as s:
        s.execute(delete(SLACommitment))
        s.commit()
    yield
    with session() as s:
        s.execute(delete(SLACommitment))
        s.commit()


def _iso(offset_days):
    return (datetime.utcnow() + timedelta(days=offset_days)).replace(microsecond=0).isoformat()


def _baseline(**overrides):
    base = dict(
        contract_ref="MSA-2026-0001",
        plan="enterprise",
        uptime_pct=99.9,
        sev1_response_hours=1.0,
        sev2_response_hours=4.0,
        sev3_response_hours=8.0,
        sev4_response_hours=24.0,
        rto_minutes=240,
        rpo_minutes=60,
        effective_from=_iso(-1),
        effective_until=_iso(365),
        notes="Initial commitment",
        created_by="legal@acme",
    )
    base.update(overrides)
    return base


def test_empty_register():
    assert sla.list_commitments(tenant_id="acme") == []
    assert sla.current_commitment(tenant_id="acme") is None
    assert sla.counts(tenant_id="acme") == {
        "active": 0, "archived": 0, "in_force": 0, "total": 0
    }


def test_create_list_and_current():
    v = sla.create_commitment(tenant_id="acme", **_baseline())
    assert v.active is True
    assert v.version == 1
    assert v.status == "active"
    assert v.uptime_pct == 99.9
    assert v.rto_minutes == 240 and v.rpo_minutes == 60

    listed = sla.list_commitments(tenant_id="acme")
    assert len(listed) == 1 and listed[0].id == v.id

    cur = sla.current_commitment(tenant_id="acme")
    assert cur is not None and cur.id == v.id


def test_creating_new_supersedes_prior_active():
    v1 = sla.create_commitment(tenant_id="acme", **_baseline())
    v2 = sla.create_commitment(
        tenant_id="acme",
        **_baseline(
            contract_ref="MSA-2026-0002",
            uptime_pct=99.95,
            sev1_response_hours=0.5,
            supersede_reason="upgraded to platinum",
        ),
    )
    assert v2.id != v1.id
    assert v2.status == "active"
    assert v2.version >= 2

    all_rows = sla.list_commitments(tenant_id="acme", include_archived=True)
    by_id = {r.id: r for r in all_rows}
    assert by_id[v1.id].active is False
    assert by_id[v1.id].archived_by == "legal@acme"
    assert by_id[v1.id].archive_reason == "upgraded to platinum"
    assert by_id[v1.id].superseded_by_id == v2.id

    cur = sla.current_commitment(tenant_id="acme")
    assert cur is not None and cur.id == v2.id


def test_archive_commitment():
    v = sla.create_commitment(tenant_id="acme", **_baseline())
    out = sla.archive_commitment(
        tenant_id="acme",
        commitment_id=v.id,
        archived_by="legal@acme",
        reason="contract terminated",
    )
    assert out is not None
    assert out.active is False
    assert out.archive_reason == "contract terminated"
    assert sla.current_commitment(tenant_id="acme") is None
    assert sla.archive_commitment(
        tenant_id="acme",
        commitment_id=v.id,
        archived_by="legal@acme",
    ) is None


def test_strict_tenant_isolation():
    """Cross-tenant reads and writes must never see each other's rows."""
    acme = sla.create_commitment(tenant_id="acme", **_baseline())
    initech = sla.create_commitment(
        tenant_id="initech",
        **_baseline(contract_ref="MSA-INT-001", uptime_pct=99.5),
    )

    assert [r.id for r in sla.list_commitments(tenant_id="acme")] == [acme.id]
    assert [r.id for r in sla.list_commitments(tenant_id="initech")] == [initech.id]

    assert sla.get_commitment(tenant_id="acme", commitment_id=initech.id) is None
    assert sla.get_commitment(tenant_id="initech", commitment_id=acme.id) is None

    assert sla.archive_commitment(
        tenant_id="acme",
        commitment_id=initech.id,
        archived_by="attacker@acme",
    ) is None
    still = sla.get_commitment(tenant_id="initech", commitment_id=initech.id)
    assert still is not None and still.active is True

    assert sla.current_commitment(tenant_id="acme").id == acme.id
    assert sla.current_commitment(tenant_id="initech").id == initech.id

    sla.create_commitment(
        tenant_id="acme",
        **_baseline(contract_ref="MSA-2026-0003"),
    )
    initech_after = sla.current_commitment(tenant_id="initech")
    assert initech_after is not None and initech_after.id == initech.id


def test_validation_rejects_bad_inputs():
    with pytest.raises(SLAError):
        sla.create_commitment(tenant_id="acme", **_baseline(uptime_pct=89.0))
    with pytest.raises(SLAError):
        sla.create_commitment(tenant_id="acme", **_baseline(uptime_pct=100.5))
    with pytest.raises(SLAError):
        sla.create_commitment(
            tenant_id="acme",
            **_baseline(sev1_response_hours=8.0, sev2_response_hours=4.0),
        )
    with pytest.raises(SLAError):
        sla.create_commitment(tenant_id="acme", **_baseline(rto_minutes=0))
    with pytest.raises(SLAError):
        sla.create_commitment(
            tenant_id="acme",
            **_baseline(effective_from=_iso(10), effective_until=_iso(5)),
        )
    with pytest.raises(SLAError):
        sla.create_commitment(tenant_id="acme", **_baseline(contract_ref=""))


def test_counts_reports_in_force_state():
    sla.create_commitment(
        tenant_id="acme",
        **_baseline(effective_from=_iso(-2), effective_until=_iso(30)),
    )
    c = sla.counts(tenant_id="acme")
    assert c["active"] == 1
    assert c["in_force"] == 1
    assert c["archived"] == 0
    assert c["total"] == 1
