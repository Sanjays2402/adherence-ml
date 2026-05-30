"""Helm chart sanity tests for the adherence-ml chart.

These tests do not require `helm` to be installed. They validate:

  * `values.yaml` parses cleanly and exposes the networkPolicy keys our
    `networkpolicy.yaml` template references.
  * `networkpolicy.yaml` is gated behind `.Values.networkPolicy.enabled`
    so the chart stays backward compatible.
  * All NetworkPolicy resources we ship target a real workload component
    (api / worker / trainer) that actually exists as a Deployment in
    the chart, so we never apply an orphan policy.

If `helm` is on PATH we additionally render the chart with
`networkPolicy.enabled=true` and assert the rendered manifests parse as
valid NetworkPolicy objects with both Ingress and Egress rules.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

CHART_DIR = Path(__file__).resolve().parents[2] / "infra" / "helm" / "adherence-ml"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_values_yaml_has_network_policy_block():
    values = yaml.safe_load(_read(CHART_DIR / "values.yaml"))
    np = values.get("networkPolicy")
    assert isinstance(np, dict), "networkPolicy block missing from values.yaml"
    # Default-off so existing installs do not break.
    assert np.get("enabled") is False
    assert "api" in np and "egress" in np
    for dep in ("postgres", "redis", "mlflow"):
        entry = np["egress"][dep]
        assert "podLabels" in entry and "port" in entry, f"egress.{dep} malformed"
        assert isinstance(entry["port"], int)


def test_networkpolicy_template_is_gated_and_complete():
    tmpl = _read(CHART_DIR / "templates" / "networkpolicy.yaml")
    # Must be gated so disabling networkPolicy renders nothing.
    assert tmpl.startswith("{{- if .Values.networkPolicy.enabled }}")
    assert tmpl.rstrip().endswith("{{- end }}")
    # Each component we deploy should have a matching NetworkPolicy block.
    for component in ("api", "worker", "trainer"):
        assert f"adherence.fullname\" . }}}}-{component}" in tmpl, (
            f"NetworkPolicy for component '{component}' missing from template"
        )
    # DNS egress is required or every pod breaks resolving services.
    assert "k8s-app: kube-dns" in tmpl


def test_every_component_with_a_deployment_has_a_netpol():
    """No orphan policies and no unguarded workloads."""
    deployments = list((CHART_DIR / "templates").glob("deployment-*.yaml"))
    components_with_dep = set()
    for f in deployments:
        text = _read(f)
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("app.kubernetes.io/component:"):
                components_with_dep.add(line.split(":", 1)[1].strip())
    assert components_with_dep == {"api", "worker", "trainer"}, (
        f"Unexpected components in chart deployments: {components_with_dep}"
    )
    tmpl = _read(CHART_DIR / "templates" / "networkpolicy.yaml")
    for component in components_with_dep:
        assert f"component: {component}" in tmpl


@pytest.mark.skipif(shutil.which("helm") is None, reason="helm CLI not installed")
def test_helm_template_renders_valid_network_policies(tmp_path):
    out = subprocess.run(
        [
            "helm",
            "template",
            "test-release",
            str(CHART_DIR),
            "--set",
            "networkPolicy.enabled=true",
        ],
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ},
    )
    docs = [d for d in yaml.safe_load_all(out.stdout) if d]
    netpols = [d for d in docs if d.get("kind") == "NetworkPolicy"]
    assert len(netpols) >= 3, f"Expected api/worker/trainer NetworkPolicies, got {len(netpols)}"
    by_name = {np["metadata"]["name"]: np for np in netpols}
    assert any(name.endswith("-api") for name in by_name)
    assert any(name.endswith("-worker") for name in by_name)
    assert any(name.endswith("-trainer") for name in by_name)
    for np in netpols:
        spec = np["spec"]
        assert "podSelector" in spec
        assert set(spec.get("policyTypes", [])) >= {"Ingress", "Egress"}
        assert "egress" in spec and spec["egress"], f"{np['metadata']['name']} has no egress rules"
