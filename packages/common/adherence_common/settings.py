"""Pydantic settings sourced from environment / .env."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ADHERENCE_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    env: Literal["dev", "staging", "prod", "test"] = "dev"
    log_level: str = "INFO"
    log_format: Literal["json", "console"] = "json"

    # 0.0.0.0 is intentional: this service is designed to run inside a
    # container/pod where the network boundary is enforced by Helm
    # NetworkPolicy + Service, not by bind address.
    api_host: str = "0.0.0.0"  # nosec B104
    api_port: int = 7421
    # CORS hardening. Defaults are permissive for local dev but the
    # combination `allow_origins=["*"]` + `api_cors_allow_credentials=true`
    # is rejected at boot (browsers reject it too, per the Fetch spec).
    # In `env=prod`, wildcard origins / methods / headers are forbidden so
    # a misconfigured deploy fails fast instead of silently exposing the
    # API to any origin. Set explicit allowlists per environment via
    # `ADHERENCE_API_CORS_ORIGINS="https://app.example.com,https://admin.example.com"`.
    api_cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=lambda: ["*"])
    api_cors_methods: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    )
    api_cors_headers: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: [
            "Authorization",
            "Content-Type",
            "X-API-Key",
            "X-Request-ID",
            "Idempotency-Key",
        ]
    )
    api_cors_allow_credentials: bool = False
    api_cors_max_age_seconds: int = 600

    jwt_secret: str = "change-me-please-32-bytes-min-xxxxxxxx"
    jwt_alg: str = "HS256"
    jwt_ttl_seconds: int = 3600
    # Format: role:key,role:key,...
    api_keys: str = ""
    # Default tenant id stamped onto env-key callers and onto JWTs that
    # omit a ``tenant`` claim. Set to a stable string per deployment so
    # legacy callers land in a known tenant bucket rather than NULL.
    default_tenant: str = "default"

    db_url: str = "sqlite:///./adherence.db"
    redis_url: str = "redis://localhost:6379/0"
    mlflow_tracking_uri: str = "file:./mlruns"
    model_registry: Path = Path("./models/registry")

    drift_webhook_url: str | None = None
    drift_psi_threshold: float = 0.2

    # Request body size limit (DoS protection). Returns HTTP 413 when exceeded.
    # Per-route overrides via the with_max_body() decorator.
    body_size_limit_enabled: bool = True
    max_body_bytes: int = 1 * 1024 * 1024  # 1 MiB default; fits ~thousands of doses

    # Rate limiter (per-caller token bucket). Set rate_limit_enabled=false to disable.
    rate_limit_enabled: bool = True
    rate_limit_capacity: int = 120        # burst size
    rate_limit_refill_per_sec: float = 2.0  # sustained req/s
    rate_limit_admin_capacity: int = 30   # tighter cap for admin role
    rate_limit_admin_refill_per_sec: float = 0.5

    medtracker_base_url: str | None = None
    medtracker_api_key: str | None = None

    # Sentry error tracking. Empty DSN disables shipping. Other knobs are still
    # parsed so they can be set ahead of enabling Sentry without restart churn.
    sentry_dsn: str | None = None
    sentry_environment: str | None = None
    sentry_release: str | None = None
    sentry_traces_sample_rate: float = 0.0
    sentry_profiles_sample_rate: float = 0.0

    @field_validator("sentry_traces_sample_rate", "sentry_profiles_sample_rate")
    @classmethod
    def _validate_sample_rate(cls, v: float) -> float:
        if v < 0.0 or v > 1.0:
            raise ValueError("sample rate must be between 0.0 and 1.0")
        return v

    # Security response headers. Off by default for HSTS so dev HTTP works.
    security_headers_enabled: bool = True
    hsts_enabled: bool = False
    hsts_max_age_seconds: int = 63072000  # 2 years
    hsts_include_subdomains: bool = True
    hsts_preload: bool = False
    # CSP is opt-in; the API serves JSON + PNG, and the Next.js front end sets
    # its own CSP. Set ADHERENCE_CSP_POLICY to enable a server-side default.
    csp_policy: str = ""

    # Readiness probe behavior. When true, /readyz fails if redis is
    # unreachable. Default false because the API still serves predict and
    # cohort routes without redis (only async queues degrade).
    readyz_require_redis: bool = False

    # Intervention recommender
    intervention_cooldown_minutes: int = 120
    notification_default_daily_limit: int = 6
    intervention_max_age_minutes: int = 24 * 60  # auto-expire stale recommended rows

    @field_validator("jwt_secret")
    @classmethod
    def _validate_secret(cls, v: str) -> str:
        if len(v) < 16:
            raise ValueError("jwt_secret must be at least 16 chars")
        return v

    @field_validator("api_cors_origins", "api_cors_methods", "api_cors_headers", mode="before")
    @classmethod
    def _split_csv(cls, v):
        # Allow comma-separated env strings: ADHERENCE_API_CORS_ORIGINS="a,b".
        if isinstance(v, str):
            return [item.strip() for item in v.split(",") if item.strip()]
        return v

    @model_validator(mode="after")
    def _validate_cors(self) -> Settings:
        origins = self.api_cors_origins or []
        wildcard_origin = "*" in origins
        # Browsers reject credentialed requests when allow_origin is "*";
        # fail fast at boot rather than ship a broken config.
        if wildcard_origin and self.api_cors_allow_credentials:
            raise ValueError(
                "api_cors_origins=['*'] is incompatible with api_cors_allow_credentials=true; "
                "set explicit origins or disable credentials"
            )
        if self.env == "prod":
            if wildcard_origin:
                raise ValueError(
                    "api_cors_origins must be an explicit allowlist in env=prod (got ['*'])"
                )
            if "*" in (self.api_cors_methods or []):
                raise ValueError("api_cors_methods='*' is forbidden in env=prod")
            if "*" in (self.api_cors_headers or []):
                raise ValueError("api_cors_headers='*' is forbidden in env=prod")
        return self

    @field_validator("model_registry")
    @classmethod
    def _ensure_registry(cls, v: Path) -> Path:
        v.mkdir(parents=True, exist_ok=True)
        return v

    def api_key_map(self) -> dict[str, str]:
        """Returns {api_key: role} mapping."""
        out: dict[str, str] = {}
        if not self.api_keys:
            return out
        for entry in self.api_keys.split(","):
            entry = entry.strip()
            if not entry or ":" not in entry:
                continue
            role, key = entry.split(":", 1)
            out[key.strip()] = role.strip()
        return out


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def reload_settings() -> Settings:
    get_settings.cache_clear()
    return get_settings()
