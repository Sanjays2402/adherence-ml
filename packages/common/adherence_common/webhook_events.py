"""Canonical webhook event catalog.

Every outbound webhook event this API can emit must be registered here.
Subscriptions and ``dispatch()`` calls are validated against the
catalog so a typo in an event name does not silently drop deliveries
and so customers can introspect the full contract via
``GET /v1/webhooks/event-catalog`` during procurement review.

Design notes
------------
* The catalog is **global, not per-tenant**: a published event contract
  is part of the product surface area and must be the same for every
  customer (subscription matching remains tenant-scoped at the
  ``WebhookSubscription`` row level).
* Each entry carries a ``stability`` flag (``stable`` | ``beta``).
  Customers may subscribe to either, but the catalog endpoint marks
  beta events clearly so contracts can constrain deployments to
  ``stable`` only.
* The example payload is what receivers should expect. It is included
  verbatim in the introspection endpoint so a buyer can wire a test
  receiver before signing.
* The version field is the *event schema* version. We bump it when a
  backwards-incompatible payload change ships; the previous version
  may continue to be emitted in parallel under a new event name (e.g.
  ``run.created.v2``) to preserve contracts.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class WebhookEvent:
    event_type: str
    description: str
    stability: str           # "stable" | "beta"
    version: int             # schema version of the payload
    since: str               # YYYY-MM-DD first published
    payload_example: dict[str, Any] = field(default_factory=dict)
    payload_fields: tuple[tuple[str, str, str], ...] = ()
    # (name, type, description) tuples describing the payload schema
    # in a human-readable form for the catalog UI.


# Order matters only for catalog presentation. Keep grouped by family.
_CATALOG: tuple[WebhookEvent, ...] = (
    WebhookEvent(
        event_type="test.ping",
        description=(
            "Smoke event emitted by the workspace admin from the "
            "webhooks console to verify endpoint connectivity, signing, "
            "and IP allowlisting. Always safe to ignore in production "
            "receivers."
        ),
        stability="stable",
        version=1,
        since="2025-01-01",
        payload_example={
            "event": "test.ping",
            "delivery_id": 12345,
            "tenant_id": "acme",
            "fired_at": "2025-05-31T16:00:00Z",
            "note": "manual test from admin console",
        },
        payload_fields=(
            ("event", "string", "Always 'test.ping'."),
            ("delivery_id", "integer", "Unique delivery row id; use for dedupe."),
            ("tenant_id", "string", "Workspace that triggered the ping."),
            ("fired_at", "string", "ISO-8601 UTC timestamp."),
            ("note", "string", "Free-text label set by the admin (optional)."),
        ),
    ),
    WebhookEvent(
        event_type="intervention.recommended",
        description=(
            "Fired when the inference pipeline recommends a clinical "
            "intervention for a patient based on a fresh risk score. "
            "Includes patient external id, risk tier, and the model "
            "version that produced the decision. Receivers typically "
            "route this into a care-team task queue."
        ),
        stability="stable",
        version=1,
        since="2025-02-15",
        payload_example={
            "event": "intervention.recommended",
            "delivery_id": 12346,
            "tenant_id": "acme",
            "patient_external_id": "P-00042",
            "intervention_id": 991,
            "risk_tier": "high",
            "risk_score": 0.81,
            "model_version": "ridge-v7",
            "recommended_at": "2025-05-31T16:00:00Z",
        },
        payload_fields=(
            ("event", "string", "Always 'intervention.recommended'."),
            ("delivery_id", "integer", "Unique delivery row id."),
            ("tenant_id", "string", "Workspace owning the patient."),
            ("patient_external_id", "string", "Stable patient identifier as supplied by the customer."),
            ("intervention_id", "integer", "Internal intervention row id."),
            ("risk_tier", "string", "One of 'low', 'medium', 'high'."),
            ("risk_score", "number", "Calibrated probability in [0,1]."),
            ("model_version", "string", "Model used to score this patient."),
            ("recommended_at", "string", "ISO-8601 UTC."),
        ),
    ),
    WebhookEvent(
        event_type="run.created",
        description=(
            "Fired when a new inference run completes for a cohort or "
            "individual prediction request. Carries the run id so "
            "receivers can fetch detail via /v1/predict/{run_id}."
        ),
        stability="stable",
        version=1,
        since="2025-01-01",
        payload_example={
            "event": "run.created",
            "delivery_id": 12347,
            "tenant_id": "acme",
            "run_id": "r_01HXYZ",
            "kind": "predict",
            "rows": 1,
            "created_at": "2025-05-31T16:00:00Z",
        },
        payload_fields=(
            ("event", "string", "Always 'run.created'."),
            ("delivery_id", "integer", "Unique delivery row id."),
            ("tenant_id", "string", "Workspace that owns the run."),
            ("run_id", "string", "Run identifier; opaque to the receiver."),
            ("kind", "string", "'predict' | 'forecast' | 'batch'."),
            ("rows", "integer", "Number of rows scored in this run."),
            ("created_at", "string", "ISO-8601 UTC."),
        ),
    ),
    WebhookEvent(
        event_type="drift.detected",
        description=(
            "Fired when the online drift monitor crosses the configured "
            "threshold for a given feature or output distribution. "
            "Receivers typically open a ticket or page on-call."
        ),
        stability="beta",
        version=1,
        since="2025-04-01",
        payload_example={
            "event": "drift.detected",
            "delivery_id": 12348,
            "tenant_id": "acme",
            "feature": "days_since_last_refill",
            "metric": "psi",
            "value": 0.27,
            "threshold": 0.2,
            "window_hours": 24,
            "detected_at": "2025-05-31T16:00:00Z",
        },
        payload_fields=(
            ("event", "string", "Always 'drift.detected'."),
            ("delivery_id", "integer", "Unique delivery row id."),
            ("tenant_id", "string", "Workspace owning the monitored model."),
            ("feature", "string", "Feature or output name that drifted."),
            ("metric", "string", "Drift metric (psi, kl, ks, etc)."),
            ("value", "number", "Measured value of the metric."),
            ("threshold", "number", "Configured alert threshold."),
            ("window_hours", "integer", "Observation window."),
            ("detected_at", "string", "ISO-8601 UTC."),
        ),
    ),
    WebhookEvent(
        event_type="api_key.rotated",
        description=(
            "Fired when a workspace admin rotates an API key. Receivers "
            "can use this to update their secret stores or to alert "
            "security teams to unexpected rotations."
        ),
        stability="stable",
        version=1,
        since="2025-03-10",
        payload_example={
            "event": "api_key.rotated",
            "delivery_id": 12349,
            "tenant_id": "acme",
            "key_name": "ci-runner",
            "rotated_by": "alice@acme.com",
            "rotated_at": "2025-05-31T16:00:00Z",
        },
        payload_fields=(
            ("event", "string", "Always 'api_key.rotated'."),
            ("delivery_id", "integer", "Unique delivery row id."),
            ("tenant_id", "string", "Workspace owning the key."),
            ("key_name", "string", "Human-readable key label."),
            ("rotated_by", "string", "Actor email or principal id."),
            ("rotated_at", "string", "ISO-8601 UTC."),
        ),
    ),
    WebhookEvent(
        event_type="member.invited",
        description=(
            "Fired when an admin invites a new member to the workspace. "
            "Receivers can use this to provision downstream systems "
            "(JIRA, Slack channels) in lock-step with onboarding."
        ),
        stability="stable",
        version=1,
        since="2025-03-10",
        payload_example={
            "event": "member.invited",
            "delivery_id": 12350,
            "tenant_id": "acme",
            "invitee_email": "bob@acme.com",
            "role": "member",
            "invited_by": "alice@acme.com",
            "invited_at": "2025-05-31T16:00:00Z",
        },
        payload_fields=(
            ("event", "string", "Always 'member.invited'."),
            ("delivery_id", "integer", "Unique delivery row id."),
            ("tenant_id", "string", "Workspace receiving the new member."),
            ("invitee_email", "string", "Email address invited."),
            ("role", "string", "Initial role: owner | admin | member | viewer."),
            ("invited_by", "string", "Actor email or principal id."),
            ("invited_at", "string", "ISO-8601 UTC."),
        ),
    ),
)


CATALOG_VERSION = "2025-05-31"


def all_events() -> list[dict[str, Any]]:
    """Serialised catalog for the introspection endpoint."""
    out: list[dict[str, Any]] = []
    for ev in _CATALOG:
        out.append(
            {
                "event_type": ev.event_type,
                "description": ev.description,
                "stability": ev.stability,
                "version": ev.version,
                "since": ev.since,
                "payload_example": ev.payload_example,
                "payload_fields": [
                    {"name": n, "type": t, "description": d}
                    for n, t, d in ev.payload_fields
                ],
            }
        )
    return out


def known_event_types() -> set[str]:
    return {ev.event_type for ev in _CATALOG}


def stable_event_types() -> list[str]:
    return sorted(
        ev.event_type for ev in _CATALOG if ev.stability == "stable"
    )


def is_known(event_type: str) -> bool:
    return event_type in known_event_types()


def get(event_type: str) -> WebhookEvent | None:
    for ev in _CATALOG:
        if ev.event_type == event_type:
            return ev
    return None


def catalog_summary() -> dict[str, Any]:
    """Compact summary used by the catalog endpoint header."""
    return {
        "version": CATALOG_VERSION,
        "count": len(_CATALOG),
        "stable": len([e for e in _CATALOG if e.stability == "stable"]),
        "beta": len([e for e in _CATALOG if e.stability == "beta"]),
    }
