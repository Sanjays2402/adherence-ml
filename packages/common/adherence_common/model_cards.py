"""Per-tenant AI Transparency Register (model cards).

Enterprise procurement (EU AI Act Article 13 transparency, NIST AI RMF
"MAP" function, ISO/IEC 42001 AI management, FDA Good Machine Learning
Practice principle 9, HHS NPRM 1557 on algorithmic discrimination) all
ask the vendor to point at a single durable record of which AI models
are in service for *this customer*: what the model does, what it was
trained on, how it was evaluated, who owns it, whether it is approved
for PHI, and when it was last validated.  This module is that record.

Strict tenant scoping: every read and write filters on ``tenant_id``;
there is no cross-tenant code path.  Each model card has at most one
active version in force per tenant at a time per ``(model_name,
model_version)`` pair.  Registering a new card supersedes the prior
active row for the same ``(model_name, model_version)`` with an audit
trail (archived_by, archived_at, reason, superseded_by_id) so the
historical lineage stays immutable.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text, select

from adherence_common.db import Base, session


MIN_NAME_LEN = 2
MAX_NAME_LEN = 128
MAX_VERSION_LEN = 64
MAX_OWNER_LEN = 128
MAX_INTENDED_USE_LEN = 4096
MAX_TRAINING_DATA_LEN = 4096
MAX_EVAL_LEN = 4096
MAX_LIMITATIONS_LEN = 4096
MAX_NOTES_LEN = 4096
MAX_URL_LEN = 512
MAX_REASON_LEN = 256

SENSITIVITY_VALUES = ("none", "low", "medium", "high", "phi")
FAIRNESS_VALUES = ("not_assessed", "in_progress", "assessed", "remediation")


class ModelCardError(ValueError):
    """Raised when a model card input is invalid."""


def _name(s):
    if s is None:
        raise ModelCardError("model_name is required")
    t = str(s).strip()
    if len(t) < MIN_NAME_LEN:
        raise ModelCardError("model_name must be at least %d characters" % MIN_NAME_LEN)
    if len(t) > MAX_NAME_LEN:
        raise ModelCardError("model_name must be at most %d characters" % MAX_NAME_LEN)
    return t


def _version(s):
    if s is None:
        raise ModelCardError("model_version is required")
    t = str(s).strip()
    if not t:
        raise ModelCardError("model_version is required")
    if len(t) > MAX_VERSION_LEN:
        raise ModelCardError("model_version must be at most %d characters" % MAX_VERSION_LEN)
    return t


def _owner(s):
    if s is None:
        raise ModelCardError("owner is required")
    t = str(s).strip()
    if not t:
        raise ModelCardError("owner is required")
    if len(t) > MAX_OWNER_LEN:
        raise ModelCardError("owner must be at most %d characters" % MAX_OWNER_LEN)
    return t


def _text(s, field, max_len):
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    if len(t) > max_len:
        raise ModelCardError("%s must be at most %d characters" % (field, max_len))
    return t


def _url(s):
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    if len(t) > MAX_URL_LEN:
        raise ModelCardError("model_card_url must be at most %d characters" % MAX_URL_LEN)
    low = t.lower()
    if not (low.startswith("https://") or low.startswith("http://")):
        raise ModelCardError("model_card_url must be an http(s) URL")
    return t


def _sensitivity(s):
    t = (s or "none").strip().lower()
    if t not in SENSITIVITY_VALUES:
        raise ModelCardError(
            "training_data_sensitivity must be one of %s" % ", ".join(SENSITIVITY_VALUES)
        )
    return t


def _fairness(s):
    t = (s or "not_assessed").strip().lower()
    if t not in FAIRNESS_VALUES:
        raise ModelCardError(
            "fairness_status must be one of %s" % ", ".join(FAIRNESS_VALUES)
        )
    return t


def _coerce_dt(value, field):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.replace(microsecond=0)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(s)
        except ValueError as exc:
            raise ModelCardError("%s is not a valid ISO 8601 timestamp" % field) from exc
        if dt.tzinfo is not None:
            dt = dt.astimezone(tz=None).replace(tzinfo=None)
        return dt.replace(microsecond=0)
    raise ModelCardError("%s must be an ISO 8601 timestamp" % field)


class ModelCard(Base):
    """One AI model card, scoped to a tenant."""

    __tablename__ = "ai_model_cards"
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    model_name = Column(String(MAX_NAME_LEN), nullable=False, index=True)
    model_version = Column(String(MAX_VERSION_LEN), nullable=False)
    owner = Column(String(MAX_OWNER_LEN), nullable=False)
    intended_use = Column(Text, nullable=True)
    training_data_summary = Column(Text, nullable=True)
    training_data_sensitivity = Column(String(16), nullable=False, default="none")
    evaluation_summary = Column(Text, nullable=True)
    limitations = Column(Text, nullable=True)
    phi_suitable = Column(Boolean, nullable=False, default=False)
    fairness_status = Column(String(32), nullable=False, default="not_assessed")
    last_validated_at = Column(DateTime, nullable=True, index=True)
    model_card_url = Column(String(MAX_URL_LEN), nullable=True)
    notes = Column(Text, nullable=True)
    version = Column(Integer, default=1, nullable=False)
    created_by = Column(String(128), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    archived_by = Column(String(128), nullable=True)
    archived_at = Column(DateTime, nullable=True, index=True)
    archive_reason = Column(String(MAX_REASON_LEN), nullable=True)
    superseded_by_id = Column(Integer, nullable=True)


@dataclass(frozen=True)
class ModelCardView:
    id: int
    tenant_id: str
    model_name: str
    model_version: str
    owner: str
    intended_use: Optional[str]
    training_data_summary: Optional[str]
    training_data_sensitivity: str
    evaluation_summary: Optional[str]
    limitations: Optional[str]
    phi_suitable: bool
    fairness_status: str
    last_validated_at: Optional[str]
    model_card_url: Optional[str]
    notes: Optional[str]
    version: int
    status: str
    created_by: str
    created_at: str
    archived_by: Optional[str]
    archived_at: Optional[str]
    archive_reason: Optional[str]
    superseded_by_id: Optional[int]
    active: bool


def _status(row):
    if row.archived_at is not None:
        return "superseded"
    return "active"


def _to_view(row):
    return ModelCardView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        model_name=str(row.model_name),
        model_version=str(row.model_version),
        owner=str(row.owner),
        intended_use=(str(row.intended_use) if row.intended_use else None),
        training_data_summary=(
            str(row.training_data_summary) if row.training_data_summary else None
        ),
        training_data_sensitivity=str(row.training_data_sensitivity or "none"),
        evaluation_summary=(
            str(row.evaluation_summary) if row.evaluation_summary else None
        ),
        limitations=(str(row.limitations) if row.limitations else None),
        phi_suitable=bool(row.phi_suitable),
        fairness_status=str(row.fairness_status or "not_assessed"),
        last_validated_at=(
            row.last_validated_at.isoformat() if row.last_validated_at else None
        ),
        model_card_url=(str(row.model_card_url) if row.model_card_url else None),
        notes=(str(row.notes) if row.notes else None),
        version=int(row.version or 1),
        status=_status(row),
        created_by=str(row.created_by),
        created_at=row.created_at.isoformat() if row.created_at else "",
        archived_by=(str(row.archived_by) if row.archived_by else None),
        archived_at=(row.archived_at.isoformat() if row.archived_at else None),
        archive_reason=(str(row.archive_reason) if row.archive_reason else None),
        superseded_by_id=(int(row.superseded_by_id) if row.superseded_by_id else None),
        active=(row.archived_at is None),
    )


def list_cards(*, tenant_id, include_archived=False, limit=200, offset=0):
    tid = (tenant_id or "default")[:64]
    lim = max(1, min(int(limit), 500))
    off = max(0, int(offset))
    with session() as db:
        stmt = select(ModelCard).where(ModelCard.tenant_id == tid)
        if not include_archived:
            stmt = stmt.where(ModelCard.archived_at.is_(None))
        stmt = stmt.order_by(
            ModelCard.archived_at.is_(None).desc(),
            ModelCard.model_name.asc(),
            ModelCard.id.desc(),
        ).limit(lim).offset(off)
        rows = db.execute(stmt).scalars().all()
        return [_to_view(r) for r in rows]


def get_card(*, tenant_id, card_id):
    tid = (tenant_id or "default")[:64]
    with session() as db:
        row = db.execute(
            select(ModelCard).where(
                ModelCard.tenant_id == tid,
                ModelCard.id == int(card_id),
            )
        ).scalar_one_or_none()
        return _to_view(row) if row is not None else None


def get_active(*, tenant_id, model_name, model_version):
    """Return the in-force card for (name, version) for the tenant, or None."""
    tid = (tenant_id or "default")[:64]
    name = _name(model_name)
    ver = _version(model_version)
    with session() as db:
        row = db.execute(
            select(ModelCard).where(
                ModelCard.tenant_id == tid,
                ModelCard.model_name == name,
                ModelCard.model_version == ver,
                ModelCard.archived_at.is_(None),
            ).order_by(ModelCard.id.desc())
        ).scalars().first()
        return _to_view(row) if row is not None else None


def create_card(
    *,
    tenant_id,
    model_name,
    model_version,
    owner,
    intended_use=None,
    training_data_summary=None,
    training_data_sensitivity="none",
    evaluation_summary=None,
    limitations=None,
    phi_suitable=False,
    fairness_status="not_assessed",
    last_validated_at=None,
    model_card_url=None,
    notes=None,
    created_by,
    supersede_reason=None,
):
    tid = (tenant_id or "default")[:64]
    name = _name(model_name)
    ver = _version(model_version)
    own = _owner(owner)
    iu = _text(intended_use, "intended_use", MAX_INTENDED_USE_LEN)
    td = _text(training_data_summary, "training_data_summary", MAX_TRAINING_DATA_LEN)
    sens = _sensitivity(training_data_sensitivity)
    ev = _text(evaluation_summary, "evaluation_summary", MAX_EVAL_LEN)
    lim = _text(limitations, "limitations", MAX_LIMITATIONS_LEN)
    fair = _fairness(fairness_status)
    last_v = _coerce_dt(last_validated_at, "last_validated_at")
    url = _url(model_card_url)
    nts = _text(notes, "notes", MAX_NOTES_LEN)
    phi = bool(phi_suitable)
    if phi and sens != "phi":
        raise ModelCardError(
            "phi_suitable=true requires training_data_sensitivity=phi"
        )
    actor = (created_by or "unknown")[:128]
    archive_reason = (supersede_reason or "superseded by new model card")[:MAX_REASON_LEN]
    with session() as db:
        active_rows = db.execute(
            select(ModelCard).where(
                ModelCard.tenant_id == tid,
                ModelCard.model_name == name,
                ModelCard.model_version == ver,
                ModelCard.archived_at.is_(None),
            )
        ).scalars().all()
        now = datetime.utcnow()
        row = ModelCard(
            tenant_id=tid,
            model_name=name,
            model_version=ver,
            owner=own,
            intended_use=iu,
            training_data_summary=td,
            training_data_sensitivity=sens,
            evaluation_summary=ev,
            limitations=lim,
            phi_suitable=phi,
            fairness_status=fair,
            last_validated_at=last_v,
            model_card_url=url,
            notes=nts,
            version=1,
            created_by=actor,
            created_at=now,
        )
        db.add(row)
        db.flush()
        for prior in active_rows:
            prior.archived_by = actor
            prior.archived_at = now
            prior.archive_reason = archive_reason
            prior.superseded_by_id = int(row.id)
            row.version = max(row.version, int(prior.version or 1) + 1)
        db.commit()
        db.refresh(row)
        return _to_view(row)


def archive_card(*, tenant_id, card_id, archived_by, reason=None):
    tid = (tenant_id or "default")[:64]
    with session() as db:
        row = db.execute(
            select(ModelCard).where(
                ModelCard.tenant_id == tid,
                ModelCard.id == int(card_id),
                ModelCard.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        row.archived_by = (archived_by or "unknown")[:128]
        row.archived_at = datetime.utcnow()
        row.archive_reason = (reason or "retired")[:MAX_REASON_LEN]
        db.commit()
        db.refresh(row)
        return _to_view(row)


def counts(*, tenant_id):
    tid = (tenant_id or "default")[:64]
    with session() as db:
        rows = db.execute(
            select(ModelCard).where(ModelCard.tenant_id == tid)
        ).scalars().all()
        active = 0
        archived = 0
        phi = 0
        unvalidated = 0
        for r in rows:
            if r.archived_at is None:
                active += 1
                if bool(r.phi_suitable):
                    phi += 1
                if r.last_validated_at is None:
                    unvalidated += 1
            else:
                archived += 1
        return {
            "active": active,
            "archived": archived,
            "phi_suitable": phi,
            "unvalidated_active": unvalidated,
            "total": len(rows),
        }
