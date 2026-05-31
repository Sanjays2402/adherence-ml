"""/v1/webhooks/event-catalog: introspect the canonical event catalog.

Returned to any authenticated caller so customer admins and procurement
reviewers can see (a) every event type this API can emit, (b) the
payload schema and an example body, (c) stability flags, and (d) the
catalog version. Subscriptions reject any event_type not listed here.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from adherence_api.deps import current_principal
from adherence_common import webhook_events as webhook_catalog

router = APIRouter(prefix="/v1/webhooks", tags=["webhooks"])


@router.get("/event-catalog")
def list_event_catalog(
    p: dict = Depends(current_principal),
) -> dict:
    """Return the full webhook event catalog plus a summary header."""
    return {
        **webhook_catalog.catalog_summary(),
        "stable_event_types": webhook_catalog.stable_event_types(),
        "events": webhook_catalog.all_events(),
    }
