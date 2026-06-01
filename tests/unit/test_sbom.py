"""Tests for the public CycloneDX 1.5 SBOM."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from adherence_common.sbom import (
    SBOM_SCHEMA_VERSION,
    build_sbom,
    cached_sbom,
    parse_npm_package_json,
    parse_uv_lock,
    sbom_summary,
)


SAMPLE_UV_LOCK = """\
version = 1
revision = 3
requires-python = ">=3.11, <3.13"

[[package]]
name = "adherence-ml"
version = "0.1.0"
source = { editable = "." }
dependencies = [
    { name = "fastapi" },
]

[[package]]
name = "fastapi"
version = "0.115.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "pydantic"
version = "2.9.2"
source = { registry = "https://pypi.org/simple" }
"""

SAMPLE_PACKAGE_JSON = json.dumps(
    {
        "name": "@adherence/web",
        "version": "0.1.0",
        "dependencies": {
            "next": "15.5.18",
            "@phosphor-icons/react": "2.1.7",
        },
        "devDependencies": {
            "typescript": "5.7.3",
        },
    }
)


def test_parse_uv_lock_extracts_packages() -> None:
    records = parse_uv_lock(SAMPLE_UV_LOCK)
    names = {r["name"]: r for r in records}
    assert "adherence-ml" in names
    assert "fastapi" in names
    assert "pydantic" in names
    assert names["fastapi"]["version"] == "0.115.0"
    assert "editable" in names["adherence-ml"]["source"]


def test_parse_npm_package_json_tags_scope() -> None:
    records = parse_npm_package_json(SAMPLE_PACKAGE_JSON)
    by_name = {r["name"]: r for r in records}
    assert by_name["next"]["scope"] == "runtime"
    assert by_name["next"]["version"] == "15.5.18"
    assert by_name["typescript"]["scope"] == "dev"
    # Caret prefix is stripped from declared ranges.
    assert by_name["@phosphor-icons/react"]["version"] == "2.1.7"


def test_build_sbom_matches_cyclonedx_15() -> None:
    now = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
    bom = build_sbom(
        uv_lock_text=SAMPLE_UV_LOCK,
        package_json_text=SAMPLE_PACKAGE_JSON,
        generated_at=now,
    )
    assert bom["bomFormat"] == "CycloneDX"
    assert bom["specVersion"] == "1.5"
    assert bom["version"] == 1
    assert bom["serialNumber"].startswith("urn:uuid:")
    assert bom["metadata"]["timestamp"] == "2026-01-01T00:00:00Z"
    assert bom["metadata"]["component"]["name"] == "adherence-ml"

    # adherence-ml itself is the bom subject, not a library entry.
    component_names = [c["name"] for c in bom["components"]]
    assert "adherence-ml" not in component_names
    assert "fastapi" in component_names
    assert "next" in component_names
    assert "typescript" in component_names

    # Every component declares a PURL and an ecosystem property.
    for c in bom["components"]:
        assert c["purl"].startswith("pkg:")
        ecos = [p["value"] for p in c["properties"] if p["name"] == "ecosystem"]
        assert ecos and ecos[0] in {"pypi", "npm"}


def test_build_sbom_is_deterministic() -> None:
    a = build_sbom(
        uv_lock_text=SAMPLE_UV_LOCK,
        package_json_text=SAMPLE_PACKAGE_JSON,
        generated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    b = build_sbom(
        uv_lock_text=SAMPLE_UV_LOCK,
        package_json_text=SAMPLE_PACKAGE_JSON,
        generated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    # Two builds with identical inputs produce identical serial numbers
    # and identical component lists. Buyers diff these across releases.
    assert a["serialNumber"] == b["serialNumber"]
    assert a["components"] == b["components"]


def test_live_cached_sbom_and_summary_are_consistent() -> None:
    # Hits the real repo lock files; if they are unparseable the whole
    # trust pipeline is broken, so we want CI to scream.
    cached_sbom.cache_clear()
    bom = cached_sbom()
    assert bom["bomFormat"] == "CycloneDX"
    assert bom["specVersion"] == "1.5"
    assert len(bom["components"]) > 20
    summary = sbom_summary()
    assert summary["spec_version"] == "1.5"
    assert summary["schema_version"] == SBOM_SCHEMA_VERSION
    assert summary["total_components"] == len(bom["components"])
    # Both ecosystems should be present in this repo.
    assert summary["components_by_ecosystem"].get("pypi", 0) > 0
    assert summary["components_by_ecosystem"].get("npm", 0) > 0


def test_security_json_advertises_sbom(tmp_path, monkeypatch) -> None:
    """The trust manifest must expose the SBOM URL so procurement
    scanners that pin to security.json discover it automatically."""
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/sbom.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    from adherence_common.settings import reload_settings
    reload_settings()
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()

    from fastapi.testclient import TestClient
    from adherence_api.app import create_app

    client = TestClient(create_app())

    # Manifest references SBOM under contacts.sbom and the top-level sbom block.
    r = client.get("/.well-known/security.json")
    assert r.status_code == 200, r.text
    data = r.json()
    assert "sbom" in data["contacts"], data["contacts"]
    assert data["contacts"]["sbom"].endswith("/.well-known/sbom.json")
    assert data["sbom"]["format"] == "CycloneDX"
    assert data["sbom"]["spec_version"] == "1.5"
    assert data["sbom"]["total_components"] > 0

    # And the SBOM itself is reachable, public, with the right content-type.
    r = client.get("/.well-known/sbom.json")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/vnd.cyclonedx+json")
    bom = r.json()
    assert bom["bomFormat"] == "CycloneDX"
    assert bom["specVersion"] == "1.5"
