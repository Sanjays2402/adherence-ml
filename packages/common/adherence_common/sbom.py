"""Public, CycloneDX 1.5 software bill of materials.

Procurement reviewers ask for an SBOM before they sign. Most vendors
answer with a PDF link to a year-old Excel file. We answer with a
machine-readable CycloneDX document generated from the actual lock
files that ship this build, served at a stable public URL with no
auth, no API key, no tenant context.

The SBOM is built deterministically from:

* ``uv.lock`` (Python production resolution)
* ``apps/web/package.json`` (web app declared dependencies)

We deliberately do not call out to ``npm ls`` or ``pip freeze`` at
runtime. The output must be reproducible on a clean checkout from a
buyer's mirror, and it must not require installing the world.

Schema: https://cyclonedx.org/specification/overview/ (1.5 JSON).

The result is cached in-process for the lifetime of the worker; the
underlying files only change with a deploy.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from adherence_common.version import __version__

# Bump only on a breaking change to the *shape* of our SBOM wrapper
# (the ``metadata`` extras we add). The CycloneDX spec version is
# tracked separately in ``specVersion``.
SBOM_SCHEMA_VERSION = "1.0.0"
_CYCLONEDX_SPEC_VERSION = "1.5"
_CYCLONEDX_BOM_FORMAT = "CycloneDX"


# --------------------------------------------------------------------------- #
# Repo path discovery
# --------------------------------------------------------------------------- #
def _repo_root() -> Path:
    """Walk up from this file to the repo root.

    The package lives at ``packages/common/adherence_common/sbom.py``.
    The repo root is the first ancestor that contains ``uv.lock``.
    """
    here = Path(__file__).resolve()
    for ancestor in here.parents:
        if (ancestor / "uv.lock").is_file():
            return ancestor
    # Fallback: tests sometimes run with a bare layout.
    return here.parents[3]


# --------------------------------------------------------------------------- #
# Lock-file parsers
# --------------------------------------------------------------------------- #
_PKG_HEADER = re.compile(r"^\[\[package\]\]\s*$")
_KV_NAME = re.compile(r'^name\s*=\s*"([^"]+)"\s*$')
_KV_VERSION = re.compile(r'^version\s*=\s*"([^"]+)"\s*$')
_KV_SOURCE = re.compile(r"^source\s*=\s*(.+)$")


def parse_uv_lock(text: str) -> list[dict[str, str]]:
    """Return a list of ``{name, version, source}`` records from uv.lock.

    The first ``name = `` line outside a ``[[package]]`` block (the
    top-level ``revision = 3`` style) is ignored because we only emit
    records when we are inside a package block.
    """
    out: list[dict[str, str]] = []
    in_pkg = False
    cur: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.rstrip()
        if _PKG_HEADER.match(line):
            if cur.get("name"):
                out.append(cur)
            cur = {}
            in_pkg = True
            continue
        if not in_pkg:
            continue
        if not line.strip():
            # Blank line ends the block.
            if cur.get("name"):
                out.append(cur)
                cur = {}
            in_pkg = False
            continue
        m = _KV_NAME.match(line)
        if m and "name" not in cur:
            cur["name"] = m.group(1)
            continue
        m = _KV_VERSION.match(line)
        if m and "version" not in cur:
            cur["version"] = m.group(1)
            continue
        m = _KV_SOURCE.match(line)
        if m and "source" not in cur:
            cur["source"] = m.group(1).strip()
            continue
    if cur.get("name"):
        out.append(cur)
    return out


def parse_npm_package_json(text: str) -> list[dict[str, str]]:
    """Return a list of ``{name, version, scope}`` records from package.json.

    We intentionally use the declared ranges (``^5.1.11``) rather than
    a resolved tree. The lockfile (``pnpm-lock.yaml``) is not always
    committed in this repo, and procurement buyers care about what we
    *declare*: the ranges that flow into their compliance pipelines.
    """
    data = json.loads(text)
    out: list[dict[str, str]] = []
    for scope_key, scope_label in (
        ("dependencies", "runtime"),
        ("devDependencies", "dev"),
    ):
        deps = data.get(scope_key) or {}
        for name, version in deps.items():
            out.append(
                {
                    "name": str(name),
                    "version": str(version).lstrip("^~"),
                    "scope": scope_label,
                }
            )
    return out


# --------------------------------------------------------------------------- #
# CycloneDX component builders
# --------------------------------------------------------------------------- #
def _purl_pypi(name: str, version: str) -> str:
    # PURL spec: pkg:pypi/<name>@<version>
    return f"pkg:pypi/{name.lower()}@{version}"


def _purl_npm(name: str, version: str) -> str:
    # PURL spec: pkg:npm/<name>@<version>; scoped names like
    # ``@phosphor-icons/react`` are kept verbatim per spec.
    return f"pkg:npm/{name}@{version}"


def _bom_ref(prefix: str, name: str, version: str) -> str:
    return f"{prefix}:{name}@{version}"


def _python_component(rec: dict[str, str]) -> dict[str, Any]:
    name = rec["name"]
    version = rec.get("version", "0.0.0")
    src = rec.get("source", "")
    is_editable = "editable" in src
    return {
        "type": "library" if not is_editable else "application",
        "bom-ref": _bom_ref("pypi", name, version),
        "name": name,
        "version": version,
        "scope": "required",
        "purl": _purl_pypi(name, version) if not is_editable else f"pkg:generic/{name}@{version}",
        "properties": [
            {"name": "ecosystem", "value": "pypi"},
            {"name": "source", "value": "uv.lock"},
        ],
    }


def _npm_component(rec: dict[str, str]) -> dict[str, Any]:
    name = rec["name"]
    version = rec.get("version", "0.0.0")
    scope = rec.get("scope", "runtime")
    return {
        "type": "library",
        "bom-ref": _bom_ref("npm", name, version),
        "name": name,
        "version": version,
        "scope": "required" if scope == "runtime" else "optional",
        "purl": _purl_npm(name, version),
        "properties": [
            {"name": "ecosystem", "value": "npm"},
            {"name": "source", "value": "apps/web/package.json"},
            {"name": "dependency_scope", "value": scope},
        ],
    }


# --------------------------------------------------------------------------- #
# Public builder
# --------------------------------------------------------------------------- #
def build_sbom(
    *,
    uv_lock_text: str | None = None,
    package_json_text: str | None = None,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    """Build the CycloneDX 1.5 SBOM document.

    All inputs are optional so unit tests can pass synthetic strings.
    When omitted, the live repo files are read.
    """
    root = _repo_root()
    if uv_lock_text is None:
        uv_lock_text = (root / "uv.lock").read_text(encoding="utf-8")
    if package_json_text is None:
        package_json_text = (root / "apps" / "web" / "package.json").read_text(
            encoding="utf-8"
        )

    py_records = parse_uv_lock(uv_lock_text)
    npm_records = parse_npm_package_json(package_json_text)

    components: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in py_records:
        if r["name"] == "adherence-ml":
            # The application itself is recorded as the bom subject in
            # metadata.component below; do not duplicate it as a library.
            continue
        comp = _python_component(r)
        if comp["bom-ref"] in seen:
            continue
        seen.add(comp["bom-ref"])
        components.append(comp)
    for r in npm_records:
        comp = _npm_component(r)
        if comp["bom-ref"] in seen:
            continue
        seen.add(comp["bom-ref"])
        components.append(comp)

    # Deterministic ordering so two builds of the same lockfiles
    # produce byte-identical SBOMs. Buyers diff these.
    components.sort(key=lambda c: (c["properties"][0]["value"], c["name"].lower(), c["version"]))

    ts = (generated_at or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Stable serial number derived from the inputs: same lockfiles ->
    # same serial. CycloneDX recommends a urn:uuid; using a content
    # hash keeps it reproducible without requiring uuid state.
    digest = hashlib.sha256()
    digest.update(uv_lock_text.encode("utf-8"))
    digest.update(b"\x1f")
    digest.update(package_json_text.encode("utf-8"))
    serial_hex = digest.hexdigest()
    serial = (
        f"urn:uuid:{serial_hex[0:8]}-{serial_hex[8:12]}-"
        f"{serial_hex[12:16]}-{serial_hex[16:20]}-{serial_hex[20:32]}"
    )

    return {
        "bomFormat": _CYCLONEDX_BOM_FORMAT,
        "specVersion": _CYCLONEDX_SPEC_VERSION,
        "serialNumber": serial,
        "version": 1,
        "metadata": {
            "timestamp": ts,
            "tools": [
                {
                    "vendor": "adherence.ml",
                    "name": "adherence-ml-sbom",
                    "version": SBOM_SCHEMA_VERSION,
                }
            ],
            "component": {
                "type": "application",
                "bom-ref": f"pkg:generic/adherence-ml@{__version__}",
                "name": "adherence-ml",
                "version": __version__,
                "description": (
                    "Medication adherence prediction API and dashboard."
                ),
            },
            "properties": [
                {"name": "schema_version", "value": SBOM_SCHEMA_VERSION},
                {"name": "ecosystems", "value": "pypi,npm"},
                {"name": "python_source", "value": "uv.lock"},
                {"name": "npm_source", "value": "apps/web/package.json"},
            ],
        },
        "components": components,
    }


@lru_cache(maxsize=1)
def cached_sbom() -> dict[str, Any]:
    """Memoized SBOM for the API route. Recompute by restarting the worker."""
    return build_sbom()


def sbom_summary() -> dict[str, Any]:
    """Lightweight summary for the trust manifest and the UI card.

    Avoids forcing the full SBOM through the manifest endpoint, but
    gives buyers a one-glance shape (component count by ecosystem).
    """
    bom = cached_sbom()
    counts: dict[str, int] = {}
    for c in bom["components"]:
        for p in c.get("properties", []):
            if p.get("name") == "ecosystem":
                counts[p["value"]] = counts.get(p["value"], 0) + 1
                break
    return {
        "spec_version": bom["specVersion"],
        "schema_version": SBOM_SCHEMA_VERSION,
        "serial_number": bom["serialNumber"],
        "total_components": len(bom["components"]),
        "components_by_ecosystem": counts,
        "generated_at": bom["metadata"]["timestamp"],
    }
