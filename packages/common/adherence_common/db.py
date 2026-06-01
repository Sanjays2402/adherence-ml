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
    # Tamper-evident hash chain for admin-plane actions. ``row_hash`` is
    # sha256 over a canonical tuple of immutable row fields plus the
    # previous chained row's ``row_hash``. NULL ``prev_hash`` marks the
    # genesis row. See :mod:`adherence_common.admin_audit_chain` for the
    # write path (``assign_chain``) and verifier (``verify_chain``).
    prev_hash = Column(String(64), nullable=True)
    row_hash = Column(String(64), nullable=True, index=True)


class DoseOutcome(Base):
    """Ground-truth dose event reported by a partner (e.g. Med-Tracker).

    One row per scheduled dose with the observed outcome. Joined against
    PredictionAudit (via user_id + dose_id) to compute online metrics such
    as AUC/Brier/calibration on live traffic.

    ``tenant_id`` is set at write time from the inbound source -> tenant
    mapping. It is required for tenant-scoped reads on /v1/metrics/online
    so one workspace admin can never join their predictions against
    another workspace's ground-truth outcomes.
    """
    __tablename__ = "dose_outcomes"
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
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
    # Previous secret retained during a rotation overlap window so receivers
    # can verify either signature while they roll their stored secret over.
    secret_previous = Column(String(128), nullable=True)
    secret_previous_expires_at = Column(DateTime, nullable=True)
    event_types_csv = Column(String(256), nullable=True)
    active = Column(Integer, nullable=False, default=1)
    # Circuit breaker: track consecutive failed deliveries and auto-disable
    # a subscription once the count crosses a threshold so a dead receiver
    # does not burn retries forever. Reset to 0 on any successful 2xx.
    consecutive_failures = Column(Integer, nullable=False, default=0)
    disabled_at = Column(DateTime, nullable=True)
    disabled_reason = Column(String(255), nullable=True)
    # Tenant that created the subscription. Dispatch re-evaluates the
    # per-tenant outbound host allowlist against this value so a tenant
    # narrowing its egress policy retroactively blocks its own old rows.
    tenant_id = Column(String(64), nullable=False, default="default", index=True)
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
    # Denormalised tenant of the owning subscription. Persisted on the
    # delivery row itself so cross-tenant isolation can be enforced with
    # a single WHERE clause on every listing/replay/retention query
    # instead of an implicit join. New deliveries written by dispatch()
    # always populate this; in-place upgrades backfill via
    # _ensure_tenant_columns from webhook_subscriptions.tenant_id.
    tenant_id = Column(
        String(64), nullable=False, default="default", index=True,
    )
    event_type = Column(String(64), nullable=False, index=True)
    payload_json = Column(JSON, nullable=False)
    attempt = Column(Integer, nullable=False, default=0)
    status_code = Column(Integer, nullable=True)
    latency_ms = Column(Float, nullable=True)
    error = Column(Text, nullable=True)
    # State machine: queued -> success | failed | dead_letter | blocked.
    # A delivery is promoted from ``failed`` to ``dead_letter`` once all
    # retry attempts have been exhausted so operator dashboards can
    # distinguish a transient failure (will retry) from a giving-up
    # event that needs human attention or a manual replay.
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


class TenantOriginAllowlist(Base):
    """Per-tenant browser Origin / hostname allowlist for the JSON API.

    Buyers commonly need to lock browser-issued API traffic (XHR/fetch
    from a SaaS dashboard, a Retool app, a partner portal) to a known
    set of origins they control. This is independent of the deployment
    wide CORS allowlist: the deployment may publish wide CORS so any
    customer dashboard works out of the box, while individual
    workspaces can narrow browser callers to a small set of origins.

    Empty list = gate off for that tenant. When at least one row
    exists, any tenant-bound request that carries an ``Origin`` header
    (i.e. came from a browser fetch) must match a row, otherwise the
    request is rejected with HTTP 403.

    Match semantics:
    * ``https://app.example.com`` matches that scheme+host(+port) exactly.
    * ``https://*.example.com`` matches any subdomain of example.com but
      not the bare apex.
    * Server to server callers (no ``Origin`` header, e.g. curl, a
      backend job, the worker) are unaffected. Use the IP allowlist
      and API key scopes for those.
    """
    __tablename__ = "tenant_origin_allowlist"
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    origin = Column(String(255), nullable=False)
    label = Column(String(128), nullable=True)
    created_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class TenantOutboundHostAllowlist(Base):
    """Per-tenant allowlist of permitted outbound webhook destination hosts.

    Mirrors :class:`TenantIpAllowlist` for the egress direction. When a
    tenant has zero rows the per-tenant gate is OFF for that tenant
    (the global :setting:`outbound_host_allowlist` still applies). When
    at least one row exists, outbound webhook subscriptions owned by
    that tenant may only point at hostnames that match a row, evaluated
    both at subscription create/update time and on every dispatch.

    Match semantics are the same as the global allowlist:
    * ``api.example.com`` matches that host exactly.
    * ``.example.com`` matches any subdomain of example.com but not the
      bare apex.
    """
    __tablename__ = "tenant_outbound_host_allowlist"
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    host = Column(String(255), nullable=False)
    label = Column(String(128), nullable=True)
    created_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class TenantOidcGroupRoleMap(Base):
    """Per-tenant mapping from OIDC group claim values to internal roles.

    Enterprise IdPs (Okta, Azure AD, Google Workspace) provision access
    via group membership. This table lets a workspace owner declare
    "members of `okta:adherence-admins` get role `admin` in tenant
    `acme`" without changing global deployment settings. Rows are
    consulted by :func:`adherence_common.oidc.map_identity_to_principal`
    BEFORE the email-domain map, so a group match always wins.

    A row is uniquely identified by (tenant_id, group_claim). The
    ``priority`` column breaks ties when an identity belongs to several
    mapped groups (higher wins). ``role`` must be one of admin /
    service / viewer.
    """
    __tablename__ = "tenant_oidc_group_role_map"
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    group_claim = Column(String(255), nullable=False, index=True)
    role = Column(String(16), nullable=False)
    priority = Column(Integer, nullable=False, default=100)
    note = Column(String(255), nullable=True)
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
    ("dose_outcomes", "tenant_id"),
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
    # Tamper-evident hash chain on admin_audit_log (SOC2 CC7.2 /
    # ISO 27001 A.12.4.2). Existing rows are left with NULL hashes and
    # treated as the legacy prefix; the chain starts fresh from the
    # first row written after the migration runs.
    if "admin_audit_log" in existing_tables:
        cols = {c["name"] for c in insp.get_columns("admin_audit_log")}
        if "prev_hash" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE admin_audit_log ADD COLUMN prev_hash VARCHAR(64)"
                ))
        if "row_hash" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE admin_audit_log ADD COLUMN row_hash VARCHAR(64)"
                ))
            with engine.begin() as conn:
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS ix_admin_audit_log_row_hash "
                    "ON admin_audit_log(row_hash)"
                ))
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
        if "last_used_ip" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE api_key_records "
                    "ADD COLUMN last_used_ip VARCHAR(64)"
                ))
        if "last_used_user_agent" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE api_key_records "
                    "ADD COLUMN last_used_user_agent VARCHAR(256)"
                ))
    # Per-day usage row keeps the most recent source IP and User-Agent
    # so the admin panel can render a per-day, per-key trail without
    # cross-joining the request log table.
    if "api_key_usage_daily" in existing_tables:
        cols = {c["name"] for c in insp.get_columns("api_key_usage_daily")}
        if "last_seen_ip" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE api_key_usage_daily "
                    "ADD COLUMN last_seen_ip VARCHAR(64)"
                ))
        if "last_seen_user_agent" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE api_key_usage_daily "
                    "ADD COLUMN last_seen_user_agent VARCHAR(256)"
                ))
    # Webhook secret rotation overlap window.
    if "webhook_subscriptions" in existing_tables:
        cols = {c["name"] for c in insp.get_columns("webhook_subscriptions")}
        if "secret_previous" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE webhook_subscriptions "
                    "ADD COLUMN secret_previous VARCHAR(128)"
                ))
        if "secret_previous_expires_at" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE webhook_subscriptions "
                    "ADD COLUMN secret_previous_expires_at DATETIME"
                ))
        # Tenant scoping for outbound subscriptions so dispatch can
        # re-check the per-tenant host allowlist against the original
        # creator's tenant on every send.
        if "tenant_id" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE webhook_subscriptions "
                    "ADD COLUMN tenant_id VARCHAR(64) NOT NULL DEFAULT 'default'"
                ))
        # Circuit-breaker columns for outbound webhook subscriptions.
        if "consecutive_failures" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE webhook_subscriptions "
                    "ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0"
                ))
        if "disabled_at" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE webhook_subscriptions "
                    "ADD COLUMN disabled_at DATETIME"
                ))
        if "disabled_reason" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE webhook_subscriptions "
                    "ADD COLUMN disabled_reason VARCHAR(255)"
                ))
    # Backfill dose_outcomes.tenant_id from prediction_audit on (user_id,
    # dose_id) so existing ground-truth rows participate in tenant-scoped
    # /v1/metrics/online the moment the upgraded code starts. Rows with
    # no matching prediction stay on 'default' and are invisible to
    # tenant admins other than the deployment default tenant.
    if "dose_outcomes" in existing_tables and "prediction_audit" in existing_tables:
        with engine.begin() as conn:
            conn.execute(text(
                "UPDATE dose_outcomes "
                "SET tenant_id = COALESCE(( "
                "  SELECT pa.tenant_id FROM prediction_audit pa "
                "  WHERE pa.user_id = dose_outcomes.user_id "
                "  ORDER BY pa.created_at DESC LIMIT 1 "
                "), tenant_id) "
                "WHERE tenant_id = 'default'"
            ))

    # Denormalised tenant_id on webhook_deliveries: backfill from the
    # owning subscription so existing rows participate in tenant-scoped
    # queries the moment the upgraded code starts running.
    if "webhook_deliveries" in existing_tables:
        cols = {c["name"] for c in insp.get_columns("webhook_deliveries")}
        if "tenant_id" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE webhook_deliveries "
                    "ADD COLUMN tenant_id VARCHAR(64) NOT NULL DEFAULT 'default'"
                ))
                if "webhook_subscriptions" in existing_tables:
                    conn.execute(text(
                        "UPDATE webhook_deliveries AS d "
                        "SET tenant_id = COALESCE(( "
                        "  SELECT s.tenant_id FROM webhook_subscriptions s "
                        "  WHERE s.id = d.subscription_id "
                        "), 'default')"
                    ))

    # Workspace API key policy: optional admin-set cap on the number of
    # simultaneously-active keys (added after the original release).
    if "workspace_api_key_policy" in existing_tables:
        cols = {c["name"] for c in insp.get_columns("workspace_api_key_policy")}
        if "max_active_keys" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE workspace_api_key_policy "
                    "ADD COLUMN max_active_keys INTEGER"
                ))

    # Workspace quota: optional per-tenant override for the human member
    # seat cap. Added with the member-seat enforcement feature; older
    # rows fall back to the plan default when NULL.
    if "workspace_quota" in existing_tables:
        cols = {c["name"] for c in insp.get_columns("workspace_quota")}
        if "member_seats_override" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE workspace_quota "
                    "ADD COLUMN member_seats_override INTEGER"
                ))

    # SCIM token rotation overlap window. Older deployments created
    # ``scim_tokens`` without these columns; add them so a rotate call
    # against an upgraded service does not crash. All three columns are
    # nullable; absence means "never rotated".
    if "scim_tokens" in existing_tables:
        cols = {c["name"] for c in insp.get_columns("scim_tokens")}
        for new_col, ddl_type in (
            ("expires_at", "DATETIME"),
            ("rotated_at", "DATETIME"),
            ("rotated_from_id", "INTEGER"),
            ("rotated_to_id", "INTEGER"),
        ):
            if new_col not in cols:
                with engine.begin() as conn:
                    conn.execute(text(
                        f"ALTER TABLE scim_tokens ADD COLUMN {new_col} {ddl_type}"
                    ))


def init_db() -> None:
    # Ensure ORM models from sibling modules are imported so their tables
    # are registered on Base.metadata before create_all runs.
    from adherence_common import quota as _quota  # noqa: F401
    from adherence_common import revocation as _rev  # noqa: F401
    from adherence_common import memberships as _mem  # noqa: F401
    from adherence_common import session_policy as _sp  # noqa: F401
    from adherence_common import sso_enforcement as _sse  # noqa: F401
    from adherence_common import api_key_policy as _akp  # noqa: F401
    from adherence_common import retention_policy as _rp  # noqa: F401
    from adherence_common import break_glass as _bg  # noqa: F401
    from adherence_common import legal_hold as _lh  # noqa: F401
    from adherence_common import pii_policy as _pii  # noqa: F401
    from adherence_common import data_classification as _dc  # noqa: F401
    from adherence_common import siem as _siem  # noqa: F401
    from adherence_common import verified_domains as _vd  # noqa: F401
    from adherence_common import scim as _scim  # noqa: F401
    from adherence_common import access_reviews as _ar  # noqa: F401
    from adherence_common import legal_acceptance as _legal  # noqa: F401
    from adherence_common import model_approval as _ma  # noqa: F401
    from adherence_common import subprocessors as _subproc  # noqa: F401
    from adherence_common import caiq as _caiq  # noqa: F401
    from adherence_common import incidents as _inc  # noqa: F401
    from adherence_common import dsar as _dsar  # noqa: F401
    from adherence_common import api_deprecations as _apidep  # noqa: F401
    from adherence_common import support_access as _sa  # noqa: F401
    from adherence_common import purpose_of_use as _pou  # noqa: F401
    from adherence_common import invite_policy as _invp  # noqa: F401
    engine = _engine()
    Base.metadata.create_all(engine)
    try:
        _ensure_tenant_columns(engine)
    except Exception:
        # Migration is best-effort; surface real errors via subsequent queries.
        pass


def session() -> Session:
    return _session_factory()()
