"""OIDC SSO verifier tests.

These tests use a real RSA keypair to sign a real ID token, then hand a
fake :class:`jwt.PyJWKClient` to :func:`verify_id_token` so no network
calls are made. This is the same code path production hits once the
JWKS document has been fetched and cached.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from adherence_common.errors import AuthError
from adherence_common.oidc import (
    list_providers,
    map_identity_to_principal,
    verify_id_token,
)
from adherence_common.settings import Settings


ISSUER = "https://idp.example.com"
AUDIENCE = "client-abc-123456"


@dataclass
class _FakeKey:
    key: object


class _FakeJWKSClient:
    def __init__(self, public_key):
        self._key = public_key

    def get_signing_key_from_jwt(self, token: str):  # noqa: D401
        return _FakeKey(self._key)


def _gen_keypair():
    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pub_pem = priv.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    priv_pem = priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return priv_pem, pub_pem, priv.public_key()


def _settings(**over) -> Settings:
    base = dict(
        jwt_secret="x" * 32,
        oidc_providers=f"acme:{AUDIENCE}",
        oidc_issuers=f"acme:{ISSUER}",
        oidc_domain_role_map="acme.com:admin,partner.io:viewer",
        oidc_domain_tenant_map="acme.com:acme,partner.io:partner",
        oidc_default_role="viewer",
        oidc_require_verified_email=True,
    )
    base.update(over)
    return Settings(**base)


def _sign_id_token(priv_pem, **claims):
    now = int(time.time())
    payload = {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "sub": "user-1",
        "iat": now,
        "exp": now + 300,
        "email": "alice@acme.com",
        "email_verified": True,
        "name": "Alice",
    }
    payload.update(claims)
    return jwt.encode(payload, priv_pem, algorithm="RS256")


def test_list_providers_empty_when_unconfigured():
    s = Settings(jwt_secret="x" * 32)
    assert list_providers(s) == []


def test_list_providers_parses_csv():
    s = _settings()
    provs = list_providers(s)
    assert len(provs) == 1 and provs[0].name == "acme"
    assert provs[0].issuer == ISSUER
    assert provs[0].audience == AUDIENCE


def test_verify_id_token_happy_path_and_mapping():
    priv, _, pub = _gen_keypair()
    s = _settings()
    token = _sign_id_token(priv)
    identity = verify_id_token(token, "acme", s, jwks_client=_FakeJWKSClient(pub))
    assert identity.email == "alice@acme.com"
    assert identity.email_verified is True
    role, tenant = map_identity_to_principal(identity, s)
    assert role == "admin"
    assert tenant == "acme"


def test_verify_id_token_rejects_wrong_audience():
    priv, _, pub = _gen_keypair()
    s = _settings()
    bad = _sign_id_token(priv, aud="someone-else")
    with pytest.raises(AuthError):
        verify_id_token(bad, "acme", s, jwks_client=_FakeJWKSClient(pub))


def test_verify_id_token_rejects_wrong_issuer():
    priv, _, pub = _gen_keypair()
    s = _settings()
    bad = _sign_id_token(priv, iss="https://evil.example.com")
    with pytest.raises(AuthError):
        verify_id_token(bad, "acme", s, jwks_client=_FakeJWKSClient(pub))


def test_verify_id_token_rejects_unverified_email():
    priv, _, pub = _gen_keypair()
    s = _settings()
    bad = _sign_id_token(priv, email_verified=False)
    with pytest.raises(AuthError):
        verify_id_token(bad, "acme", s, jwks_client=_FakeJWKSClient(pub))


def test_verify_id_token_rejects_tampered_signature():
    priv, _, pub = _gen_keypair()
    other_priv, _, _ = _gen_keypair()
    s = _settings()
    forged = _sign_id_token(other_priv)
    with pytest.raises(AuthError):
        verify_id_token(forged, "acme", s, jwks_client=_FakeJWKSClient(pub))


def test_unmapped_domain_uses_default_role():
    priv, _, pub = _gen_keypair()
    s = _settings(oidc_default_role="viewer")
    tok = _sign_id_token(priv, email="bob@random.io")
    ident = verify_id_token(tok, "acme", s, jwks_client=_FakeJWKSClient(pub))
    role, tenant = map_identity_to_principal(ident, s)
    assert role == "viewer"
    assert tenant == "default"


def test_unmapped_domain_rejected_when_required():
    priv, _, pub = _gen_keypair()
    s = _settings(oidc_require_domain_match=True)
    tok = _sign_id_token(priv, email="bob@random.io")
    ident = verify_id_token(tok, "acme", s, jwks_client=_FakeJWKSClient(pub))
    with pytest.raises(AuthError):
        map_identity_to_principal(ident, s)


def test_providers_route_returns_suffix_only():
    """End-to-end: /v1/admin/sso/providers exposes config without leaking the
    full audience id, and is reachable without auth (sign-in page bootstrap)."""
    from adherence_api.app import create_app
    from adherence_api.deps import get_settings as deps_get_settings

    s = _settings()
    app = create_app()
    app.dependency_overrides[deps_get_settings] = lambda: s
    client = TestClient(app)
    r = client.get("/v1/admin/sso/providers")
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is True
    assert body["providers"][0]["name"] == "acme"
    assert body["providers"][0]["audience_suffix"] == AUDIENCE[-6:]
    # The full audience must not appear anywhere in the response payload.
    assert AUDIENCE not in json.dumps(body)


def test_oidc_exchange_route_mints_internal_jwt(monkeypatch):
    """End-to-end: POST /v1/admin/sso/oidc/exchange verifies a real RSA-signed
    token (via a patched JWKS client) and returns a working internal JWT."""
    from adherence_api.app import create_app
    from adherence_api.deps import get_settings as deps_get_settings
    from adherence_common import oidc as oidc_mod

    priv, _, pub = _gen_keypair()
    s = _settings()
    monkeypatch.setattr(
        oidc_mod, "_jwks_client_for", lambda provider, settings: _FakeJWKSClient(pub)
    )

    app = create_app()
    app.dependency_overrides[deps_get_settings] = lambda: s
    client = TestClient(app)

    token = _sign_id_token(priv)
    r = client.post(
        "/v1/admin/sso/oidc/exchange",
        json={"provider": "acme", "id_token": token},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["role"] == "admin"
    assert body["tenant"] == "acme"
    assert body["email"] == "alice@acme.com"

    # The minted token should be a valid internal JWT and acceptable on a
    # protected route (predict requires viewer; admin clears that).
    minted = body["token"]
    decoded = jwt.decode(minted, s.jwt_secret, algorithms=[s.jwt_alg])
    assert decoded["role"] == "admin"
    assert decoded["tenant"] == "acme"


def test_oidc_exchange_route_rejects_bad_token(monkeypatch):
    from adherence_api.app import create_app
    from adherence_api.deps import get_settings as deps_get_settings
    from adherence_common import oidc as oidc_mod

    _, _, pub = _gen_keypair()
    other_priv, _, _ = _gen_keypair()
    s = _settings()
    monkeypatch.setattr(
        oidc_mod, "_jwks_client_for", lambda provider, settings: _FakeJWKSClient(pub)
    )

    app = create_app()
    app.dependency_overrides[deps_get_settings] = lambda: s
    client = TestClient(app)
    forged = _sign_id_token(other_priv)
    r = client.post(
        "/v1/admin/sso/oidc/exchange",
        json={"provider": "acme", "id_token": forged},
    )
    assert r.status_code == 401
