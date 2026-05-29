"""OpenTelemetry bootstrap (no-op if no endpoint configured)."""
from __future__ import annotations

import os

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter


def init_tracing(service_name: str = "adherence-ml") -> trace.Tracer:
    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
    resource = Resource.create({"service.name": service_name})
    provider = TracerProvider(resource=resource)
    if endpoint:
        try:
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
                OTLPSpanExporter,
            )
            provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
        except Exception:
            provider.add_span_processor(BatchSpanProcessor(ConsoleSpanExporter()))
    trace.set_tracer_provider(provider)
    return trace.get_tracer(service_name)
