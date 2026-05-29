"""Health / readiness endpoints."""
from __future__ import annotations

from fastapi import APIRouter

from adherence_common.schemas import HealthResponse
from adherence_common.settings import get_settings
from adherence_common.version import __version__

router = APIRouter(prefix="", tags=["health"])


def _check_redis(url: str) -> bool:
    try:
        import redis
        r = redis.from_url(url, socket_connect_timeout=0.5, socket_timeout=0.5)
        return bool(r.ping())
    except Exception:
        return False


def _check_db(url: str) -> bool:
    try:
        from sqlalchemy import create_engine, text
        eng = create_engine(url, connect_args={"connect_timeout": 1} if "postgres" in url else {})
        with eng.connect() as c:
            c.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


def _model_loaded() -> bool:
    try:
        from adherence_models.registry import ModelRegistry
        return any(ModelRegistry().list())
    except Exception:
        return False


@router.get("/healthz", response_model=HealthResponse)
def healthz() -> HealthResponse:
    s = get_settings()
    redis_ok = _check_redis(s.redis_url)
    db_ok = _check_db(s.db_url)
    model_ok = _model_loaded()
    status = "ok" if (model_ok and db_ok) else "degraded"
    return HealthResponse(
        status=status,
        version=__version__,
        model_loaded=model_ok,
        redis_ok=redis_ok,
        db_ok=db_ok,
    )


@router.get("/livez")
def livez() -> dict:
    return {"alive": True, "version": __version__}
