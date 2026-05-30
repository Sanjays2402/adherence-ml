"""Sentry SDK initialization for adherence-ml services.

Wires sentry-sdk with FastAPI + SQLAlchemy + RQ integrations when a DSN is
configured. Safe no-op when sentry-sdk is not installed or DSN is empty.

Designed to be called exactly once at process startup. Repeat calls are
idempotent (sentry_sdk.init is itself idempotent within a process).
"""
from __future__ import annotations

from typing import Any

from adherence_common.logging import get_logger

log = get_logger(__name__)

_initialized: bool = False


def _scrub_sensitive(event: dict[str, Any], hint: dict[str, Any]) -> dict[str, Any] | None:
    """before_send hook: drop common secrets from headers / extra before shipping."""
    try:
        req = event.get("request") or {}
        headers = req.get("headers") or {}
        if isinstance(headers, dict):
            for key in list(headers.keys()):
                lk = key.lower()
                if lk in {"authorization", "x-api-key", "cookie", "set-cookie", "proxy-authorization"}:
                    headers[key] = "[Filtered]"
        # Drop query strings that may carry api keys
        if "query_string" in req and isinstance(req["query_string"], str):
            qs = req["query_string"]
            if "api_key" in qs.lower() or "token" in qs.lower():
                req["query_string"] = "[Filtered]"
    except Exception:
        # Never let scrubbing crash the pipeline
        pass
    return event


def init_sentry(service_name: str) -> bool:
    """Initialize Sentry for the given service. Returns True if active.

    Pulls DSN, environment, release, sample rates from Settings. No-op if the
    sentry-sdk dependency is not available or DSN is empty.
    """
    global _initialized
    if _initialized:
        return True

    try:
        from adherence_common.settings import get_settings
        from adherence_common.version import __version__
    except Exception:
        return False

    s = get_settings()
    dsn = (s.sentry_dsn or "").strip()
    if not dsn:
        log.info("sentry disabled (no DSN)", service=service_name)
        return False

    try:
        import sentry_sdk
        from sentry_sdk.integrations.logging import LoggingIntegration
    except ImportError:
        log.warning("sentry DSN set but sentry-sdk not installed", service=service_name)
        return False

    integrations: list[Any] = [
        LoggingIntegration(level=None, event_level=None),  # capture via explicit calls only
    ]

    # Optional integrations; ignore failures (e.g. running in a slim container)
    try:
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
        integrations.extend([StarletteIntegration(), FastApiIntegration()])
    except Exception:
        pass
    try:
        from sentry_sdk.integrations.sqlalchemy import SqlalchemyIntegration
        integrations.append(SqlalchemyIntegration())
    except Exception:
        pass
    try:
        from sentry_sdk.integrations.rq import RqIntegration
        integrations.append(RqIntegration())
    except Exception:
        pass

    sentry_sdk.init(
        dsn=dsn,
        environment=s.sentry_environment or s.env,
        release=s.sentry_release or f"adherence-ml@{__version__}",
        traces_sample_rate=s.sentry_traces_sample_rate,
        profiles_sample_rate=s.sentry_profiles_sample_rate,
        send_default_pii=False,
        max_breadcrumbs=50,
        integrations=integrations,
        before_send=_scrub_sensitive,
    )
    sentry_sdk.set_tag("service", service_name)
    _initialized = True
    log.info(
        "sentry initialized",
        service=service_name,
        environment=s.sentry_environment or s.env,
        traces_sample_rate=s.sentry_traces_sample_rate,
    )
    return True


def is_initialized() -> bool:
    return _initialized


def reset_for_tests() -> None:
    """Test helper: clear the init flag. Does not unhook the SDK."""
    global _initialized
    _initialized = False
