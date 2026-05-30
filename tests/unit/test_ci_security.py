"""CI workflow sanity tests.

Asserts that .github/workflows/ci.yml wires the supply chain security jobs
(pip-audit SCA, bandit SAST, CycloneDX SBOM, Trivy image scan) and that
bandit.yaml parses and configures the expected exclusions. These tests do
not require GitHub Actions or a network connection.
"""
from __future__ import annotations

from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
CI_FILE = REPO_ROOT / ".github" / "workflows" / "ci.yml"
BANDIT_FILE = REPO_ROOT / "bandit.yaml"


@pytest.fixture(scope="module")
def ci_workflow() -> dict:
    assert CI_FILE.exists(), f"missing {CI_FILE}"
    with CI_FILE.open() as f:
        return yaml.safe_load(f)


@pytest.fixture(scope="module")
def bandit_cfg() -> dict:
    assert BANDIT_FILE.exists(), f"missing {BANDIT_FILE}"
    with BANDIT_FILE.open() as f:
        return yaml.safe_load(f)


def test_ci_workflow_parses(ci_workflow: dict) -> None:
    assert ci_workflow["name"] == "ci"
    # PyYAML parses the bare `on:` key as Python True. Accept either form.
    assert "jobs" in ci_workflow
    assert ("on" in ci_workflow) or (True in ci_workflow)


def test_ci_has_security_jobs(ci_workflow: dict) -> None:
    """Supply chain security jobs must exist and be gated by the same gate job."""
    required = {"gate", "test", "pip-audit", "bandit", "sbom", "docker", "trivy"}
    jobs = ci_workflow["jobs"]
    missing = required - set(jobs)
    assert not missing, f"ci.yml is missing required jobs: {sorted(missing)}"

    for name in ("pip-audit", "bandit", "sbom", "trivy"):
        job = jobs[name]
        needs = job.get("needs")
        # `needs` can be a string or list; normalize.
        if isinstance(needs, str):
            needs = [needs]
        assert needs and "gate" in needs, f"{name} job must depend on gate"
        cond = job.get("if", "")
        assert "gate.outputs.enabled" in cond, (
            f"{name} job must be gated by gate.outputs.enabled"
        )


def test_ci_docker_waits_for_security(ci_workflow: dict) -> None:
    """The image build must not run before SCA + SAST pass."""
    docker = ci_workflow["jobs"]["docker"]
    needs = docker.get("needs", [])
    if isinstance(needs, str):
        needs = [needs]
    for required in ("test", "pip-audit", "bandit"):
        assert required in needs, f"docker.needs must include {required}"


def test_ci_trivy_scans_built_image(ci_workflow: dict) -> None:
    trivy = ci_workflow["jobs"]["trivy"]
    needs = trivy.get("needs", [])
    if isinstance(needs, str):
        needs = [needs]
    assert "docker" in needs, "trivy must run after docker build"
    steps_text = yaml.safe_dump(trivy["steps"])
    assert "aquasecurity/trivy-action" in steps_text
    assert "adherence-ml:ci" in steps_text


def test_ci_sbom_uploads_artifact(ci_workflow: dict) -> None:
    sbom = ci_workflow["jobs"]["sbom"]
    steps_text = yaml.safe_dump(sbom["steps"])
    assert "cyclonedx-bom" in steps_text or "cyclonedx-py" in steps_text
    assert "upload-artifact" in steps_text
    assert "sbom.cdx.json" in steps_text


def test_bandit_config_parses(bandit_cfg: dict) -> None:
    assert isinstance(bandit_cfg, dict)
    exclude = bandit_cfg.get("exclude_dirs", [])
    for d in ("tests", ".venv", "web", "infra"):
        assert d in exclude, f"bandit.yaml must exclude {d}"


def test_bandit_pipeline_invocation_uses_config(ci_workflow: dict) -> None:
    """The bandit job must invoke bandit with our config file and severity gate."""
    bandit_job = ci_workflow["jobs"]["bandit"]
    steps_text = yaml.safe_dump(bandit_job["steps"])
    assert "-c bandit.yaml" in steps_text
    assert "-r packages services" in steps_text
    # -ll = report Medium and above, our chosen gate.
    assert "-ll" in steps_text
