"""In-process Prometheus-style metrics with text exposition.

Zero external dependencies. Supports counters, gauges, and exponential-bucket
histograms with labels. Thread-safe enough for FastAPI + uvicorn worker use
(GIL-protected dict + list mutations; not multiprocess-safe). Multi-process
deployments should aggregate at the scrape layer.
"""
from __future__ import annotations

import threading
from collections import defaultdict
from typing import Iterable


_LOCK = threading.Lock()


def _fmt_labels(labels: tuple[tuple[str, str], ...]) -> str:
    if not labels:
        return ""
    inner = ",".join(f'{k}="{_escape(v)}"' for k, v in labels)
    return "{" + inner + "}"


def _escape(v: str) -> str:
    return v.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


class _Counter:
    def __init__(self, name: str, help_text: str, labelnames: tuple[str, ...]):
        self.name = name
        self.help = help_text
        self.labelnames = labelnames
        self._vals: dict[tuple[str, ...], float] = defaultdict(float)

    def inc(self, amount: float = 1.0, **labels: str) -> None:
        key = tuple(labels.get(n, "") for n in self.labelnames)
        with _LOCK:
            self._vals[key] += amount

    def render(self) -> Iterable[str]:
        yield f"# HELP {self.name} {self.help}"
        yield f"# TYPE {self.name} counter"
        with _LOCK:
            items = list(self._vals.items())
        if not items:
            yield f"{self.name} 0"
        for key, v in items:
            lbls = tuple(zip(self.labelnames, key))
            yield f"{self.name}{_fmt_labels(lbls)} {v}"


class _Gauge:
    def __init__(self, name: str, help_text: str, labelnames: tuple[str, ...]):
        self.name = name
        self.help = help_text
        self.labelnames = labelnames
        self._vals: dict[tuple[str, ...], float] = {}

    def set(self, value: float, **labels: str) -> None:
        key = tuple(labels.get(n, "") for n in self.labelnames)
        with _LOCK:
            self._vals[key] = float(value)

    def render(self) -> Iterable[str]:
        yield f"# HELP {self.name} {self.help}"
        yield f"# TYPE {self.name} gauge"
        with _LOCK:
            items = list(self._vals.items())
        for key, v in items:
            lbls = tuple(zip(self.labelnames, key))
            yield f"{self.name}{_fmt_labels(lbls)} {v}"


# Default buckets in milliseconds, geared to API latency.
DEFAULT_BUCKETS_MS = (5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000)


class _Histogram:
    def __init__(self, name: str, help_text: str, labelnames: tuple[str, ...],
                 buckets: tuple[float, ...] = DEFAULT_BUCKETS_MS):
        self.name = name
        self.help = help_text
        self.labelnames = labelnames
        self.buckets = buckets
        self._counts: dict[tuple[str, ...], list[int]] = {}
        self._sum: dict[tuple[str, ...], float] = defaultdict(float)
        self._n: dict[tuple[str, ...], int] = defaultdict(int)

    def observe(self, value: float, **labels: str) -> None:
        key = tuple(labels.get(n, "") for n in self.labelnames)
        with _LOCK:
            if key not in self._counts:
                self._counts[key] = [0] * len(self.buckets)
            for i, b in enumerate(self.buckets):
                if value <= b:
                    self._counts[key][i] += 1
            self._sum[key] += value
            self._n[key] += 1

    def render(self) -> Iterable[str]:
        yield f"# HELP {self.name} {self.help}"
        yield f"# TYPE {self.name} histogram"
        with _LOCK:
            keys = list(self._counts.keys())
            counts = {k: list(v) for k, v in self._counts.items()}
            sums = dict(self._sum)
            ns = dict(self._n)
        for key in keys:
            lbls = list(zip(self.labelnames, key))
            cum = 0
            for i, b in enumerate(self.buckets):
                cum = counts[key][i]
                full = tuple(lbls + [("le", str(b))])
                yield f"{self.name}_bucket{_fmt_labels(full)} {cum}"
            inf_labels = tuple(lbls + [("le", "+Inf")])
            yield f"{self.name}_bucket{_fmt_labels(inf_labels)} {ns[key]}"
            yield f"{self.name}_sum{_fmt_labels(tuple(lbls))} {sums[key]}"
            yield f"{self.name}_count{_fmt_labels(tuple(lbls))} {ns[key]}"


class Registry:
    def __init__(self) -> None:
        self._collectors: list = []

    def counter(self, name: str, help_text: str, labelnames: Iterable[str] = ()
                ) -> _Counter:
        c = _Counter(name, help_text, tuple(labelnames))
        self._collectors.append(c)
        return c

    def gauge(self, name: str, help_text: str, labelnames: Iterable[str] = ()
              ) -> _Gauge:
        g = _Gauge(name, help_text, tuple(labelnames))
        self._collectors.append(g)
        return g

    def histogram(self, name: str, help_text: str,
                  labelnames: Iterable[str] = (),
                  buckets: tuple[float, ...] = DEFAULT_BUCKETS_MS,
                  ) -> _Histogram:
        h = _Histogram(name, help_text, tuple(labelnames), buckets)
        self._collectors.append(h)
        return h

    def render(self) -> str:
        out: list[str] = []
        for c in self._collectors:
            out.extend(c.render())
        return "\n".join(out) + "\n"


REGISTRY = Registry()

REQUESTS = REGISTRY.counter(
    "adherence_api_requests_total",
    "Total HTTP requests handled by the API.",
    labelnames=("method", "route", "status"),
)
LATENCY = REGISTRY.histogram(
    "adherence_api_request_duration_ms",
    "HTTP request duration in milliseconds.",
    labelnames=("method", "route"),
)
PREDICTIONS = REGISTRY.counter(
    "adherence_predictions_total",
    "Total dose predictions scored.",
    labelnames=("model", "tier"),
)
SHADOW_DIVERGENCE = REGISTRY.histogram(
    "adherence_shadow_divergence",
    "Per-request max |p_primary - p_shadow| for shadow scoring.",
    labelnames=("shadow_model",),
    buckets=(0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1.0),
)
MODEL_LOADED = REGISTRY.gauge(
    "adherence_model_loaded",
    "1 if the named model is currently loaded into the worker cache.",
    labelnames=("model",),
)
