"""Helpers for ``?dry_run=true`` on destructive endpoints.

Enterprise change-management workflows often require operators to preview
what a destructive call will do before they run it for real. Every
DELETE-style route exposes a ``dry_run`` query parameter. When set, the
route returns the same envelope it would have on success, except:

* No row is mutated, deleted, or revoked.
* The response includes ``"dry_run": true`` and a ``"would_..."`` flag
  describing the action that was inhibited.
* If the target does not exist, the response is HTTP 404 with the same
  error body the real call would have produced. (You cannot dry-run a
  delete against something that is not there; that is itself useful
  signal.)
* Admin audit log entries are still written, tagged with
  ``details["dry_run"] = True``, so SOC2 reviewers can see who probed
  what.

Use this helper to keep the response shape consistent across every
endpoint.
"""
from __future__ import annotations

from typing import Any


def dry_run_response(*, would: str, **fields: Any) -> dict[str, Any]:
    """Build a uniform dry-run response envelope.

    ``would`` is the verb that was simulated (e.g. ``"delete"``,
    ``"revoke"``). Additional keys are merged in so callers can include
    the target identifier.
    """
    out: dict[str, Any] = {"dry_run": True, f"would_{would}": True}
    out.update(fields)
    return out
