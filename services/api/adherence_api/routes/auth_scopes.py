"""Scope catalog introspection.

Public (auth-required) endpoint that lets a caller see (a) the full
catalog of canonical scopes the API enforces and (b) the scopes their
own credential currently carries. Procurement reviewers and customer
admins use this to verify that fine-grained scopes are real and not
cosmetic.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from adherence_api.deps import current_principal
from adherence_api.scope_catalog import all_rules, all_scopes, required_scope

router = APIRouter(prefix="/v1/auth", tags=["admin"])


@router.get("/scopes")
def list_scopes(
    request: Request,
    p: dict = Depends(current_principal),
) -> dict:
    """Return the scope catalog and the caller's effective scopes.

    ``effective_scopes`` is the comma-split set carried on a DB-backed
    API key. An empty list paired with ``unlimited_scopes=true`` means
    the credential is not scope-restricted (the role check is the only
    gate). This matches the middleware's enforcement model exactly.
    """
    raw = p.get("scopes", "") or ""
    present = sorted({s for s in raw.split(",") if s})
    return {
        "catalog": all_rules(),
        "scopes": all_scopes(),
        "effective_scopes": present,
        "unlimited_scopes": not present,
        "role": p.get("role"),
        "tenant": p.get("tenant"),
    }


@router.get("/scopes/check")
def check_scope(
    method: str,
    path: str,
    p: dict = Depends(current_principal),
) -> dict:
    """Dry-run a scope decision for ``METHOD path`` without invoking the
    route. Useful for client SDKs that want to fail fast before sending
    a destructive call.
    """
    scope = required_scope(method, path)
    raw = p.get("scopes", "") or ""
    present = {s for s in raw.split(",") if s}
    if scope is None:
        decision = "no_scope_required"
    elif not present:
        decision = "allowed_unlimited"
    elif scope in present:
        decision = "allowed"
    else:
        decision = "denied"
    return {
        "method": method.upper(),
        "path": path,
        "required_scope": scope,
        "decision": decision,
    }
