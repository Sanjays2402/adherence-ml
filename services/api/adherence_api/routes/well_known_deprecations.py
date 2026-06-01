"""Public ``/.well-known/api-deprecations`` endpoint.

Procurement scanners, SDK release pipelines, and integration partners
need to pull the API lifecycle policy without authenticating. This
endpoint returns the same registry the admin UI sees, minus the
``created_by`` audit field, with a short cache header so a scanner
that polls hourly does not move the rate-limit needle.
"""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from adherence_common.api_deprecations import list_entries

router = APIRouter(prefix="/.well-known", tags=["well-known"])


@router.get(
    "/api-deprecations",
    summary="Machine-readable API deprecation and sunset registry",
)
def public_api_deprecations() -> JSONResponse:
    entries = list_entries()
    body = {
        "spec": [
            "https://datatracker.ietf.org/doc/html/rfc8594",
            "https://datatracker.ietf.org/doc/draft-ietf-httpapi-deprecation-header/",
        ],
        "description": (
            "Endpoints listed here are deprecated. The Sunset date is "
            "the earliest possible removal date. Clients should migrate "
            "before that date. Live response headers carry the same "
            "information per request."
        ),
        "entries": [e.to_public() for e in entries],
    }
    resp = JSONResponse(body)
    resp.headers["Cache-Control"] = "public, max-age=300"
    return resp
