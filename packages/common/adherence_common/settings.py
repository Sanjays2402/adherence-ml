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
