"""Tamper-evident hash chain for the prediction audit log.

Each ``PredictionAudit`` row carries ``prev_hash`` (the ``row_hash`` of the
row with the previous ``id``, or NULL for genesis) and ``row_hash`` (sha256
over a canonical tuple of the row's immutable fields plus ``prev_hash``).
A verifier can re-derive every ``row_hash`` and confirm the chain is
contiguous. Edits, deletions, or reorderings break the chain at the first
divergence and are reported by ``verify_chain``.

The fields covered by the hash are the ones an auditor cares about: who
called, what route, which model, when, the response summary, and the
result. Latency is excluded (jitter, environment-dependent).
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select

from adherence_common.db import PredictionAudit, session

_HASH_FIELDS = (
    "id",
    "request_id",
    "route",
    "user_id",
    "caller",
    "caller_role",
    "model_name",
    "model_version",
    "shadow_model_name",
    "shadow_model_version",
    "n_doses",
    "mean_miss_prob",
    "max_miss_prob",
    "high_risk_count",
    "shadow_max_divergence",
    "ok",
    "error",
    "response_summary",
    "created_at",
)


def _canonical_payload(row: PredictionAudit, prev_hash: str | None) -> bytes:
    """Build a deterministic bytes payload for hashing one row."""
    data: dict[str, Any] = {"prev_hash": prev_hash}
    for f in _HASH_FIELDS:
        v = getattr(row, f, None)
        if hasattr(v, "isoformat"):
            v = v.isoformat()
        data[f] = v
    # ``sort_keys`` plus a fixed separators tuple guarantees byte-stable output
    # regardless of insertion order or Python dict reordering.
    return json.dumps(data, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")


def compute_row_hash(row: PredictionAudit, prev_hash: str | None) -> str:
    return hashlib.sha256(_canonical_payload(row, prev_hash)).hexdigest()


def latest_chain_hash() -> str | None:
    """Return the ``row_hash`` of the highest-id row, or ``None`` if empty."""
    with session() as s:
        row = s.scalars(
            select(PredictionAudit).order_by(PredictionAudit.id.desc()).limit(1)
        ).first()
        if row is None:
            return None
        return row.row_hash


def latest_chain_hash_in_session(s, exclude_id: int | None = None) -> str | None:
    """Like :func:`latest_chain_hash` but uses an open session.

    ``exclude_id`` skips a freshly-flushed row that has not yet been chained,
    so we read the prior head not the row we're about to hash.
    """
    q = select(PredictionAudit).order_by(PredictionAudit.id.desc())
    if exclude_id is not None:
        q = q.where(PredictionAudit.id != exclude_id)
    row = s.scalars(q.limit(1)).first()
    if row is None:
        return None
    return row.row_hash


def assign_chain(row: PredictionAudit, prev_hash: str | None) -> None:
    """Populate ``prev_hash`` and ``row_hash`` on a row that has an ``id``."""
    row.prev_hash = prev_hash
    row.row_hash = compute_row_hash(row, prev_hash)


@dataclass
class ChainBreak:
    row_id: int
    reason: str
    expected: str | None
    actual: str | None


@dataclass
class VerifyResult:
    n_rows: int
    n_hashed: int
    ok: bool
    breaks: list[ChainBreak]
    head_hash: str | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "n_rows": self.n_rows,
            "n_hashed": self.n_hashed,
            "ok": self.ok,
            "head_hash": self.head_hash,
            "breaks": [
                {
                    "row_id": b.row_id,
                    "reason": b.reason,
                    "expected": b.expected,
                    "actual": b.actual,
                }
                for b in self.breaks
            ],
        }


def verify_chain(limit: int | None = None) -> VerifyResult:
    """Walk the audit table in ``id`` order and re-derive every ``row_hash``.

    A row is flagged if:
      * its stored ``row_hash`` does not match the recomputed value,
      * its ``prev_hash`` does not match the previous row's ``row_hash``,
      * the row predates the chain rollout (``row_hash`` is NULL) and any
        later row claims a non-NULL ``prev_hash`` pointing to it.

    NULL hashes on legacy rows are tolerated as long as the chain restarts
    cleanly (next row has NULL ``prev_hash``). This keeps the verifier
    useful on databases that existed before the feature shipped.
    """
    breaks: list[ChainBreak] = []
    n_rows = 0
    n_hashed = 0
    head: str | None = None
    prev_stored: str | None = None
    with session() as s:
        q = select(PredictionAudit).order_by(PredictionAudit.id.asc())
        if limit is not None:
            q = q.limit(limit)
        for row in s.scalars(q):
            n_rows += 1
            if row.row_hash is None:
                # Legacy row; carry None forward so a next chained row must
                # restart with prev_hash = NULL.
                prev_stored = None
                head = None
                continue
            n_hashed += 1
            expected_prev = prev_stored
            if row.prev_hash != expected_prev:
                breaks.append(
                    ChainBreak(
                        row_id=int(row.id),
                        reason="prev_hash_mismatch",
                        expected=expected_prev,
                        actual=row.prev_hash,
                    )
                )
            recomputed = compute_row_hash(row, row.prev_hash)
            if recomputed != row.row_hash:
                breaks.append(
                    ChainBreak(
                        row_id=int(row.id),
                        reason="row_hash_mismatch",
                        expected=recomputed,
                        actual=row.row_hash,
                    )
                )
            prev_stored = row.row_hash
            head = row.row_hash
    return VerifyResult(
        n_rows=n_rows,
        n_hashed=n_hashed,
        ok=not breaks,
        breaks=breaks,
        head_hash=head,
    )
