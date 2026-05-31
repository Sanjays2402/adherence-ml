"""SQLAlchemy engine + ORM models (users, predictions, runs)."""
from __future__ import annotations

from datetime import datetime
from functools import lru_cache

from sqlalchemy import (
    JSON,
    Column,
    DateTime,
    Float,
    Integer,
    String,
    Text,
    create_engine,
    inspect,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from adherence_common.settings import get_settings


class Base(DeclarativeBase):
    pass


class PredictionRow(Base):
    __tablename__ = "predictions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    user_id = Column(String(64), index=True, nullable=False)
    dose_id = Column(String(64), index=True, nullable=False)
    scheduled_at = Column(DateTime, nullable=False)
    miss_probability = Column(Float, nullable=False)
    risk_tier = Column(String(16), nullable=False)
    model_version = Column(String(64), nullable=False)
    reasons = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class PredictionAudit(Base):
    """One row per /v1/predict (or batch item) call.

    Stores enough to debug regressions, compute online metrics later (when
    ground-truth `taken/missed` events arrive via webhook), and trace a
    response back to the caller and model version that produced it.
    """
    __tablename__ = "prediction_audit"
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    request_id = Column(String(32), index=True, nullable=False)
    route = Column(String(64), nullable=False)
    user_id = Column(String(64), index=True, nullable=False)
    caller = Column(String(64), index=True, nullable=False)
    caller_role = Column(String(16), nullable=False)
    model_name = Column(String(64), nullable=False)
    model_version = Column(String(64), nullable=False)
    shadow_model_name = Column(String(64), nullable=True)
    shadow_model_version = Column(String(64), nullable=True)
    n_doses = Column(Integer, nullable=False)
    mean_miss_prob = Column(Float, nullable=True)
    max_miss_prob = Column(Float, nullable=True)
    high_risk_count = Column(Integer, nullable=False, default=0)
    shadow_max_divergence = Column(Float, nullable=True)
    latency_ms = Column(Float, nullable=True)
    ok = Column(Integer, nullable=False, default=1)
    error = Column(Text, nullable=True)
    response_summary = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    # Tamper-evident hash chain. ``row_hash`` is sha256 over the row's canonical
    # field tuple plus ``prev_hash`` (the row_hash of the row with the previous
    # ``id``). A NULL ``prev_hash`` marks the genesis row. A verifier can walk
    # rows in id order and re-derive each row_hash to detect edits or deletes.
    prev_hash = Column(String(64), nullable=True)
    row_hash = Column(String(64), nullable=True, index=True)


class AdminAuditLog(Base):
    """One row per admin-plane action (token mint, api key create/revoke,
    model rollback, retention sweep, GDPR erase, etc).

    Distinct from ``prediction_audit`` (which records inference calls) so
    that compliance can answer 'who changed what' without sifting through
    high-volume prediction rows. ``target`` is a free-form resource id
    (api key name, model name, user_id), ``action`` is a short verb
    (``api_key.create``, ``model.rollback``, ``gdpr.erase``), ``details``
    is a JSON blob of request-shaped context with secrets already redacted.
    """
    __tablename__ = "admin_audit_log"
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    request_id = Column(String(32), index=True, nullable=True)
    action = Column(String(64), index=True, nullable=False)
    target = Column(String(128), index=True, nullable=True)
    caller = Column(String(64), index=True, nullable=False)
    caller_role = Column(String(16), nullable=False)
    ok = Column(Integer, nullable=False, default=1)
    error = Column(Text, nullable=True)
    details = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


class DoseOutcome(Base):
    """Ground-truth dose event reported by a partner (e.g. Med-Tracker).

    One row per scheduled dose with the observed outcome. Joined against
    PredictionAudit (via user_id + dose_id) to compute online metrics such
    as AUC/Brier/calibration on live traffic.
    """
    __tablename__ = "dose_outcomes"
    id = Column(Integer, primary_key=True, autoincrement=True)
    source = Column(String(32), nullable=False, default="medtracker")
    external_event_id = Column(String(64), unique=True, nullable=True, index=True)
    user_id = Column(String(64), index=True, nullable=False)
    dose_id = Column(String(64), index=True, nullable=False)
    scheduled_at = Column(DateTime, nullable=False, index=True)
    observed_at = Column(DateTime, nullable=True)
    outcome = Column(String(16), nullable=False)  # "taken" | "missed" | "late"
    delay_minutes = Column(Float, nullable=True)
    notes = Column(Text, nullable=True)
    received_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


class IdempotencyRecord(Base):
    """Stores cached responses keyed by Idempotency-Key + caller + route.

    Lets webhook callers safely retry POST /v1/predict and friends without
    causing duplicate audit rows or non-deterministic re-scoring. Replays
    return the original status code and body for `ttl_seconds`.
    """
    __tablename__ = "idempotency_records"
    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(128), nullable=False, index=True)
    caller = Column(String(64), nullable=False, index=True)
    route = Column(String(64), nullable=False)
    request_hash = Column(String(64), nullable=False)
    status_code = Column(Integer, nullable=False)
    response_json = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    expires_at = Column(DateTime, nullable=False, index=True)


class UserRiskPolicy(Base):
    """Per-user (or per-dose-class) overrides for risk-tier cutoffs.

    Default tiering uses global thresholds (low<0.3, medium<0.7, else high).
    Clinicians can store overrides so e.g. a transplant patient gets `high`
    at p>=0.4. `scope_type` is one of 'user' or 'dose_class'; `scope_id` is
    the user_id or dose_class string. Most-specific match wins (user beats
    class beats global).
    """
    __tablename__ = "user_risk_policies"
    id = Column(Integer, primary_key=True, autoincrement=True)
    scope_type = Column(String(16), nullable=False, index=True)
    scope_id = Column(String(64), nullable=False, index=True)
    low_max = Column(Float, nullable=False)
    medium_max = Column(Float, nullable=False)
    note = Column(Text, nullable=True)
    updated_by = Column(String(64), nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class QuietHoursPolicy(Base):
    """Per-user quiet-hours window during which interventions are suppressed
    or shifted to a non-disruptive channel.

    `start_hour` and `end_hour` are local-time hours (0..23) in `tz`. If
    `end_hour < start_hour` the window wraps midnight. Channels in
    `allowed_channels_csv` are still delivered during quiet hours (e.g.
    'email' only); everything else is deferred to `end_hour`.
    """
    __tablename__ = "quiet_hours_policies"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String(64), nullable=False, unique=True, index=True)
    tz = Column(String(64), nullable=False, default="UTC")
    start_hour = Column(Integer, nullable=False)
    end_hour = Column(Integer, nullable=False)
    allowed_channels_csv = Column(String(128), nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class InterventionDelivery(Base):
    """One row per recommended intervention surfaced to a caller.

    Records the action, target dose(s), and lifecycle state. Lets us
    suppress duplicate recommendations for the same (user, action) within
    a cooldown window, attribute outcomes to specific interventions, and
    expose ack metrics. The recommender endpoint inserts rows in state
    `recommended`; clients later flip them to `sent`, `snoozed`,
    `dismissed`, or `acted` via /v1/interventions/{id}/ack.
    """
    __tablename__ = "intervention_deliveries"
    id = Column(Integer, primary_key=True, autoincrement=True)
    request_id = Column(String(32), index=True, nullable=False)
    user_id = Column(String(64), index=True, nullable=False)
    action = Column(String(32), index=True, nullable=False)
    channel = Column(String(16), nullable=False)
    score = Column(Float, nullable=False)
    target_dose_ids_csv = Column(String(512), nullable=True)
    reason = Column(Text, nullable=True)
    state = Column(String(16), nullable=False, default="recommended", index=True)
    snooze_until = Column(DateTime, nullable=True)
    acked_by = Column(String(64), nullable=True)
    ack_note = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class NotificationBudget(Base):
    """Per-user daily limit on outbound intervention notifications.

    Used to prevent alert fatigue. The interventions endpoint counts how
    many deliveries the user has accrued today (UTC) and defers any
    additional recommended actions when the budget is exhausted. A
    missing row falls back to `default_daily_limit` from settings.
    """
    __tablename__ = "notification_budgets"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String(64), nullable=False, unique=True, index=True)
    daily_limit = Column(Integer, nullable=False)
    note = Column(Text, nullable=True)
    updated_by = Column(String(64), nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class WebhookSubscription(Base):
    """Outbound webhook subscription owned by a caller.

    Used to push high-risk intervention recommendations (and other events)
    to clinic / caregiver / Slack endpoints. Each subscription has a
    shared HMAC secret used to sign payloads (header
    ``X-Adherence-Signature: sha256=<hex>``) so receivers can verify the
    request originated from this service.

    ``event_types_csv`` is a comma-separated allowlist (e.g.
    ``intervention.recommended,intervention.high_risk``). An empty value
    means "all events".
    """
    __tablename__ = "webhook_subscriptions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(64), nullable=False, unique=True, index=True)
    url = Column(String(512), nullable=False)
    secret = Column(String(128), nullable=False)
    event_types_csv = Column(String(256), nullable=True)
    active = Column(Integer, nullable=False, default=1)
    created_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class WebhookDelivery(Base):
    """One row per attempted outbound webhook POST.

    Records the subscription, event type, request hash, attempt number,
    HTTP status, latency, and final state (queued/success/failed). Lets
    operators audit who got notified, find dropped deliveries, and replay
    via /v1/webhooks/outbound/deliveries.
    """
    __tablename__ = "webhook_deliveries"
    id = Column(Integer, primary_key=True, autoincrement=True)
    subscription_id = Column(Integer, nullable=False, index=True)
    event_type = Column(String(64), nullable=False, index=True)
    payload_json = Column(JSON, nullable=False)
    attempt = Column(Integer, nullable=False, default=0)
    status_code = Column(Integer, nullable=True)
    latency_ms = Column(Float, nullable=True)
    error = Column(Text, nullable=True)
    state = Column(String(16), nullable=False, default="queued", index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class UserMute(Base):
    """Per-user opt-out from intervention delivery.

    Distinct from QuietHoursPolicy (which is a recurring local-time window):
    a mute is a one-shot block valid until ``muted_until``. Use cases
    include a clinician acknowledging a hospital stay, a user requesting
    a vacation pause, or post-incident cool-down after a false alarm.

    When ``muted_until`` is in the past the row is treated as inactive
    but kept around so we can audit who set it and why.
    """
    __tablename__ = "user_mutes"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String(64), nullable=False, unique=True, index=True)
    muted_until = Column(DateTime, nullable=False, index=True)
    reason = Column(Text, nullable=True)
    set_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class Experiment(Base):
    """Definition of an A/B (or multi-arm) experiment.

    Variants and their traffic weights are stored as JSON. Assignment is
    deterministic per user (sha256 of ``salt + user_id`` mod weight sum)
    so the same user always lands in the same bucket across processes
    and restarts. ``state`` is one of ``draft``, ``running``, ``paused``,
    ``stopped``.
    """
    __tablename__ = "experiments"
    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(64), unique=True, nullable=False, index=True)
    description = Column(Text, nullable=True)
    variants_json = Column(JSON, nullable=False)
    salt = Column(String(64), nullable=False)
    state = Column(String(16), nullable=False, default="running", index=True)
    created_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class ExperimentExposure(Base):
    """One row per (experiment, user, variant) first-touch exposure.

    Deduplicated on (experiment_key, user_id) so a user appears once per
    experiment regardless of how many times they are scored.
    """
    __tablename__ = "experiment_exposures"
    id = Column(Integer, primary_key=True, autoincrement=True)
    experiment_key = Column(String(64), index=True, nullable=False)
    user_id = Column(String(64), index=True, nullable=False)
    variant = Column(String(64), index=True, nullable=False)
    context_json = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


class ExperimentEvent(Base):
    """Conversion / metric event tied to an experiment exposure.

    ``value`` is optional and lets callers log continuous metrics (e.g.
    latency, dose delay) alongside the boolean ``converted`` flag.
    """
    __tablename__ = "experiment_events"
    id = Column(Integer, primary_key=True, autoincrement=True)
    experiment_key = Column(String(64), index=True, nullable=False)
    user_id = Column(String(64), index=True, nullable=False)
    variant = Column(String(64), index=True, nullable=False)
    event_name = Column(String(64), index=True, nullable=False)
    value = Column(Float, nullable=True)
    metadata_json = Column("metadata", JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


class TenantIpAllowlist(Base):
    """Per-tenant IP / CIDR allowlist rows.

    Empty list = gate off for that tenant. When at least one row exists
    only requests whose client IP matches are accepted.
    """
    __tablename__ = "tenant_ip_allowlist"
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    cidr = Column(String(64), nullable=False)
    label = Column(String(128), nullable=True)
    created_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class JWTRevocation(Base):
    """JWT revocation entries: per-jti hard deny and per-principal bulk deny.

    Two row shapes share the table:

    * ``kind="jti"``: ``target_jti`` is the unique JWT id that must be
      rejected. Useful for revoking a single leaked/laptop-lost token.
    * ``kind="all"``: ``target_sub`` (and optional ``target_tenant``)
      define a principal; every JWT issued at or before ``not_before_iat``
      for that subject is rejected. Used by the "sign me out of every
      device" admin action and by the "deactivate user" flow.

    Rows are append-only. Re-issuing for the same principal simply adds a
    newer ``not_before_iat`` row; verifiers pick the max cutoff in range.
    The table is consulted on every JWT verify so it stays narrow and
    indexed; production deployments should pair this with a short jwt TTL
    so the working set stays small.
    """
    __tablename__ = "jwt_revocation"
    id = Column(Integer, primary_key=True, autoincrement=True)
    kind = Column(String(8), nullable=False, index=True)  # 'jti' | 'all'
    target_jti = Column(String(64), nullable=True, index=True)
    target_sub = Column(String(128), nullable=True, index=True)
    target_tenant = Column(String(64), nullable=True, index=True)
    not_before_iat = Column(Integer, nullable=True, index=True)
    reason = Column(String(128), nullable=True)
    revoked_by = Column(String(64), nullable=True)
    revoked_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


class TrainingRun(Base):
    __tablename__ = "training_runs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String(64), unique=True, nullable=False)
    model_version = Column(String(64), nullable=False)
    auc = Column(Float, nullable=True)
    pr_auc = Column(Float, nullable=True)
    brier = Column(Float, nullable=True)
    ece = Column(Float, nullable=True)
    n_rows = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    metadata_json = Column("metadata", JSON, nullable=True)


@lru_cache(maxsize=1)
def _engine():
    s = get_settings()
    return create_engine(s.db_url, future=True, pool_pre_ping=True)


@lru_cache(maxsize=1)
def _session_factory():
    return sessionmaker(bind=_engine(), expire_on_commit=False, future=True)


# Lightweight idempotent migrations: tables created by an earlier release
# do not have the multi-tenant columns. Adding them here lets fresh
# deployments and in-place upgrades converge without an alembic round-trip.
# Only handles ``ADD COLUMN`` of nullable / defaulted scalars; anything
# riskier still goes through alembic.
_TENANT_COLUMNS: tuple[tuple[str, str], ...] = (
    ("predictions", "tenant_id"),
    ("prediction_audit", "tenant_id"),
    ("api_key_records", "tenant_id"),
)


def _ensure_tenant_columns(engine) -> None:
    insp = inspect(engine)
    existing_tables = set(insp.get_table_names())
    for table, column in _TENANT_COLUMNS:
        if table not in existing_tables:
            continue
        cols = {c["name"] for c in insp.get_columns(table)}
        if column in cols:
            continue
        ddl = (
            f"ALTER TABLE {table} ADD COLUMN {column} VARCHAR(64) "
            f"NOT NULL DEFAULT 'default'"
        )
        with engine.begin() as conn:
            conn.execute(text(ddl))
    # Per-key IP/CIDR allowlist: nullable text column on api_key_records.
    if "api_key_records" in existing_tables:
        cols = {c["name"] for c in insp.get_columns("api_key_records")}
        if "ip_allowlist_csv" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE api_key_records "
                    "ADD COLUMN ip_allowlist_csv VARCHAR(1024)"
                ))
        if "rotated_at" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE api_key_records "
                    "ADD COLUMN rotated_at DATETIME"
                ))
        if "rotation_count" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE api_key_records "
                    "ADD COLUMN rotation_count INTEGER NOT NULL DEFAULT 0"
                ))


def init_db() -> None:
    # Ensure ORM models from sibling modules are imported so their tables
    # are registered on Base.metadata before create_all runs.
    from adherence_common import quota as _quota  # noqa: F401
    from adherence_common import revocation as _rev  # noqa: F401
    from adherence_common import memberships as _mem  # noqa: F401
    engine = _engine()
    Base.metadata.create_all(engine)
    try:
        _ensure_tenant_columns(engine)
    except Exception:
        # Migration is best-effort; surface real errors via subsequent queries.
        pass


def session() -> Session:
    return _session_factory()()
