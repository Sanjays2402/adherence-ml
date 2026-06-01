"""Tests for the break-glass cross-tenant access log.

Pins two enterprise-relevant invariants:

* a break-glass event recorded for one tenant never leaks into another
  tenant's listing or count (tenant scoping at the query layer)
* an empty or too-short justification is rejected so vendors cannot
  silently log noise into a customer's review console.
"""
from __future__ import annotations

import os
import tempfile

import pytest

_TMP = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP.close()
os.environ["ADHERENCE_DB_URL"] = f"sqlite:///{_TMP.name}"
os.environ.setdefault("JWT_SECRET", "x" * 32)

from adherence_common.db import init_db, session  # noqa: E402
from adherence_common import break_glass as bg  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_db():
    init_db()
    from sqlalchemy import delete

    with session() as s:
        s.execute(delete(bg.BreakGlassEvent))
        s.commit()
    yield


def _rec(target: str, source: str = "vendor", caller: str = "ops@adherence.ml"):
    return bg.record(
        caller=caller,
        caller_role="superadmin",
        source_tenant=source,
        target_tenant=target,
        route="/v1/admin/users",
        method="GET",
        justification="incident INC-123 triage from on-call rotation",
        client_ip="10.0.0.5",
        request_id="req-abc",
    )


def test_record_roundtrip_returns_view():
    v = _rec("acme")
    assert v.id > 0
    assert v.target_tenant == "acme"
    assert v.justification.startswith("incident INC-123")
    assert v.client_ip == "10.0.0.5"
    assert v.request_id == "req-abc"


def test_cross_tenant_isolation_in_list():
    _rec("acme")
    _rec("acme")
    _rec("globex")

    acme = bg.list_events(target_tenant="acme")
    globex = bg.list_events(target_tenant="globex")
    other = bg.list_events(target_tenant="initech")

    assert len(acme) == 2
    assert all(e.target_tenant == "acme" for e in acme)
    assert len(globex) == 1
    assert globex[0].target_tenant == "globex"
    assert other == []


def test_cross_tenant_isolation_in_count():
    _rec("acme")
    _rec("acme")
    _rec("globex")
    assert bg.count_events(target_tenant="acme") == 2
    assert bg.count_events(target_tenant="globex") == 1
    assert bg.count_events(target_tenant="initech") == 0
    # fleet-wide (no filter) sees all
    assert bg.count_events() == 3


def test_listing_acme_does_not_leak_globex_rows():
    _rec("acme", caller="alice@adherence.ml")
    _rec("globex", caller="mallory@adherence.ml")
    rows = bg.list_events(target_tenant="acme", limit=100, offset=0)
    callers = {r.caller for r in rows}
    assert "mallory@adherence.ml" not in callers


def test_validate_justification_rejects_missing():
    with pytest.raises(bg.BreakGlassError):
        bg.validate_justification(None)
    with pytest.raises(bg.BreakGlassError):
        bg.validate_justification("   ")


def test_validate_justification_rejects_too_short():
    with pytest.raises(bg.BreakGlassError):
        bg.validate_justification("short")


def test_record_rejects_blank_justification():
    with pytest.raises(bg.BreakGlassError):
        bg.record(
            caller="ops@adherence.ml",
            caller_role="superadmin",
            source_tenant="vendor",
            target_tenant="acme",
            route="/v1/admin/users",
            method="GET",
            justification="",
        )


def test_pagination_orders_newest_first():
    for i in range(5):
        bg.record(
            caller=f"ops{i}@adherence.ml",
            caller_role="superadmin",
            source_tenant="vendor",
            target_tenant="acme",
            route="/v1/admin/users",
            method="GET",
            justification=f"event number {i} for ordering test",
        )
    page1 = bg.list_events(target_tenant="acme", limit=2, offset=0)
    page2 = bg.list_events(target_tenant="acme", limit=2, offset=2)
    assert len(page1) == 2
    assert len(page2) == 2
    assert page1[0].id > page1[1].id > page2[0].id > page2[1].id
