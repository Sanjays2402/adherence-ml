"""Public ``/.well-known`` endpoints for procurement scanners.

These endpoints are intentionally unauthenticated and tenant-free:
they describe the deployment, not any customer data. Both are exempt
from rate limiting at the marketing-cache layer (still subject to
process-wide protection via the upstream proxy) and are explicitly
listed in the middleware exempt sets so a hardened tenant
configuration cannot accidentally hide its own trust signals from a
security reviewer.

* ``GET /.well-known/security.txt`` (RFC 9116)
* ``GET /.well-known/security.json`` (machine-readable trust manifest)
* ``GET /.well-known/sbom.json`` (CycloneDX 1.5 software bill of materials)

Both endpoints set ``Cache-Control: public, max-age=300`` so an
external scanner that pulls them repeatedly does not generate noise in
the audit log (they don't write one) or in the rate-limit counters.
"""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from adherence_common.settings import get_settings
from adherence_common.sbom import cached_sbom
from adherence_common.trust_manifest import build_manifest

router = APIRouter(prefix="/.well-known", tags=["well-known"])

# A static RFC 9116 body. Mirrors apps/web/public/.well-known/security.txt
# so the marketing host and the API host advertise the same contact
# channels. Keep the Expires date in sync with the web copy.
_SECURITY_TXT = """\
Contact: mailto:security@adherence.ml
Contact: https://github.com/Sanjays2402/adherence-ml/security/advisories/new
Expires: 2027-01-01T00:00:00.000Z
Preferred-Languages: en
Canonical: https://api.adherence.ml/.well-known/security.txt
Policy: https://adherence.ml/trust
Acknowledgments: https://adherence.ml/trust#acknowledgments
"""


@router.get(
    "/security.txt",
    response_class=PlainTextResponse,
    summary="RFC 9116 vulnerability disclosure contacts",
    include_in_schema=True,
)
def security_txt() -> PlainTextResponse:
    resp = PlainTextResponse(_SECURITY_TXT, media_type="text/plain; charset=utf-8")
    resp.headers["Cache-Control"] = "public, max-age=300"
    return resp


@router.get(
    "/security.json",
    summary="Machine-readable trust manifest for procurement scanners",
    include_in_schema=True,
)
def security_json(request: Request) -> JSONResponse:
    settings = get_settings()
    api_base = getattr(settings, "public_api_base", None)
    web_base = getattr(settings, "public_web_base", None)
    manifest = build_manifest(api_base=api_base, web_base=web_base)
    resp = JSONResponse(manifest)
    resp.headers["Cache-Control"] = "public, max-age=300"
    # Echo the request id so a scanner can correlate the response with
    # their own probe log without us writing an audit row.
    rid = getattr(request.state, "request_id", None)
    if rid:
        resp.headers["X-Request-Id"] = rid
    return resp


@router.get(
    "/sbom.json",
    summary="CycloneDX 1.5 software bill of materials",
    include_in_schema=True,
)
def sbom_json(request: Request) -> JSONResponse:
    """Public CycloneDX 1.5 SBOM.

    Generated deterministically from ``uv.lock`` and
    ``apps/web/package.json``. The same build of the application
    always produces a byte-identical document; the ``serialNumber``
    is a content hash so buyers can diff revisions without diffing
    timestamps.

    Unauthenticated by design. Buyers must be able to retrieve this
    during procurement, before any contract or credential exists.
    """
    bom = cached_sbom()
    resp = JSONResponse(bom, media_type="application/vnd.cyclonedx+json")
    resp.headers["Cache-Control"] = "public, max-age=300"
    rid = getattr(request.state, "request_id", None)
    if rid:
        resp.headers["X-Request-Id"] = rid
    return resp
