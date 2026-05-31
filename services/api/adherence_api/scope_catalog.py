"""Canonical scope catalog: METHOD + path prefix -> required scope.

API keys carry a comma-separated allowlist of fine-grained scopes (see
``adherence_common.api_keys``). Historically only ``/v1/gdpr/*`` enforced
that allowlist; every other mutating route relied solely on coarse role
checks. That made it impossible for an enterprise buyer to mint a key
that, for example, may write predictions but may not manage members or
mutate retention policy.

This module centralises the route -> scope mapping so a single piece of
middleware can enforce it consistently across every route in the API,
and so the catalog can be introspected via ``/v1/auth/scopes``.

Design notes
------------
* The catalog is **deny-by-default for keys that carry scopes**: if a
  DB-backed key has a non-empty scope set, every mutating request must
  match a scope in its allowlist. Keys with an empty scope set keep the
  legacy behaviour ("role check is the only gate") so existing
  deployments do not break on upgrade.
* JWT principals and legacy env-mapped API keys do not carry scopes and
  are unaffected: role checks remain the source of truth for them.
* Admin role keys with scopes still must match (otherwise scopes on an
  admin key would be meaningless); admin role on a *scopeless* key
  bypasses scope enforcement.
* Read endpoints (``GET``) are mapped to ``*:read`` scopes so a key
  scoped to writes alone cannot exfiltrate via read paths either.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class ScopeRule:
    method: str            # "GET" / "POST" / "PUT" / "PATCH" / "DELETE" / "*"
    prefix: str            # path prefix, e.g. "/v1/predict"
    scope: str             # canonical scope token, e.g. "predict:write"
    description: str = ""


# Order matters: first match wins. Put longer/more specific prefixes
# first so e.g. ``/v1/admin/api-keys`` matches before ``/v1/admin``.
_CATALOG: tuple[ScopeRule, ...] = (
    # ----- Health / docs / metrics: never gated by scope.
    # (These are also exempted by EXEMPT_PREFIXES below.)

    # ----- Predict / forecast / explain (read-mostly inference surface)
    ScopeRule("POST", "/v1/predict", "predict:write", "Run inference"),
    ScopeRule("GET",  "/v1/predict", "predict:read",  "Read prediction history"),
    ScopeRule("POST", "/v1/forecast", "predict:write", "Run forecasts"),
    ScopeRule("GET",  "/v1/forecast", "predict:read",  "Read forecasts"),
    ScopeRule("GET",  "/v1/explain", "predict:read",   "Read SHAP / global explanations"),
    ScopeRule("GET",  "/v1/drift",   "predict:read",   "Read drift reports"),
    ScopeRule("GET",  "/v1/plots",   "predict:read",   "Read calibration / importance plots"),

    # ----- Cohort + interventions
    ScopeRule("*",    "/v1/cohort/export", "cohort:export", "Export cohort risk to CSV/JSON"),
    ScopeRule("GET",  "/v1/cohort",        "cohort:read",   "Read population cohort risk"),
    ScopeRule("POST", "/v1/interventions", "interventions:write", "Create or schedule interventions"),
    ScopeRule("PUT",  "/v1/interventions", "interventions:write", "Update interventions"),
    ScopeRule("PATCH","/v1/interventions", "interventions:write", "Update interventions"),
    ScopeRule("DELETE","/v1/interventions","interventions:write", "Cancel interventions"),
    ScopeRule("GET",  "/v1/interventions", "interventions:read",  "Read intervention history"),
    ScopeRule("POST", "/v1/mutes", "interventions:write", "Mute user notifications"),
    ScopeRule("DELETE","/v1/mutes","interventions:write", "Unmute user notifications"),
    ScopeRule("GET",  "/v1/mutes", "interventions:read",  "List active mutes"),

    # ----- Experiments + training
    ScopeRule("*",    "/v1/experiments", "experiments:write", "Manage experiments"),
    ScopeRule("POST", "/v1/train", "models:write", "Trigger model training"),
    ScopeRule("PUT",  "/v1/train", "models:write", "Update training jobs"),
    ScopeRule("GET",  "/v1/train", "models:read",  "Read training jobs"),

    # ----- Webhooks + outbound
    ScopeRule("*",    "/v1/webhooks", "webhooks:write", "Manage webhook subscriptions"),
    ScopeRule("*",    "/v1/outbound", "webhooks:write", "Manage outbound delivery"),

    # ----- GDPR (existing inline checks remain; we mirror them here so
    # /v1/auth/scopes shows the canonical names)
    ScopeRule("GET",    "/v1/gdpr", "gdpr:read",  "Export user data (GDPR Art. 15)"),
    ScopeRule("DELETE", "/v1/gdpr", "gdpr:erase", "Erase user data (GDPR Art. 17)"),

    # ----- Workspace administration: every mutation here is a deal-
    # blocker if a scoped key can bypass it.
    ScopeRule("*", "/v1/admin/api-keys",        "admin:keys",      "Manage API keys"),
    ScopeRule("*", "/v1/admin/sessions",        "admin:sessions",  "Manage user sessions"),
    ScopeRule("*", "/v1/admin/mfa",             "admin:mfa",       "Manage admin MFA"),
    ScopeRule("*", "/v1/admin/sso",             "admin:sso",       "Configure SSO"),
    ScopeRule("*", "/v1/admin/memberships",     "admin:members",   "Manage workspace members"),
    ScopeRule("*", "/v1/admin/session-policy",  "admin:policy",    "Manage session policy"),
    ScopeRule("*", "/v1/admin/pii-policy",      "admin:policy",    "Manage PII redaction policy"),
    ScopeRule("*", "/v1/admin/residency",       "admin:policy",    "Manage data residency"),
    ScopeRule("*", "/v1/admin/api-key-policy",  "admin:policy",    "Manage API key TTL policy"),
    ScopeRule("*", "/v1/admin/retention",       "admin:policy",    "Manage retention policy"),
    ScopeRule("*", "/v1/admin/break-glass",     "admin:break_glass","Use break-glass access"),
    ScopeRule("*", "/v1/admin/legal-hold",      "admin:legal_hold","Manage legal holds"),
    ScopeRule("*", "/v1/admin/ip-allowlist",    "admin:network",   "Manage tenant IP allowlist"),
    ScopeRule("*", "/v1/admin/outbound-allowlist", "admin:network","Manage outbound host allowlist"),
    ScopeRule("*", "/v1/admin/quota",           "admin:billing",   "Manage seat quota / billing"),
    ScopeRule("GET","/v1/admin/audit",          "admin:audit",     "Read audit log"),
    ScopeRule("*", "/v1/admin/siem",           "admin:network",   "Manage SIEM audit drain"),
    ScopeRule("*", "/v1/admin/policies",        "admin:policy",    "Manage risk-tier policies"),
    ScopeRule("POST","/v1/admin/token",         "admin:keys",      "Mint short-lived JWT"),
    ScopeRule("GET","/v1/admin/models",         "models:read",     "List registered models"),
)


# Paths that are always exempt from scope enforcement. These mirror the
# IP allowlist exemptions so operator probes and login flows never lock
# themselves out.
EXEMPT_PREFIXES: tuple[str, ...] = (
    "/v1/health", "/healthz", "/readyz", "/metrics",
    "/openapi.json", "/docs", "/redoc",
    "/v1/admin/sso",   # SSO sign-in must reach API before tenant context exists
    "/v1/auth/scopes", # introspection must be reachable to discover scopes
)


def required_scope(method: str, path: str) -> str | None:
    """Return the canonical scope a request must hold, or None if the
    route is not catalogued (in which case scope enforcement is skipped
    and the role checks on the route are the only gate).
    """
    m = method.upper()
    for rule in _CATALOG:
        if rule.prefix and path.startswith(rule.prefix):
            if rule.method == "*" or rule.method == m:
                return rule.scope
    return None


def all_rules() -> list[dict]:
    """Catalog dump for the introspection endpoint."""
    return [
        {
            "method": r.method,
            "prefix": r.prefix,
            "scope": r.scope,
            "description": r.description,
        }
        for r in _CATALOG
    ]


def all_scopes() -> list[str]:
    """Unique sorted list of canonical scope tokens."""
    return sorted({r.scope for r in _CATALOG})


def is_exempt(path: str, exempt: Iterable[str] = EXEMPT_PREFIXES) -> bool:
    return any(path.startswith(p) for p in exempt)
