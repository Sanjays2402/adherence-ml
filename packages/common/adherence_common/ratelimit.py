"""Token bucket rate limiter.

Backends:
- In-memory (per-process, default; fine for single-replica or tests).
- Redis (atomic Lua script; shared across replicas).

Buckets are keyed by a caller identifier (API key, JWT sub, or client IP).
A bucket has `capacity` tokens and refills at `refill_per_sec` tokens/second.
Each request consumes one token. When empty, the limiter returns the number
of seconds until the next token is available so the caller can emit
`Retry-After` and `X-RateLimit-*` headers.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class RateDecision:
    allowed: bool
    remaining: int  # tokens left after this request (floor)
    retry_after: float  # seconds until 1 token; 0 when allowed
    limit: int  # bucket capacity
    reset: float  # seconds until bucket fully refills


class RateLimiterBackend(Protocol):
    def check(
        self, key: str, capacity: int, refill_per_sec: float, cost: int = 1
    ) -> RateDecision: ...


class InMemoryBackend:
    """Process-local token bucket store. Thread-safe."""

    def __init__(self) -> None:
        self._buckets: dict[str, tuple[float, float]] = {}  # key -> (tokens, last_ts)
        self._lock = threading.Lock()

    def check(
        self, key: str, capacity: int, refill_per_sec: float, cost: int = 1
    ) -> RateDecision:
        now = time.monotonic()
        with self._lock:
            tokens, last = self._buckets.get(key, (float(capacity), now))
            tokens = min(float(capacity), tokens + (now - last) * refill_per_sec)
            if tokens >= cost:
                tokens -= cost
                self._buckets[key] = (tokens, now)
                reset = (capacity - tokens) / refill_per_sec if refill_per_sec > 0 else 0.0
                return RateDecision(True, int(tokens), 0.0, capacity, reset)
            # not enough tokens
            self._buckets[key] = (tokens, now)
            needed = cost - tokens
            retry = needed / refill_per_sec if refill_per_sec > 0 else float("inf")
            reset = (capacity - tokens) / refill_per_sec if refill_per_sec > 0 else 0.0
            return RateDecision(False, int(tokens), retry, capacity, reset)


# Atomic Lua: refill, decide, persist. Returns {allowed, tokens_left, retry_ms}.
_REDIS_SCRIPT = """
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now_ms = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity end
if ts == nil then ts = now_ms end

local elapsed = math.max(0, now_ms - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
local retry_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  local needed = cost - tokens
  if refill > 0 then
    retry_ms = math.ceil((needed / refill) * 1000)
  else
    retry_ms = -1
  end
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', now_ms)
-- ttl: enough to fully refill twice; keeps redis tidy for cold keys
local ttl = 1
if refill > 0 then
  ttl = math.ceil((capacity / refill) * 2) + 1
end
redis.call('EXPIRE', key, ttl)

return {allowed, math.floor(tokens), retry_ms}
"""


class RedisBackend:
    """Shared token bucket using a Redis HASH + Lua script."""

    def __init__(self, client, key_prefix: str = "rl:") -> None:
        self._r = client
        self._prefix = key_prefix
        self._sha: str | None = None

    def _script(self) -> str:
        if self._sha is None:
            self._sha = self._r.script_load(_REDIS_SCRIPT)
        return self._sha

    def check(
        self, key: str, capacity: int, refill_per_sec: float, cost: int = 1
    ) -> RateDecision:
        full_key = f"{self._prefix}{key}"
        now_ms = int(time.time() * 1000)
        try:
            res = self._r.evalsha(
                self._script(), 1, full_key,
                capacity, refill_per_sec, cost, now_ms,
            )
        except Exception:
            # reload script if flushed, then retry once
            self._sha = None
            res = self._r.evalsha(
                self._script(), 1, full_key,
                capacity, refill_per_sec, cost, now_ms,
            )
        allowed_i, tokens_left, retry_ms = (int(x) for x in res)
        retry = (retry_ms / 1000.0) if retry_ms >= 0 else float("inf")
        reset = (capacity / refill_per_sec) if refill_per_sec > 0 else 0.0
        return RateDecision(bool(allowed_i), tokens_left, retry, capacity, reset)


def build_backend(redis_url: str | None = None) -> RateLimiterBackend:
    """Try Redis, fall back to in-memory on any error."""
    if not redis_url:
        return InMemoryBackend()
    try:
        import redis as _redis  # type: ignore
        client = _redis.Redis.from_url(redis_url, socket_connect_timeout=0.25)
        client.ping()
        return RedisBackend(client)
    except Exception:
        return InMemoryBackend()
