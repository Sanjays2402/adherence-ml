"""FastAPI app factory."""
from __future__ import annotations

from adherence_common.logging import configure_logging, get_logger
from adherence_common.sentry import init_sentry
from adherence_common.settings import get_settings
from adherence_common.telemetry import init_tracing
from adherence_common.version import __version__
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from adherence_api.body_size_middleware import BodySizeLimitMiddleware
from adherence_api.middleware import RequestIdMiddleware
from adherence_api.ip_allowlist_middleware import IpAllowlistMiddleware
from adherence_api.origin_allowlist_middleware import OriginAllowlistMiddleware
from adherence_api.legal_acceptance_middleware import LegalAcceptanceMiddleware
from adherence_api.baa_enforce_middleware import BaaEnforcementMiddleware
from adherence_api.purpose_of_use_middleware import PurposeOfUseMiddleware
from adherence_api.ratelimit_middleware import RateLimitMiddleware
from adherence_api.scope_enforce_middleware import ScopeEnforceMiddleware
from adherence_api.routes import auth_scopes as auth_scopes_route
from adherence_api.routes import ip_allowlist as ip_allowlist_route
from adherence_api.routes import origin_allowlist as origin_allowlist_route
from adherence_api.routes import siem as siem_route
from adherence_api.routes import quota as quota_route
from adherence_api.routes import sso as sso_route
from adherence_api.routes import admin_mfa as admin_mfa_route
from adherence_api.routes import admin_sessions as admin_sessions_route
from adherence_api.routes import memberships as memberships_route
from adherence_api.routes import verified_domains as verified_domains_route
from adherence_api.routes import invite_policy as invite_policy_route
from adherence_api.routes import workspace_contacts as workspace_contacts_route
from adherence_api.routes import scim as scim_route
from adherence_api.routes import session_policy as session_policy_route
from adherence_api.routes import password_policy as password_policy_route
from adherence_api.routes import sso_enforcement as sso_enforcement_route
from adherence_api.routes import sso_group_roles as sso_group_roles_route
from adherence_api.routes import pii_policy as pii_policy_route
from adherence_api.routes import residency as residency_route
from adherence_api.routes import data_classification as data_classification_route
from adherence_api.routes import api_key_policy as api_key_policy_route
from adherence_api.routes import cmek as cmek_route
from adherence_api.routes import api_key_usage as api_key_usage_route
from adherence_api.routes import retention_policy as retention_policy_route
from adherence_api.routes import break_glass as break_glass_route
from adherence_api.routes import legal_hold as legal_hold_route
from adherence_api.routes import access_reviews as access_reviews_route
from adherence_api.routes import legal as legal_route
from adherence_api.routes import well_known as well_known_route
from adherence_api.routes import model_approval as model_approval_route
from adherence_api.routes import (
    admin,
    cohort,
    health,
    plots,
    predict,
    train,
    webhooks,
)
from adherence_api.routes import (
    audit as audit_route,
)
from adherence_api.routes import (
    cohort_export as cohort_export_route,
)
from adherence_api.routes import (
    drift as drift_route,
)
from adherence_api.routes import (
    experiments as experiments_route,
)
from adherence_api.routes import (
    explain as explain_route,
)
from adherence_api.routes import (
    forecast as forecast_route,
)
from adherence_api.routes import (
    gdpr as gdpr_route,
)
from adherence_api.routes import (
    interventions as interventions_route,
)
from adherence_api.routes import (
    metrics as metrics_route,
)
from adherence_api.routes import (
    mutes as mutes_route,
)
from adherence_api.routes import (
    outbound as outbound_route,
)
from adherence_api.routes import (
    outbound_host_allowlist as outbound_host_allowlist_route,
)
from adherence_api.routes import (
    webhook_catalog as webhook_catalog_route,
)
from adherence_api.routes import (
    policies as policies_route,
)
from adherence_api.security_headers_middleware import SecurityHeadersMiddleware
from adherence_api.api_deprecations_middleware import ApiDeprecationsMiddleware

log = get_logger(__name__)


def create_app() -> FastAPI:
    s = get_settings()
    configure_logging(level=s.log_level, fmt=s.log_format)
    init_sentry("adherence-api")
    init_tracing("adherence-api")

    app = FastAPI(
        title="adherence-ml",
        version=__version__,
        description=(
            "Predicts which medication doses a user is likely to miss in the next 24 hours. "
            "Backed by XGBoost + LightGBM ensemble with SHAP explanations."
        ),
        openapi_tags=[
            {"name": "predict", "description": "Inference endpoints"},
            {"name": "train", "description": "Training control (admin)"},
            {"name": "drift", "description": "Feature drift monitoring"},
            {"name": "plots", "description": "Calibration and importance plots"},
            {"name": "health", "description": "Liveness / readiness"},
            {"name": "admin", "description": "Auth and model management"},
            {"name": "webhooks", "description": "Outbound webhook callbacks"},
            {"name": "explain", "description": "Global model explainability (SHAP + gain)"},
            {"name": "cohort", "description": "Population-level risk aggregations"},
            {"name": "audit", "description": "Prediction audit log (admin)"},
            {"name": "interventions", "description": "Recommended caregiver/app actions per dose"},
            {"name": "policies", "description": "Admin risk-tier and quiet-hours policies"},
            {"name": "mutes", "description": "Per-user intervention mute (TTL opt-out)"},
            {"name": "gdpr", "description": "Per-user data export and erasure (GDPR)"},
            {"name": "workspace", "description": "Workspace members and email invitations"},
        ],
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.api_cors_origins,
        allow_methods=s.api_cors_methods,
        allow_headers=s.api_cors_headers,
        allow_credentials=s.api_cors_allow_credentials,
        expose_headers=["X-Request-ID"],
        max_age=s.api_cors_max_age_seconds,
    )
    app.add_middleware(RequestIdMiddleware)
    # Both run before route dispatch. Rate limit is added last so it
    # wraps outermost and runs first; scope enforcement runs just
    # before the route, after auth headers are present.
    # Legal acceptance gate runs before scope checks so a workspace that
    # owes a TOS/DPA gets a 451 with a clear remediation path instead of
    # a generic 403 about missing scopes. Read paths and /v1/legal stay
    # exempt (see middleware EXEMPT_PREFIXES) so a blocked tenant can
    # still discover what to accept.
    app.add_middleware(LegalAcceptanceMiddleware, settings=s)
    app.add_middleware(BaaEnforcementMiddleware, settings=s)
    # HIPAA Purpose of Use gate. Runs after legal acceptance and
    # before scope enforcement so a blocked tenant still sees the
    # legal-acceptance 451 first; once accepted, the POU 412 surfaces
    # for PHI-bound requests that forgot the X-Purpose-Of-Use header.
    app.add_middleware(PurposeOfUseMiddleware, settings=s)
    app.add_middleware(ScopeEnforceMiddleware)
    app.add_middleware(RateLimitMiddleware, settings=s)
    # IP allowlist gates tenant-bound traffic. Health/metrics/docs stay
    # exempt so locking down a tenant never bricks operator probes.
    # Per-tenant browser Origin allowlist. Runs alongside the IP
    # allowlist with the same exempt set: probe and trust surfaces stay
    # reachable; SSO and SCIM are excluded because they are reached by
    # IdP servers that never set a meaningful Origin.
    app.add_middleware(
        OriginAllowlistMiddleware,
        settings=s,
        exempt_prefixes=(
            "/v1/health", "/healthz", "/readyz", "/metrics",
            "/openapi.json", "/docs", "/redoc",
            "/.well-known",
            "/v1/admin/sso",
            "/scim/v2",
        ),
    )
    app.add_middleware(
        IpAllowlistMiddleware,
        settings=s,
        exempt_prefixes=(
            "/v1/health", "/healthz", "/readyz", "/metrics",
            "/openapi.json", "/docs", "/redoc",
            # Public trust-manifest endpoints must be reachable from
            # outside the customer's corporate range so a procurement
            # scanner can grab security.txt/security.json before any
            # contract or allowlist is in place.
            "/.well-known",
            # SSO sign-in must reach the API before the caller has a
            # tenant/IP context. Auth is enforced by IdP signature
            # verification on /oidc/exchange instead.
            "/v1/admin/sso",
            # SCIM 2.0 provisioning carries its own per-tenant bearer
            # token and is called from IdP egress IPs (Okta/Azure AD)
            # that the customer cannot pin to their corporate range.
            "/scim/v2",
        ),
    )
    app.add_middleware(SecurityHeadersMiddleware, settings=s)
    # Stamps RFC 8594 Sunset + draft Deprecation headers on every
    # response that matches a registered deprecation. Runs outside
    # the auth gates so even 401/403 responses carry the headers,
    # which is what SDK telemetry needs to see.
    app.add_middleware(ApiDeprecationsMiddleware, settings=s)
    # Body size cap runs last (closest to the wire) so oversize requests
    # short-circuit before any other middleware does work on them.
    app.add_middleware(BodySizeLimitMiddleware, settings=s)

    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        FastAPIInstrumentor().instrument_app(app)
    except Exception:
        pass

    app.include_router(health.router)
    app.include_router(predict.router)
    app.include_router(train.router)
    app.include_router(drift_route.router)
    app.include_router(plots.router)
    app.include_router(admin.router)
    app.include_router(api_key_usage_route.router)
    app.include_router(webhooks.router)
    app.include_router(explain_route.router)
    app.include_router(cohort.router)
    app.include_router(cohort_export_route.router)
    app.include_router(experiments_route.router)
    app.include_router(forecast_route.router)
    app.include_router(audit_route.router)
    app.include_router(interventions_route.router)
    app.include_router(metrics_route.router)
    app.include_router(outbound_route.router)
    app.include_router(outbound_host_allowlist_route.router)
    app.include_router(webhook_catalog_route.router)
    app.include_router(policies_route.router)
    app.include_router(mutes_route.router)
    app.include_router(gdpr_route.router)
    app.include_router(ip_allowlist_route.router)
    app.include_router(origin_allowlist_route.router)
    app.include_router(sso_route.router)
    app.include_router(admin_mfa_route.router)
    app.include_router(admin_sessions_route.router)
    app.include_router(memberships_route.router)
    app.include_router(verified_domains_route.router)
    app.include_router(invite_policy_route.router)
    app.include_router(workspace_contacts_route.router)
    app.include_router(scim_route.router)
    app.include_router(session_policy_route.router)
    app.include_router(password_policy_route.router)
    app.include_router(sso_enforcement_route.router)
    app.include_router(sso_group_roles_route.router)
    app.include_router(pii_policy_route.router)
    app.include_router(residency_route.router)
    app.include_router(data_classification_route.router)
    app.include_router(api_key_policy_route.router)
    app.include_router(cmek_route.router)
    app.include_router(retention_policy_route.router)
    app.include_router(break_glass_route.router)
    app.include_router(legal_hold_route.router)
    app.include_router(access_reviews_route.router)
    app.include_router(quota_route.router)
    app.include_router(auth_scopes_route.router)
    app.include_router(siem_route.router)
    app.include_router(legal_route.router)
    app.include_router(well_known_route.router)
    app.include_router(model_approval_route.router)
    from adherence_api.routes import subprocessors as subprocessors_route
    app.include_router(subprocessors_route.router)
    from adherence_api.routes import caiq as caiq_route
    app.include_router(caiq_route.router)
    from adherence_api.routes import incidents as incidents_route
    app.include_router(incidents_route.router)
    from adherence_api.routes import dsar as dsar_route
    app.include_router(dsar_route.router)
    from adherence_api.routes import api_deprecations as api_deprecations_route
    app.include_router(api_deprecations_route.router)
    from adherence_api.routes import well_known_deprecations as well_known_deprecations_route
    app.include_router(well_known_deprecations_route.router)
    from adherence_api.routes import support_access as support_access_route
    app.include_router(support_access_route.router)
    from adherence_api.routes import purpose_of_use as purpose_of_use_route
    app.include_router(purpose_of_use_route.router)
    from adherence_api.routes import phi_access as phi_access_route
    app.include_router(phi_access_route.router)
    from adherence_api.routes import ropa as ropa_route
    app.include_router(ropa_route.router)
    from adherence_api.routes import dpia as dpia_route
    app.include_router(dpia_route.router)
    from adherence_api.routes import baa as baa_route
    app.include_router(baa_route.router)
    from adherence_api.routes import bcdr as bcdr_route
    app.include_router(bcdr_route.router)
    from adherence_api.routes import pentests as pentests_route
    app.include_router(pentests_route.router)
    from adherence_api.routes import vendor_risk as vendor_risk_route
    app.include_router(vendor_risk_route.router)
    from adherence_api.routes import risk_register as risk_register_route
    app.include_router(risk_register_route.router)
    from adherence_api.routes import dual_control as dual_control_route
    app.include_router(dual_control_route.router)
    from adherence_api.routes import maintenance as maintenance_route
    app.include_router(maintenance_route.router)
    app.include_router(maintenance_route.public_router)
    from adherence_api.routes import sla as sla_route
    app.include_router(sla_route.router)
    app.include_router(sla_route.public_router)
    from adherence_api.routes import consents as consents_route
    app.include_router(consents_route.router)
    # Ensure quota + workspace tables exist before the first request.
    try:
        from adherence_common.db import init_db
        init_db()
    except Exception as exc:  # pragma: no cover - best effort
        log.warning("init_db_failed", error=str(exc))
    log.info("api ready", version=__version__)
    return app
