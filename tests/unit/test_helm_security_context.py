"""Helm chart sanity tests for the pod and container securityContext.

These assertions defend the Pod Security Standards "restricted" posture the
chart ships by default. They run without `helm` installed (parsing the
templates as text and YAML) and tighten further when `helm` is on PATH.

The hardened defaults match what `infra/docker/Dockerfile` prepares:
non-root uid 1001, dropped Linux caps, no privilege escalation, read-only
root filesystem, and seccomp RuntimeDefault.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

CHART_DIR = Path(__file__).resolve().parents[2] / "infra" / "helm" / "adherence-ml"
VALUES = yaml.safe_load((CHART_DIR / "values.yaml").read_text(encoding="utf-8"))


def test_values_yaml_ships_hardened_security_context_defaults():
    sc = VALUES.get("securityContext")
    assert isinstance(sc, dict), "securityContext block missing from values.yaml"
    assert sc.get("enabled") is True, "securityContext.enabled must default to true"

    pod = sc["pod"]
    assert pod["runAsNonRoot"] is True
    assert pod["runAsUser"] == 1001
    assert pod["runAsGroup"] == 1001
    assert pod["fsGroup"] == 1001
    assert pod["seccompProfile"]["type"] == "RuntimeDefault"

    container = sc["container"]
    assert container["allowPrivilegeEscalation"] is False
    assert container["readOnlyRootFilesystem"] is True
    assert container["runAsNonRoot"] is True
    assert container["runAsUser"] == 1001
    assert container["runAsGroup"] == 1001
    assert container["capabilities"]["drop"] == ["ALL"]

    writable = sc.get("writableDirs") or []
    mount_paths = {d["mountPath"] for d in writable}
    assert "/tmp" in mount_paths, "writableDirs must back /tmp for read-only rootfs"


def test_helpers_define_security_context_blocks():
    helpers = (CHART_DIR / "templates" / "_helpers.tpl").read_text(encoding="utf-8")
    for name in (
        "adherence.podSecurityContext",
        "adherence.containerSecurityContext",
        "adherence.writableVolumes",
        "adherence.writableVolumeMounts",
    ):
        assert f'define "{name}"' in helpers, f"missing helper {name}"


@pytest.mark.parametrize("template", ["deployment-api.yaml", "deployment-workers.yaml"])
def test_deployment_templates_invoke_security_context_helpers(template):
    body = (CHART_DIR / "templates" / template).read_text(encoding="utf-8")
    assert 'include "adherence.podSecurityContext"' in body
    assert 'include "adherence.containerSecurityContext"' in body
    assert 'include "adherence.writableVolumes"' in body
    assert 'include "adherence.writableVolumeMounts"' in body


def _has_helm() -> bool:
    return shutil.which("helm") is not None


@pytest.mark.skipif(not _has_helm(), reason="helm not installed")
def test_rendered_chart_applies_restricted_psa_to_every_pod():
    out = subprocess.check_output(
        ["helm", "template", "adh", str(CHART_DIR)],
        text=True,
    )
    docs = [d for d in yaml.safe_load_all(out) if d and d.get("kind") == "Deployment"]
    assert docs, "no Deployments rendered"
    names = {d["metadata"]["name"] for d in docs}
    assert {"adherence-ml-api", "adherence-ml-worker", "adherence-ml-trainer"} <= names

    for dep in docs:
        spec = dep["spec"]["template"]["spec"]
        psc = spec.get("securityContext") or {}
        assert psc.get("runAsNonRoot") is True, f"{dep['metadata']['name']} pod not runAsNonRoot"
        assert psc.get("runAsUser") == 1001
        assert psc.get("seccompProfile", {}).get("type") == "RuntimeDefault"

        for c in spec["containers"]:
            csc = c.get("securityContext") or {}
            assert csc.get("allowPrivilegeEscalation") is False, c["name"]
            assert csc.get("readOnlyRootFilesystem") is True, c["name"]
            assert csc.get("runAsNonRoot") is True, c["name"]
            assert csc.get("capabilities", {}).get("drop") == ["ALL"], c["name"]

        # /tmp must be backed by a writable emptyDir so read-only rootfs is usable.
        vols = {v["name"]: v for v in (spec.get("volumes") or [])}
        for c in spec["containers"]:
            mounts = {m["mountPath"]: m for m in (c.get("volumeMounts") or [])}
            assert "/tmp" in mounts, f"{c['name']} missing /tmp scratch mount"
            assert mounts["/tmp"]["name"] in vols
            assert "emptyDir" in vols[mounts["/tmp"]["name"]]


@pytest.mark.skipif(not _has_helm(), reason="helm not installed")
def test_security_context_can_be_disabled_via_values():
    out = subprocess.check_output(
        [
            "helm", "template", "adh", str(CHART_DIR),
            "--set", "securityContext.enabled=false",
        ],
        text=True,
    )
    docs = [d for d in yaml.safe_load_all(out) if d and d.get("kind") == "Deployment"]
    for dep in docs:
        spec = dep["spec"]["template"]["spec"]
        assert "securityContext" not in spec, f"{dep['metadata']['name']} still has podSC"
        for c in spec["containers"]:
            assert "securityContext" not in c, f"{c['name']} still has container SC"
