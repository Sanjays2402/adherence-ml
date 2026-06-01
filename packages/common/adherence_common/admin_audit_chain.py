"""Tamper-evident hash chain for the admin-plane audit log.

Mirrors :mod:`adherence_common.audit_chain` (which secures
``prediction_audit``) but for ``admin_audit_log`` rows. Every privileged
admin action (api key create/revoke, model rollback, retention sweep,
GDPR erase, SSO config change, ...) is anchored to its predecessor by a
sha256 ``row_hash`` over a canonical tuple of the row's immutable fields
plus the previous row's ``row_hash``. A verifier walks the table in id
order and re-derives every hash. Edits, deletions, and reorderings break
the chain at the first divergence and are reported back to the caller.

The fields covered by the hash are the ones an auditor cares about: who
called, with what role, against which tenant, the action verb, the
target identifier, the redacted details blob, the success flag, the
error message (if any), and the wall-clock timestamp. Auto-increment
``id`` is hashed too so a row that survives deletion of an earlier row
still fails verification (its prev_hash no longer matches).
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select

from adherence_common.db import AdminAuditLog, session

_HASH_FIELDS = (
    "id",
    "tenant_id",
    "request_id",
    "action",
    "target",
    "caller",
    "caller_role",
    "ok",
    "error",
    "details",
    "created_at",
)


def _canonical_payload(row: AdminAuditLog, prev_hash: str | None) -> bytes:
    data: dict[str, Any] = {"prev_hash": prev_hash}
    for f in _HASH_FIELDS:
        v = getattr(row, f, None)
        if hasattr(v, "isoformat"):
            v = v.isoformat()
        data[f] = v
    return json.dumps(
        data, sort_keys=True, separators=(",", ":"), default=str
    ).encode("utf-8")


def compute_row_hash(row: AdminAuditLog, prev_hash: str | None) -> str:
    return hashlib.sha256(_canonical_payload(row, prev_hash)).hexdigest()


def latest_chain_hash_in_session(s, exclude_id: int | None = None) -> str | None:
    """Return the row_hash of the highest-id row not equal to ``exclude_id``."""
    q = select(AdminAuditLog).order_by(AdminAuditLog.id.desc())
    if exclude_id is not None:
        q = q.where(AdminAuditLog.id != exclude_id)
    row = s.scalars(q.limit(1)).first()
    if row is None:
        return None
    return row.row_hash


def assign_chain(row: AdminAuditLog, prev_hash: str | None) -> None:
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


def verify_chain(
    *, tenant_id: str | None = None, limit: int | None = None
) -> VerifyResult:
    """Walk ``admin_audit_log`` in id order and re-derive every row_hash.

    A row is flagged if its stored ``row_hash`` does not match the
    recomputed value, or its ``prev_hash`` does not match the previous
    chained row's ``row_hash``. Legacy rows (NULL row_hash) are tolerated
    as long as the chain restarts cleanly with a NULL prev_hash on the
    next chained row.

    The hash chain is global by design: every admin action across every
    tenant links to the previous global row so deletions can be detected
    even if an attacker only edits their own workspace. ``tenant_id``
    therefore restricts which rows are *counted and reported*, but the
    walk still runs over the full table so prev_hash links validate
    correctly.
    """
    breaks: list[ChainBreak] = []
    n_rows = 0
    n_hashed = 0
    head: str | None = None
    prev_stored: str | None = None
    scope = (tenant_id or "").strip()
    scoped = bool(scope) and scope != "*"
    with session() as s:
        q = select(AdminAuditLog).order_by(AdminAuditLog.id.asc())
        if limit is not None:
            q = q.limit(limit)
        for row in s.scalars(q):
            in_scope = (not scoped) or (row.tenant_id == scope)
            if row.row_hash is None:
                # Legacy or unchained row. Reset the running prev so a
                # successor with NULL prev_hash is treated as a clean
                # restart of the chain.
                prev_stored = None
                head = None
                if in_scope:
                    n_rows += 1
                continue
            if in_scope:
                n_rows += 1
                n_hashed += 1
            expected_prev = prev_stored
            if row.prev_hash != expected_prev:
                if in_scope:
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
                if in_scope:
                    breaks.append(
                        ChainBreak(
                            row_id=int(row.id),
                            reason="row_hash_mismatch",
                            expected=recomputed,
                            actual=row.row_hash,
                        )
                    )
            prev_stored = row.row_hash
            if in_scope:
                head = row.row_hash
    return VerifyResult(
        n_rows=n_rows,
        n_hashed=n_hashed,
        ok=not breaks,
        breaks=breaks,
        head_hash=head,
    )
