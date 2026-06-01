"""Tests for the per-tenant AI Transparency Register (model cards)."""
from __future__ import annotations

import os
import tempfile

import pytest

_TMP = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP.close()
os.environ["ADHERENCE_DB_URL"] = "sqlite:///%s" % _TMP.name
os.environ.setdefault("JWT_SECRET", "x" * 32)

from sqlalchemy import delete  # noqa: E402

from adherence_common import model_cards as mc  # noqa: E402
from adherence_common.model_cards import ModelCard, ModelCardError  # noqa: E402
from adherence_common.db import init_db, session  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh():
    init_db()
    with session() as s:
        s.execute(delete(ModelCard))
        s.commit()
    yield
    with session() as s:
        s.execute(delete(ModelCard))
        s.commit()


def _baseline(**overrides):
    base = dict(
        model_name="adherence-rf",
        model_version="1.0.0",
        owner="ml-platform@acme",
        intended_use="Predict 30-day medication adherence risk.",
        training_data_summary="De-identified pharmacy claims, 2018-2023.",
        training_data_sensitivity="phi",
        evaluation_summary="AUROC 0.84 on held-out 2024 cohort.",
        limitations="Trained on US adults; not validated for pediatrics.",
        phi_suitable=True,
        fairness_status="assessed",
        last_validated_at="2026-04-01T00:00:00",
        model_card_url="https://docs.acme.example/cards/adherence-rf-1.0.0",
        notes="Initial registration.",
        created_by="model-owner@acme",
    )
    base.update(overrides)
    return base


def test_empty_register():
    assert mc.list_cards(tenant_id="acme") == []
    c = mc.counts(tenant_id="acme")
    assert c == {
        "active": 0,
        "archived": 0,
        "phi_suitable": 0,
        "unvalidated_active": 0,
        "total": 0,
    }


def test_create_and_round_trip():
    v = mc.create_card(tenant_id="acme", **_baseline())
    assert v.tenant_id == "acme"
    assert v.model_name == "adherence-rf"
    assert v.model_version == "1.0.0"
    assert v.phi_suitable is True
    assert v.training_data_sensitivity == "phi"
    assert v.fairness_status == "assessed"
    assert v.active is True
    assert v.status == "active"
    assert v.version == 1
    assert v.model_card_url.startswith("https://")

    fetched = mc.get_card(tenant_id="acme", card_id=v.id)
    assert fetched is not None
    assert fetched.id == v.id


def test_phi_flag_requires_phi_sensitivity():
    with pytest.raises(ModelCardError):
        mc.create_card(
            tenant_id="acme",
            **_baseline(phi_suitable=True, training_data_sensitivity="low"),
        )


def test_invalid_sensitivity_rejected():
    with pytest.raises(ModelCardError):
        mc.create_card(
            tenant_id="acme",
            **_baseline(training_data_sensitivity="extreme"),
        )


def test_invalid_fairness_rejected():
    with pytest.raises(ModelCardError):
        mc.create_card(
            tenant_id="acme",
            **_baseline(fairness_status="great"),
        )


def test_url_must_be_http():
    with pytest.raises(ModelCardError):
        mc.create_card(
            tenant_id="acme",
            **_baseline(model_card_url="ftp://x/y"),
        )


def test_supersede_archives_prior():
    first = mc.create_card(tenant_id="acme", **_baseline())
    second = mc.create_card(
        tenant_id="acme",
        **_baseline(owner="new-owner@acme", supersede_reason="ownership transfer"),
    )
    assert second.id != first.id
    assert second.active is True
    refetched_first = mc.get_card(tenant_id="acme", card_id=first.id)
    assert refetched_first is not None
    assert refetched_first.active is False
    assert refetched_first.status == "superseded"
    assert refetched_first.superseded_by_id == second.id
    assert refetched_first.archive_reason == "ownership transfer"
    assert second.version >= 2


def test_archive_returns_none_if_already_archived():
    v = mc.create_card(tenant_id="acme", **_baseline())
    archived = mc.archive_card(
        tenant_id="acme", card_id=v.id, archived_by="ops", reason="retired"
    )
    assert archived is not None
    assert archived.active is False
    again = mc.archive_card(
        tenant_id="acme", card_id=v.id, archived_by="ops", reason="retired"
    )
    assert again is None


def test_cross_tenant_isolation():
    a = mc.create_card(tenant_id="acme", **_baseline(model_name="acme-model"))
    b = mc.create_card(
        tenant_id="globex",
        **_baseline(model_name="globex-model", training_data_sensitivity="low", phi_suitable=False),
    )

    # Lists must not cross.
    acme_list = mc.list_cards(tenant_id="acme")
    globex_list = mc.list_cards(tenant_id="globex")
    assert [c.id for c in acme_list] == [a.id]
    assert [c.id for c in globex_list] == [b.id]

    # get_card is tenant-scoped: globex cannot read acme's row even by id.
    assert mc.get_card(tenant_id="globex", card_id=a.id) is None
    assert mc.get_card(tenant_id="acme", card_id=b.id) is None

    # archive on wrong tenant is a no-op.
    bad = mc.archive_card(
        tenant_id="globex", card_id=a.id, archived_by="bad", reason="x"
    )
    assert bad is None
    still_active = mc.get_card(tenant_id="acme", card_id=a.id)
    assert still_active is not None
    assert still_active.active is True

    # get_active is tenant-scoped.
    assert (
        mc.get_active(
            tenant_id="globex", model_name="acme-model", model_version="1.0.0"
        )
        is None
    )
    found = mc.get_active(
        tenant_id="acme", model_name="acme-model", model_version="1.0.0"
    )
    assert found is not None
    assert found.id == a.id


def test_counts_track_phi_and_unvalidated():
    mc.create_card(tenant_id="acme", **_baseline())
    mc.create_card(
        tenant_id="acme",
        **_baseline(
            model_name="adherence-rf",
            model_version="2.0.0",
            training_data_sensitivity="low",
            phi_suitable=False,
            last_validated_at=None,
        ),
    )
    c = mc.counts(tenant_id="acme")
    assert c["active"] == 2
    assert c["phi_suitable"] == 1
    assert c["unvalidated_active"] == 1
    assert c["total"] == 2
