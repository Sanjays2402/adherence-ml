"""OIDC SSO exchange and provider discovery (enterprise SSO).

This module lets enterprise buyers wire Okta / Azure AD / Google Workspace
in front of the API without disturbing the existing API-key + HS256 JWT
auth path. A verified OIDC ID token is exchanged for a short-lived
internal JWT minted by :func:`adherence_common.auth.mint_jwt`. Every
exchange (success and failure) writes to the admin audit log.
"""
from __future__ import annotations

from adherence_common.admin_audit import record_admin_action
from adherence_common.auth import mint_jwt
from adherence_common.errors import AuthError
from adherence_common.oidc import (
    OidcIdentity,
    list_providers,
    map_identity_to_principal,
    verify_id_token,
)
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import SettingsDep

router = APIRouter(prefix="/v1/admin/sso", tags=["admin"])


class ProviderInfo(BaseModel):
    name: str
    issuer: str
    audience_suffix: str = Field(
        description="Last 6 chars of the configured audience (client id); the full "
        "value is never returned over the wire.",
    )


class ProvidersResponse(BaseModel):
    enabled: bool
    providers: list[ProviderInfo]


class OidcExchangeRequest(BaseModel):
    provider: str = Field(min_length=1, max_length=64)
    id_token: str = Field(min_length=16, max_length=8192)


class OidcExchangeResponse(BaseModel):
    token: str
    expires_in: int
    role: str
    tenant: str
    subject: str
    email: str | None


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


@router.get("/providers", response_model=ProvidersResponse)
def get_providers(settings: SettingsDep) -> ProvidersResponse:
    """Public list of configured OIDC providers.

    Returned audience is suffix-only so the response is safe to surface on
    a sign-in page without leaking the full OAuth client id.
    """
    provs = list_providers(settings)
    return ProvidersResponse(
        enabled=bool(provs),
        providers=[
            ProviderInfo(
                name=p.name,
                issuer=p.issuer,
                audience_suffix=(p.audience[-6:] if len(p.audience) >= 6 else p.audience),
            )
            for p in provs
        ],
    )


@router.post("/oidc/exchange", response_model=OidcExchangeResponse)
def exchange_oidc(
    req: OidcExchangeRequest,
    settings: SettingsDep,
    request: Request,
) -> OidcExchangeResponse:
    """Verify a third-party OIDC ID token and mint an internal JWT.

    No bearer/API key is required to call this route. The trust boundary
    is the IdP's RSA signature on the ID token plus the configured
    audience/issuer match. The minted JWT carries the resolved role and
    tenant claims and is accepted by every downstream route via the same
    Authorization: Bearer code path as direct token mint.
    """
    audit_principal = {
        "sub": "sso:anonymous",
        "role": "viewer",
        "tenant": settings.default_tenant,
    }

    try:
        identity: OidcIdentity = verify_id_token(req.id_token, req.provider, settings)
    except AuthError as exc:
        record_admin_action(
            action="sso.oidc.exchange",
            principal=audit_principal,
            target=req.provider,
            details={"reason": str(exc)},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=str(exc))

    try:
        role, tenant = map_identity_to_principal(identity, settings)
    except AuthError as exc:
        record_admin_action(
            action="sso.oidc.exchange",
            principal={"sub": f"sso:{identity.email or identity.sub}",
                       "role": "viewer", "tenant": settings.default_tenant},
            target=req.provider,
            details={"reason": str(exc), "email": identity.email},
            ok=False,
            error=str(exc),
            request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail=str(exc))

    subject = f"sso:{identity.provider}:{identity.email or identity.sub}"
    token = mint_jwt(subject, role, settings, tenant=tenant)  # type: ignore[arg-type]

    record_admin_action(
        action="sso.oidc.exchange",
        principal={"sub": subject, "role": role, "tenant": tenant},
        target=req.provider,
        details={
            "email": identity.email,
            "issuer": identity.issuer,
            "role": role,
            "tenant": tenant,
            "ttl_seconds": settings.jwt_ttl_seconds,
        },
        request_id=_rid(request),
        tenant_id=tenant,
    )

    return OidcExchangeResponse(
        token=token,
        expires_in=settings.jwt_ttl_seconds,
        role=role,
        tenant=tenant,
        subject=subject,
        email=identity.email,
    )
