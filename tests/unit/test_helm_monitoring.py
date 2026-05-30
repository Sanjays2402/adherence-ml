"""Helm chart sanity tests for Prometheus Operator integration.

Validates the ServiceMonitor, PrometheusRule, and scrape-annotation toggles
shipped under .Values.monitoring. Mirrors the pattern in
test_helm_networkpolicy.py: parse YAML + string assertions without requiring
`helm` on PATH, then optionally render with `helm template` when available.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

CHART_DIR = Path(__file__).resolve().parents[2] / "infra" / "helm" / "adherence-ml"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_values_yaml_has_monitoring_block():
    values = yaml.safe_load(_read(CHART_DIR / "values.yaml"))
    mon = values.get("monitoring")
    assert isinstance(mon, dict), "monitoring block missing from values.yaml"

    sm = mon.get("serviceMonitor")
    assert isinstance(sm, dict)
    assert sm.get("enabled") is False, "serviceMonitor must default to disabled"
    assert sm.get("path") == "/metrics"
    assert sm.get("interval")

    pr = mon.get("prometheusRule")
    assert isinstance(pr, dict)
    assert pr.get("enabled") is False, "prometheusRule must default to disabled"
    th = pr.get("thresholds")
    assert isinstance(th, dict)
    for key in (
        "errorRate",
        "errorRateFor",
        "latencyP95Ms",
        "noTrafficFor",
        "noModelFor",
        "targetDownFor",
    ):
        assert key in th, f"thresholds.{key} missing"

    for key in ("podAnnotations", "serviceAnnotations"):
        block = mon.get(key)
        assert isinstance(block, dict)
        assert block.get("enabled") is False


def test_servicemonitor_template_is_gated():
    tmpl = _read(CHART_DIR / "templates" / "servicemonitor.yaml")
    assert tmpl.startswith("{{- if .Values.monitoring.serviceMonitor.enabled }}")
    assert tmpl.rstrip().endswith("{{- end }}")
    assert "kind: ServiceMonitor" in tmpl
    assert "monitoring.coreos.com/v1" in tmpl
    # Endpoint must target the named http port on the api Service.
    assert "port: http" in tmpl
    assert "app.kubernetes.io/component: api" in tmpl


def test_prometheusrule_template_targets_real_metrics():
    tmpl = _read(CHART_DIR / "templates" / "prometheusrule.yaml")
    assert tmpl.startswith("{{- if .Values.monitoring.prometheusRule.enabled }}")
    assert tmpl.rstrip().endswith("{{- end }}")
    assert "kind: PrometheusRule" in tmpl
    # Each metric referenced here must exist in adherence_common.prom.
    prom_src = (
        Path(__file__).resolve().parents[2]
        / "packages"
        / "common"
        / "adherence_common"
        / "prom.py"
    ).read_text(encoding="utf-8")
    for metric in (
        "adherence_api_requests_total",
        "adherence_api_request_duration_ms",
        "adherence_model_loaded",
    ):
        assert metric in tmpl, f"alert references unknown metric {metric}"
        assert metric in prom_src, f"prom.py does not define {metric}"


def test_scrape_annotations_gated_in_deployment_and_service():
    dep = _read(CHART_DIR / "templates" / "deployment-api.yaml")
    assert "{{- if .Values.monitoring.podAnnotations.enabled }}" in dep
    assert "{{- if .Values.monitoring.serviceAnnotations.enabled }}" in dep
    assert "prometheus.io/scrape" in dep
    assert "prometheus.io/path" in dep
    assert "prometheus.io/port" in dep


@pytest.mark.skipif(shutil.which("helm") is None, reason="helm not installed")
def test_helm_template_renders_monitoring_when_enabled(tmp_path):
    out = subprocess.run(
        [
            "helm",
            "template",
            "adh-test",
            str(CHART_DIR),
            "--set",
            "monitoring.serviceMonitor.enabled=true",
            "--set",
            "monitoring.prometheusRule.enabled=true",
            "--set",
            "monitoring.podAnnotations.enabled=true",
            "--set",
            "monitoring.serviceAnnotations.enabled=true",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    docs = [d for d in yaml.safe_load_all(out.stdout) if d]
    kinds = {d.get("kind") for d in docs}
    assert "ServiceMonitor" in kinds
    assert "PrometheusRule" in kinds

    sm = next(d for d in docs if d.get("kind") == "ServiceMonitor")
    assert sm["spec"]["endpoints"][0]["port"] == "http"
    assert sm["spec"]["endpoints"][0]["path"] == "/metrics"

    pr = next(d for d in docs if d.get("kind") == "PrometheusRule")
    rules = pr["spec"]["groups"][0]["rules"]
    alert_names = {r["alert"] for r in rules}
    assert {
        "AdherenceApiHighErrorRate",
        "AdherenceApiHighLatencyP95",
        "AdherenceApiNoModelLoaded",
    }.issubset(alert_names)

    svc = next(
        d
        for d in docs
        if d.get("kind") == "Service" and d["metadata"]["name"].endswith("-api")
    )
    assert svc["metadata"]["annotations"]["prometheus.io/scrape"] == "true"
    assert svc["metadata"]["annotations"]["prometheus.io/port"] == "7421"

    dep = next(
        d
        for d in docs
        if d.get("kind") == "Deployment" and d["metadata"]["name"].endswith("-api")
    )
    pod_ann = dep["spec"]["template"]["metadata"]["annotations"]
    assert pod_ann["prometheus.io/scrape"] == "true"
    assert pod_ann["prometheus.io/port"] == "7421"


@pytest.mark.skipif(shutil.which("helm") is None, reason="helm not installed")
def test_helm_template_omits_monitoring_when_disabled():
    out = subprocess.run(
        ["helm", "template", "adh-test", str(CHART_DIR)],
        capture_output=True,
        text=True,
        check=True,
    )
    docs = [d for d in yaml.safe_load_all(out.stdout) if d]
    kinds = {d.get("kind") for d in docs}
    assert "ServiceMonitor" not in kinds
    assert "PrometheusRule" not in kinds
    # Annotations off by default: api Service must not advertise scrape.
    svc = next(
        d
        for d in docs
        if d.get("kind") == "Service" and d["metadata"]["name"].endswith("-api")
    )
    ann = svc["metadata"].get("annotations") or {}
    assert "prometheus.io/scrape" not in ann
