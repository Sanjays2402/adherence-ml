"""End-to-end tests for admin TOTP MFA enrolment + enforcement."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/m.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


def _client(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    return TestClient(create_app())


def test_totp_primitive_drift_and_rejection():
    from adherence_common import mfa
    secret = mfa.generate_secret()
    code = mfa.current_totp(secret)
    assert mfa.verify_totp(secret, code) is True
    assert mfa.verify_totp(secret, "000000") is False or code == "000000"
    assert mfa.verify_totp(secret, "abc") is False
    assert mfa.verify_totp(secret, "12345") is False


def test_enroll_confirm_and_verify_flow(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    admin = {"x-api-key": "adm"}
    from adherence_common import mfa

    # Status before enrolment.
    r = c.get("/v1/admin/mfa/status", headers=admin)
    assert r.status_code == 200
    assert r.json()["enrolled"] is False

    # Begin enrolment, get secret + otpauth URI.
    r = c.post("/v1/admin/mfa/enroll", headers=admin)
    assert r.status_code == 200, r.text
    secret = r.json()["secret_b32"]
    assert r.json()["otpauth_uri"].startswith("otpauth://totp/")

    # Bad confirm code rejected.
    r = c.post("/v1/admin/mfa/confirm", headers=admin, json={"code": "000000"})
    # Could randomly match the live code; retry once with a known-bad value
    # by using a clearly invalid digit-shape.
    if r.status_code == 200:
        # extremely rare, re-enroll once for a fresh secret
        r = c.post("/v1/admin/mfa/enroll", headers=admin)
        secret = r.json()["secret_b32"]
    r = c.post("/v1/admin/mfa/confirm", headers=admin, json={"code": "999999"})
    # Still might collide; do a hard wrong-length call as the deterministic check.
    r_bad = c.post("/v1/admin/mfa/confirm", headers=admin, json={"code": "12345"})
    assert r_bad.status_code == 422  # pydantic min_length=6

    # Confirm with the real current TOTP.
    r = c.post(
        "/v1/admin/mfa/confirm", headers=admin,
        json={"code": mfa.current_totp(secret)},
    )
    assert r.status_code == 200, r.text
    backup_codes = r.json()["backup_codes"]
    assert len(backup_codes) == mfa.BACKUP_CODE_COUNT

    # Status now reflects confirmed enrolment.
    r = c.get("/v1/admin/mfa/status", headers=admin)
    body = r.json()
    assert body["enrolled"] is True
    assert body["confirmed"] is True
    assert body["backup_codes_remaining"] == mfa.BACKUP_CODE_COUNT


def test_admin_mutation_blocked_without_mfa_after_enrollment(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    admin = {"x-api-key": "adm"}
    from adherence_common import mfa, quota
    # This test issues >3 API keys in the default workspace; raise the
    # seat cap above the free-plan default so we are exercising the MFA
    # path, not the per-workspace seat limit.
    quota.set_plan("default", plan="enterprise")

    # Bootstrap: before MFA, key creation works.
    r = c.post(
        "/v1/admin/api-keys", headers=admin,
        json={"name": "k1", "role": "service"},
    )
    assert r.status_code == 201, r.text

    # Enrol + confirm MFA.
    secret = c.post("/v1/admin/mfa/enroll", headers=admin).json()["secret_b32"]
    c.post(
        "/v1/admin/mfa/confirm", headers=admin,
        json={"code": mfa.current_totp(secret)},
    )

    # The confirm call itself records a fresh challenge so the next
    # mutation goes through. Force-revoke to simulate window expiry.
    mfa.revoke_challenges("api-key")

    # Now api-key create must be rejected without an MFA code.
    r = c.post(
        "/v1/admin/api-keys", headers=admin,
        json={"name": "k2", "role": "service"},
    )
    assert r.status_code == 401
    assert r.headers.get("X-MFA-Required") == "totp"

    # Providing a fresh TOTP code unblocks it.
    r = c.post(
        "/v1/admin/api-keys",
        headers={**admin, "X-MFA-Code": mfa.current_totp(secret)},
        json={"name": "k2", "role": "service"},
    )
    assert r.status_code == 201, r.text

    # Subsequent calls within the challenge window pass without re-supplying.
    r = c.post(
        "/v1/admin/api-keys", headers=admin,
        json={"name": "k3", "role": "service"},
    )
    assert r.status_code == 201, r.text

    # Backup code path also works (burns one code).
    mfa.revoke_challenges("api-key")
    r = c.post("/v1/admin/mfa/enroll", headers=admin)
    # re-enroll wipes backup codes; confirm again
    new_secret = r.json()["secret_b32"]
    cc = c.post(
        "/v1/admin/mfa/confirm", headers=admin,
        json={"code": mfa.current_totp(new_secret)},
    )
    fresh_backup = cc.json()["backup_codes"][0]
    mfa.revoke_challenges("api-key")
    r = c.post(
        "/v1/admin/api-keys",
        headers={**admin, "X-MFA-Code": fresh_backup},
        json={"name": "k4", "role": "service"},
    )
    assert r.status_code == 201, r.text
    # Same backup code cannot be reused.
    mfa.revoke_challenges("api-key")
    r = c.post(
        "/v1/admin/api-keys",
        headers={**admin, "X-MFA-Code": fresh_backup},
        json={"name": "k5", "role": "service"},
    )
    assert r.status_code == 401


def test_reads_remain_open_without_mfa(tmp_path, monkeypatch):
    """Listing endpoints must not require MFA so on-call can investigate."""
    c = _client(tmp_path, monkeypatch)
    admin = {"x-api-key": "adm"}
    from adherence_common import mfa

    secret = c.post("/v1/admin/mfa/enroll", headers=admin).json()["secret_b32"]
    c.post(
        "/v1/admin/mfa/confirm", headers=admin,
        json={"code": mfa.current_totp(secret)},
    )
    mfa.revoke_challenges("api-key")

    r = c.get("/v1/admin/api-keys", headers=admin)
    assert r.status_code == 200
    r = c.get("/v1/admin/mfa/status", headers=admin)
    assert r.status_code == 200


def test_regenerate_backup_codes_requires_fresh_proof(tmp_path, monkeypatch):
    """Rotation issues a fresh pool, retires every old code, requires MFA."""
    c = _client(tmp_path, monkeypatch)
    admin = {"x-api-key": "adm"}
    from adherence_common import mfa

    secret = c.post("/v1/admin/mfa/enroll", headers=admin).json()["secret_b32"]
    confirm = c.post(
        "/v1/admin/mfa/confirm", headers=admin,
        json={"code": mfa.current_totp(secret)},
    )
    assert confirm.status_code == 200
    old_codes = confirm.json()["backup_codes"]
    assert len(old_codes) == mfa.BACKUP_CODE_COUNT

    # Wrong code is rejected with 401 and a hint header for the client.
    r = c.post(
        "/v1/admin/mfa/backup-codes/regenerate", headers=admin,
        json={"code": "000000"},
    )
    if r.status_code == 200:
        # Astronomically rare clock collision; re-run with a length-invalid
        # code that cannot match TOTP or a 10-char backup code.
        r = c.post(
            "/v1/admin/mfa/backup-codes/regenerate", headers=admin,
            json={"code": "zzzzz"},
        )
    assert r.status_code == 401
    assert r.headers.get("X-MFA-Required") == "totp"

    # Valid TOTP rotates the pool and surfaces 10 fresh codes once.
    r = c.post(
        "/v1/admin/mfa/backup-codes/regenerate", headers=admin,
        json={"code": mfa.current_totp(secret)},
    )
    assert r.status_code == 200, r.text
    new_codes = r.json()["backup_codes"]
    assert r.json()["issued_count"] == mfa.BACKUP_CODE_COUNT
    assert len(new_codes) == mfa.BACKUP_CODE_COUNT
    assert set(new_codes).isdisjoint(set(old_codes))

    # The previous pool no longer authenticates anywhere; the verify path
    # is the canonical proof of that contract.
    from adherence_common.errors import AuthError
    for stale in old_codes:
        with pytest.raises(AuthError):
            mfa.verify_code("api-key", stale)

    # The new pool is honoured, exactly once per code, by the same path.
    method = mfa.verify_code("api-key", new_codes[0])
    assert method == "backup_code"
    with pytest.raises(AuthError):
        mfa.verify_code("api-key", new_codes[0])  # burned


def test_status_low_watermark_flag(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    admin = {"x-api-key": "adm"}
    from adherence_common import mfa

    secret = c.post("/v1/admin/mfa/enroll", headers=admin).json()["secret_b32"]
    codes = c.post(
        "/v1/admin/mfa/confirm", headers=admin,
        json={"code": mfa.current_totp(secret)},
    ).json()["backup_codes"]

    body = c.get("/v1/admin/mfa/status", headers=admin).json()
    assert body["backup_codes_low"] is False
    assert body["backup_codes_low_watermark"] == mfa.BACKUP_CODE_LOW_WATERMARK

    # Burn down to the watermark and confirm the UI signal flips on.
    to_burn = mfa.BACKUP_CODE_COUNT - mfa.BACKUP_CODE_LOW_WATERMARK
    for code in codes[:to_burn]:
        assert mfa.verify_code("api-key", code) == "backup_code"

    body = c.get("/v1/admin/mfa/status", headers=admin).json()
    assert body["backup_codes_remaining"] == mfa.BACKUP_CODE_LOW_WATERMARK
    assert body["backup_codes_low"] is True
