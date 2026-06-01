"""OIDC SSO verifier for enterprise customers.

Verifies third-party OpenID Connect ID tokens (Google Workspace, Okta,
Azure AD, generic OIDC) using the issuer's JWKS endpoint, then maps the
verified identity to an internal role + tenant. The caller mints a
short-lived internal JWT using the existing :func:`mint_jwt` helper, so
no other route in the codebase needs to change.

Provider configuration is environment-driven:

    ADHERENCE_OIDC_PROVIDERS="google:<client_id>,okta-acme:<client_id>"
    ADHERENCE_OIDC_ISSUERS="google:https://accounts.google.com,okta-acme:https://acme.okta.com"
    ADHERENCE_OIDC_DOMAIN_ROLE_MAP="acme.com:admin,partner.io:viewer"
    ADHERENCE_OIDC_DOMAIN_TENANT_MAP="acme.com:acme,partner.io:partner"
    ADHERENCE_OIDC_DEFAULT_ROLE=viewer
    ADHERENCE_OIDC_REQUIRE_VERIFIED_EMAIL=true

JWKS responses are cached in-process for ``oidc_jwks_cache_seconds`` (default
1 hour) to avoid hammering the IdP on every login.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

import httpx
import jwt
from jwt import PyJWKClient

from adherence_common.errors import AuthError
from adherence_common.settings import Settings

__all__ = [
    "OidcProvider",
    "OidcIdentity",
    "list_providers",
    "get_provider",
    "verify_id_token",
    "map_identity_to_principal",
]


@dataclass(frozen=True)
class OidcProvider:
    name: str
    issuer: str
    audience: str  # OAuth client_id registered with the IdP
    jwks_uri: str | None = None  # optional override; discovered otherwise


@dataclass(frozen=True)
class OidcIdentity:
    sub: str
    email: str | None
    email_verified: bool
    name: str | None
    issuer: str
    provider: str
    raw_claims: dict[str, Any]


# Module-level caches (process-scoped, refreshed on TTL).
_DISCOVERY_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_JWKS_CLIENTS: dict[str, PyJWKClient] = {}


def _parse_csv_map(raw: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in (raw or "").split(","):
        item = item.strip()
        if not item or ":" not in item:
            continue
        k, _, v = item.partition(":")
        k = k.strip()
        v = v.strip()
        if k and v:
            out[k] = v
    return out


def list_providers(settings: Settings) -> list[OidcProvider]:
    audiences = _parse_csv_map(getattr(settings, "oidc_providers", "") or "")
    if not audiences:
        return []
    issuers = _parse_csv_map(getattr(settings, "oidc_issuers", "") or "")
    jwks_overrides = _parse_csv_map(getattr(settings, "oidc_jwks_uris", "") or "")
    out: list[OidcProvider] = []
    for name, aud in audiences.items():
        iss = issuers.get(name)
        if not iss:
            # Sensible defaults for well-known IdPs keyed by provider name prefix.
            if name.startswith("google"):
                iss = "https://accounts.google.com"
            else:
                # Skip silently; missing issuer means provider is misconfigured.
                continue
        out.append(
            OidcProvider(
                name=name,
                issuer=iss.rstrip("/"),
                audience=aud,
                jwks_uri=jwks_overrides.get(name),
            )
        )
    return out


def get_provider(name: str, settings: Settings) -> OidcProvider:
    for p in list_providers(settings):
        if p.name == name:
            return p
    raise AuthError(f"unknown oidc provider {name!r}")


def _discover(provider: OidcProvider, settings: Settings) -> dict[str, Any]:
    ttl = float(getattr(settings, "oidc_jwks_cache_seconds", 3600))
    now = time.time()
    cached = _DISCOVERY_CACHE.get(provider.issuer)
    if cached and (now - cached[0] < ttl):
        return cached[1]
    url = provider.issuer.rstrip("/") + "/.well-known/openid-configuration"
    try:
        r = httpx.get(url, timeout=5.0)
        r.raise_for_status()
        doc = r.json()
    except Exception as exc:  # network / parse
        if cached:
            return cached[1]
        raise AuthError(f"oidc discovery failed for {provider.name}: {exc}") from exc
    _DISCOVERY_CACHE[provider.issuer] = (now, doc)
    return doc


def _jwks_client_for(provider: OidcProvider, settings: Settings) -> PyJWKClient:
    if provider.name in _JWKS_CLIENTS:
        return _JWKS_CLIENTS[provider.name]
    jwks_uri = provider.jwks_uri
    if not jwks_uri:
        doc = _discover(provider, settings)
        jwks_uri = doc.get("jwks_uri")
        if not jwks_uri:
            raise AuthError(f"oidc discovery for {provider.name} missing jwks_uri")
        if jwks_uri.startswith("/"):
            jwks_uri = urljoin(provider.issuer + "/", jwks_uri.lstrip("/"))
    ttl = int(getattr(settings, "oidc_jwks_cache_seconds", 3600))
    client = PyJWKClient(jwks_uri, cache_keys=True, lifespan=ttl)
    _JWKS_CLIENTS[provider.name] = client
    return client


def verify_id_token(
    id_token: str,
    provider_name: str,
    settings: Settings,
    *,
    jwks_client: PyJWKClient | None = None,
) -> OidcIdentity:
    """Verify an OIDC ID token against the configured provider's JWKS.

    Raises :class:`AuthError` on any verification failure.
    """
    provider = get_provider(provider_name, settings)
    client = jwks_client or _jwks_client_for(provider, settings)
    try:
        signing_key = client.get_signing_key_from_jwt(id_token)
    except Exception as exc:
        raise AuthError(f"oidc signing key lookup failed: {exc}") from exc

    try:
        claims = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=["RS256", "RS384", "RS512", "ES256", "ES384"],
            audience=provider.audience,
            issuer=provider.issuer,
            options={"require": ["exp", "iat", "iss", "aud", "sub"]},
            leeway=int(getattr(settings, "oidc_clock_skew_seconds", 60)),
        )
    except jwt.PyJWTError as exc:
        raise AuthError(f"oidc token verification failed: {exc}") from exc

    require_verified = bool(getattr(settings, "oidc_require_verified_email", True))
    email = claims.get("email")
    email_verified = bool(claims.get("email_verified", False))
    if require_verified and email and not email_verified:
        raise AuthError("oidc email not verified by identity provider")

    return OidcIdentity(
        sub=str(claims.get("sub")),
        email=(email.lower() if isinstance(email, str) else None),
        email_verified=email_verified,
        name=claims.get("name"),
        issuer=str(claims.get("iss")),
        provider=provider.name,
        raw_claims=claims,
    )


def map_identity_to_principal(
    identity: OidcIdentity, settings: Settings
) -> tuple[str, str]:
    """Return (role, tenant) for a verified OIDC identity.

    Resolution order:
      1. Per-tenant OIDC group-claim mapping (highest priority match
         from ``tenant_oidc_group_role_map`` for the resolved tenant)
      2. Email-domain role map (``oidc_domain_role_map``)
      3. ``oidc_default_role`` (default ``viewer``)

    Tenant resolution: domain map, else deployment ``default_tenant``.
    The group lookup runs against the resolved tenant so a workspace
    owner can grant access by IdP group without changing global config.

    Unmapped domains raise :class:`AuthError` when
    ``oidc_require_domain_match`` is true (default false).
    """
    default_role = getattr(settings, "oidc_default_role", "viewer") or "viewer"
    domain = identity.email.split("@", 1)[1] if identity.email and "@" in identity.email else ""
    role_map = _parse_csv_map(getattr(settings, "oidc_domain_role_map", "") or "")
    tenant_map = _parse_csv_map(getattr(settings, "oidc_domain_tenant_map", "") or "")
    require_domain = bool(getattr(settings, "oidc_require_domain_match", False))

    # Resolve tenant first so the group lookup is scoped correctly.
    tenant = tenant_map.get(domain) or settings.default_tenant

    # 1. Per-tenant group-claim mapping wins when an IdP group matches.
    role: str | None = None
    try:
        from adherence_common.oidc_group_map import (  # noqa: WPS433
            extract_groups,
            resolve_role_for_groups,
        )
        groups = extract_groups(identity.raw_claims)
        if groups:
            hit = resolve_role_for_groups(tenant, groups)
            if hit is not None:
                role = hit[0]
    except Exception:
        # Group map is best-effort; fall back to the static maps below
        # so a broken DB row never locks every SSO user out.
        role = None

    # 2/3. Fall back to email-domain map, then deployment default.
    if role is None:
        if domain and domain in role_map:
            role = role_map[domain]
        elif require_domain:
            raise AuthError(f"oidc email domain {domain!r} not allowed")
        else:
            role = default_role

    if role not in {"admin", "service", "viewer"}:
        raise AuthError(f"oidc mapped to invalid role {role!r}")

    return role, tenant
