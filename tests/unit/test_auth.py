"""Auth + RBAC tests."""
import pytest

from adherence_common.auth import mint_jwt, require_role, resolve_api_key, verify_jwt
from adherence_common.errors import AuthError, PermissionError_
from adherence_common.settings import Settings


def _s():
    return Settings(jwt_secret="x" * 32, api_keys="admin:a1,service:s1,viewer:v1")


def test_jwt_round_trip():
    s = _s()
    tok = mint_jwt("alice", "admin", s)
    claims = verify_jwt(tok, s)
    assert claims["sub"] == "alice" and claims["role"] == "admin"


def test_api_key_resolve_and_unknown():
    s = _s()
    assert resolve_api_key("a1", s) == "admin"
    with pytest.raises(AuthError):
        resolve_api_key("nope", s)


def test_rbac_hierarchy():
    require_role("admin", "viewer")
    require_role("service", "service")
    with pytest.raises(PermissionError_):
        require_role("viewer", "admin")
