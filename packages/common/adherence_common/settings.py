"""Pydantic settings sourced from environment / .env."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


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

    api_host: str = "0.0.0.0"
    api_port: int = 7421
    api_cors_origins: list[str] = Field(default_factory=lambda: ["*"])

    jwt_secret: str = "change-me-please-32-bytes-min-xxxxxxxx"
    jwt_alg: str = "HS256"
    jwt_ttl_seconds: int = 3600
    # Format: role:key,role:key,...
    api_keys: str = ""

    db_url: str = "sqlite:///./adherence.db"
    redis_url: str = "redis://localhost:6379/0"
    mlflow_tracking_uri: str = "file:./mlruns"
    model_registry: Path = Path("./models/registry")

    drift_webhook_url: str | None = None
    drift_psi_threshold: float = 0.2

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
