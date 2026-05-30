"""FastAPI app factory."""
from __future__ import annotations

from adherence_common.logging import configure_logging, get_logger
from adherence_common.sentry import init_sentry
from adherence_common.settings import get_settings
from adherence_common.telemetry import init_tracing
from adherence_common.version import __version__
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from adherence_api.middleware import RequestIdMiddleware
from adherence_api.ratelimit_middleware import RateLimitMiddleware
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
    policies as policies_route,
)

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
        ],
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.api_cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(RequestIdMiddleware)
    app.add_middleware(RateLimitMiddleware, settings=s)

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
    app.include_router(policies_route.router)
    app.include_router(mutes_route.router)
    log.info("api ready", version=__version__)
    return app
