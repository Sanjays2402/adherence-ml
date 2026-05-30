"""Disk-backed model registry."""
from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import joblib

from adherence_common.errors import ModelNotFoundError
from adherence_common.settings import get_settings


@dataclass
class ModelArtifact:
    name: str
    version: str
    path: str
    created_at: float = field(default_factory=time.time)
    metrics: dict[str, float] = field(default_factory=dict)
    feature_columns: list[str] = field(default_factory=list)
    notes: str = ""


class ModelRegistry:
    def __init__(self, root: Path | None = None):
        self.root = Path(root) if root else get_settings().model_registry
        self.root.mkdir(parents=True, exist_ok=True)

    def _index_path(self, name: str) -> Path:
        return self.root / f"{name}_index.json"

    def _load_index(self, name: str) -> list[dict]:
        p = self._index_path(name)
        if not p.exists():
            return []
        return json.loads(p.read_text())

    def _save_index(self, name: str, items: list[dict]) -> None:
        self._index_path(name).write_text(json.dumps(items, indent=2, default=str))

    def save(self, name: str, model, metrics: dict[str, float], notes: str = "") -> ModelArtifact:
        ver = time.strftime("%Y%m%d-%H%M%S")
        fname = self.root / f"{name}__{ver}.joblib"
        joblib.dump(model, fname)
        art = ModelArtifact(
            name=name,
            version=ver,
            path=str(fname),
            metrics=metrics,
            feature_columns=list(getattr(model, "feature_columns", [])),
            notes=notes,
        )
        items = self._load_index(name)
        items.append(asdict(art))
        self._save_index(name, items)
        return art

    def list(self, name: str | None = None) -> list[ModelArtifact]:
        if name:
            return [ModelArtifact(**i) for i in self._load_index(name)]
        out: list[ModelArtifact] = []
        for idx in self.root.glob("*_index.json"):
            for it in json.loads(idx.read_text()):
                out.append(ModelArtifact(**it))
        return out

    def load(self, name: str, version: str | None = None) -> tuple[ModelArtifact, object]:
        items = self._load_index(name)
        if not items:
            raise ModelNotFoundError(f"no models registered under {name!r}")
        if version is None:
            item = items[-1]
        else:
            cand = [i for i in items if i["version"] == version]
            if not cand:
                raise ModelNotFoundError(f"{name} v{version} not found")
            item = cand[0]
        art = ModelArtifact(**item)
        model = joblib.load(art.path)
        return art, model

    def latest(self, name: str) -> tuple[ModelArtifact, object]:
        return self.load(name, version=None)

    def promote(self, source: str, target: str,
                version: str | None = None) -> ModelArtifact:
        """Register `source` (optionally a specific version) as the latest entry
        under `target`. The underlying joblib file is shared, so promotion is
        cheap and reversible.
        """
        items = self._load_index(source)
        if not items:
            raise ModelNotFoundError(
                f"cannot promote: no models under {source!r}")
        if version is None:
            src_item = items[-1]
        else:
            cand = [i for i in items if i["version"] == version]
            if not cand:
                raise ModelNotFoundError(
                    f"{source} v{version} not found")
            src_item = cand[0]
        promoted = dict(src_item)
        notes = promoted.get("notes") or ""
        suffix = (
            f"promoted from {source}@{src_item['version']}"
        )
        promoted["notes"] = f"{notes}; {suffix}" if notes else suffix
        promoted["name"] = target
        target_items = self._load_index(target)
        target_items.append(promoted)
        self._save_index(target, target_items)
        return ModelArtifact(**promoted)
