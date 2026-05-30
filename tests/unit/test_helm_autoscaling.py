"""Helm chart sanity tests for the HorizontalPodAutoscaler templates.

The chart ships HPAs for both the api and worker tiers, off by default so
vanilla clusters (and clusters without metrics-server installed) render
cleanly. When enabled, the api HPA scales on CPU plus optional memory and
both HPAs carry a `behavior` block that biases scale-up aggressive and
scale-down conservative so the fleet does not flap during diurnal load.

These tests pin that contract so a careless values.yaml edit cannot quietly
remove the memory metric, the behavior stabilization windows, or the worker
HPA path.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

CHART_DIR = Path(__file__).resolve().parents[2] / "infra" / "helm" / "adherence-ml"
VALUES = yaml.safe_load((CHART_DIR / "values.yaml").read_text(encoding="utf-8"))


def _has_helm() -> bool:
    return shutil.which("helm") is not None


def test_values_yaml_ships_api_autoscaling_defaults():
    a = VALUES.get("autoscaling")
    assert isinstance(a, dict), "autoscaling block missing from values.yaml"
    assert a.get("enabled") is False, "autoscaling must default to disabled"
    assert a["minReplicas"] >= 2, "api should keep at least 2 replicas when HPA on"
    assert a["maxReplicas"] >= a["minReplicas"]
    assert 1 <= int(a["targetCPUUtilizationPercentage"]) <= 100
    assert int(a["targetMemoryUtilizationPercentage"]) > 0, (
        "memory metric must default on so a memory leak triggers scale-out, "
        "not OOMKills. Set to 0 explicitly to opt out."
    )

    behavior = a.get("behavior")
    assert isinstance(behavior, dict), "api HPA must ship a behavior block"
    scale_down = behavior["scaleDown"]
    assert scale_down["stabilizationWindowSeconds"] >= 60, (
        "scale-down must stabilize for at least a minute to avoid flapping"
    )
    assert any(p["type"] == "Pods" for p in scale_down["policies"])


def test_values_yaml_ships_worker_autoscaling_block():
    worker = VALUES["autoscaling"].get("worker")
    assert isinstance(worker, dict), "autoscaling.worker block missing"
    assert worker.get("enabled") is False, "worker HPA must default to disabled"
    assert worker["minReplicas"] >= 1
    assert worker["maxReplicas"] >= worker["minReplicas"]
    assert 1 <= int(worker["targetCPUUtilizationPercentage"]) <= 100

    behavior = worker.get("behavior")
    assert isinstance(behavior, dict), "worker HPA must ship a behavior block"
    assert behavior["scaleDown"]["stabilizationWindowSeconds"] >= 300, (
        "worker scale-down should stabilize aggressively so transient queue "
        "drains do not yank workers mid-job"
    )


@pytest.mark.skipif(not _has_helm(), reason="helm not installed")
def test_no_hpa_rendered_by_default():
    out = subprocess.check_output(
        ["helm", "template", "adh", str(CHART_DIR)],
        text=True,
    )
    docs = [d for d in yaml.safe_load_all(out) if d]
    hpas = [d for d in docs if d.get("kind") == "HorizontalPodAutoscaler"]
    assert hpas == [], "HPAs must not render unless explicitly enabled"


@pytest.mark.skipif(not _has_helm(), reason="helm not installed")
def test_api_hpa_renders_with_cpu_memory_and_behavior():
    out = subprocess.check_output(
        ["helm", "template", "adh", str(CHART_DIR), "--set", "autoscaling.enabled=true"],
        text=True,
    )
    hpas = [
        d for d in yaml.safe_load_all(out)
        if d and d.get("kind") == "HorizontalPodAutoscaler"
    ]
    assert len(hpas) == 1
    h = hpas[0]
    assert h["metadata"]["name"] == "adherence-ml-api"
    assert h["spec"]["scaleTargetRef"]["name"] == "adherence-ml-api"

    metric_names = {m["resource"]["name"] for m in h["spec"]["metrics"]}
    assert metric_names == {"cpu", "memory"}, (
        f"expected both CPU and memory metrics, got {metric_names}"
    )

    behavior = h["spec"]["behavior"]
    assert behavior["scaleDown"]["stabilizationWindowSeconds"] >= 60
    assert behavior["scaleUp"]["selectPolicy"] == "Max"


@pytest.mark.skipif(not _has_helm(), reason="helm not installed")
def test_api_hpa_memory_metric_can_be_disabled():
    out = subprocess.check_output(
        [
            "helm", "template", "adh", str(CHART_DIR),
            "--set", "autoscaling.enabled=true",
            "--set", "autoscaling.targetMemoryUtilizationPercentage=0",
        ],
        text=True,
    )
    hpas = [
        d for d in yaml.safe_load_all(out)
        if d and d.get("kind") == "HorizontalPodAutoscaler"
        and d["metadata"]["name"] == "adherence-ml-api"
    ]
    assert len(hpas) == 1
    metric_names = {m["resource"]["name"] for m in hpas[0]["spec"]["metrics"]}
    assert metric_names == {"cpu"}, "memory metric should be omitted when target=0"


@pytest.mark.skipif(not _has_helm(), reason="helm not installed")
def test_worker_hpa_renders_when_enabled():
    out = subprocess.check_output(
        [
            "helm", "template", "adh", str(CHART_DIR),
            "--set", "autoscaling.worker.enabled=true",
        ],
        text=True,
    )
    hpas = [
        d for d in yaml.safe_load_all(out)
        if d and d.get("kind") == "HorizontalPodAutoscaler"
    ]
    names = {h["metadata"]["name"] for h in hpas}
    assert "adherence-ml-worker" in names
    worker = next(h for h in hpas if h["metadata"]["name"] == "adherence-ml-worker")
    assert worker["spec"]["scaleTargetRef"]["name"] == "adherence-ml-worker"
    assert worker["spec"]["scaleTargetRef"]["kind"] == "Deployment"
    metric_names = {m["resource"]["name"] for m in worker["spec"]["metrics"]}
    assert metric_names == {"cpu"}, (
        "worker HPA stays CPU-only until a queue-depth metric adapter ships"
    )
    behavior = worker["spec"]["behavior"]
    assert behavior["scaleDown"]["stabilizationWindowSeconds"] >= 300


@pytest.mark.skipif(not _has_helm(), reason="helm not installed")
def test_both_hpas_can_render_together():
    out = subprocess.check_output(
        [
            "helm", "template", "adh", str(CHART_DIR),
            "--set", "autoscaling.enabled=true",
            "--set", "autoscaling.worker.enabled=true",
        ],
        text=True,
    )
    hpas = [
        d for d in yaml.safe_load_all(out)
        if d and d.get("kind") == "HorizontalPodAutoscaler"
    ]
    names = {h["metadata"]["name"] for h in hpas}
    assert names == {"adherence-ml-api", "adherence-ml-worker"}
