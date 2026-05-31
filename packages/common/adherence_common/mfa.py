"""TOTP-based multi-factor authentication for admin actions (RFC 6238).

Procurement reviews almost always block on the question "do privileged
operators authenticate with MFA?". This module backs that requirement
with a real, dependency-free TOTP implementation:

* Per-principal enrolment stores a base32-encoded shared secret plus
  hashed single-use backup codes in ``admin_mfa_enrollments``.
* Verification uses HMAC-SHA1 over a 30-second time step with a +/-1
  step window for clock drift, matching Google Authenticator / Authy /
  1Password / Okta Verify behaviour.
* Successful verifications are recorded in ``admin_mfa_challenges`` so
  the admin-MFA FastAPI dependency can accept an X-MFA-Code header once
  per ``MFA_CHALLENGE_TTL_SECONDS`` window without forcing the operator
  to retype the code on every request.

No third-party dependency (pyotp, otpauth, ...) is introduced; the
algorithm is short and well-specified so we use only the standard
library. Backup codes are stored as sha256(code) and burned on use.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Iterable, Sequence
from urllib.parse import quote

from sqlalchemy import Column, DateTime, Integer, String, Text, select

from adherence_common.db import Base, init_db, session
from adherence_common.errors import AuthError

# 30 s step, 6 digit code, +/-1 step window, code reusable for 5 min.
TOTP_STEP_SECONDS = 30
TOTP_DIGITS = 6
TOTP_DRIFT_STEPS = 1
MFA_CHALLENGE_TTL_SECONDS = 300
BACKUP_CODE_COUNT = 10


class AdminMFAEnrollment(Base):
    """Per-principal TOTP secret + hashed backup codes."""

    __tablename__ = "admin_mfa_enrollments"
    id = Column(Integer, primary_key=True, autoincrement=True)
    principal = Column(String(128), nullable=False, unique=True, index=True)
    secret_b32 = Column(String(64), nullable=False)
    confirmed_at = Column(DateTime, nullable=True)
    backup_hashes_csv = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_used_at = Column(DateTime, nullable=True)


class AdminMFAChallenge(Base):
    """Recent successful MFA verifications, used as short-lived tickets."""

    __tablename__ = "admin_mfa_challenges"
    id = Column(Integer, primary_key=True, autoincrement=True)
    principal = Column(String(128), nullable=False, index=True)
    verified_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=False, index=True)
    method = Column(String(16), nullable=False, default="totp")


@dataclass
class EnrollmentSummary:
    principal: str
    enrolled: bool
    confirmed: bool
    backup_codes_remaining: int
    last_used_at: datetime | None


# ---- TOTP primitives ------------------------------------------------------


def _b32_decode(secret_b32: str) -> bytes:
    pad = "=" * (-len(secret_b32) % 8)
    return base64.b32decode((secret_b32 + pad).upper())


def generate_secret() -> str:
    """160-bit secret encoded as 32 base32 chars (matches RFC 4226 §4)."""
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def _hotp(secret: bytes, counter: int, digits: int = TOTP_DIGITS) -> str:
    msg = struct.pack(">Q", counter)
    digest = hmac.new(secret, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code_int = (
        ((digest[offset] & 0x7F) << 24)
        | ((digest[offset + 1] & 0xFF) << 16)
        | ((digest[offset + 2] & 0xFF) << 8)
        | (digest[offset + 3] & 0xFF)
    )
    return str(code_int % (10 ** digits)).zfill(digits)


def current_totp(secret_b32: str, *, now: float | None = None) -> str:
    """Return the TOTP code for *now* (test/admin helper)."""
    ts = int(now if now is not None else time.time())
    return _hotp(_b32_decode(secret_b32), ts // TOTP_STEP_SECONDS)


def verify_totp(secret_b32: str, code: str, *, now: float | None = None) -> bool:
    """Constant-time TOTP check with +/- ``TOTP_DRIFT_STEPS`` of drift."""
    if not code or not code.isdigit() or len(code) != TOTP_DIGITS:
        return False
    secret = _b32_decode(secret_b32)
    ts = int(now if now is not None else time.time())
    counter = ts // TOTP_STEP_SECONDS
    for offset in range(-TOTP_DRIFT_STEPS, TOTP_DRIFT_STEPS + 1):
        if hmac.compare_digest(_hotp(secret, counter + offset), code):
            return True
    return False


def otpauth_uri(principal: str, secret_b32: str, *, issuer: str = "adherence-ml") -> str:
    """Build the standard ``otpauth://`` URI for authenticator app QR codes."""
    label = quote(f"{issuer}:{principal}", safe="")
    return (
        f"otpauth://totp/{label}?secret={secret_b32}"
        f"&issuer={quote(issuer)}&algorithm=SHA1&digits={TOTP_DIGITS}"
        f"&period={TOTP_STEP_SECONDS}"
    )


# ---- Backup codes ---------------------------------------------------------


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def _generate_backup_codes(n: int = BACKUP_CODE_COUNT) -> list[str]:
    out: list[str] = []
    for _ in range(n):
        # 10 hex chars grouped 5-5 for readability: e.g. "a1b2c-3d4e5".
        raw = secrets.token_hex(5)
        out.append(f"{raw[:5]}-{raw[5:]}")
    return out


# ---- Enrollment workflow --------------------------------------------------


def start_enrollment(principal: str, *, issuer: str = "adherence-ml") -> dict:
    """Create or rotate (unconfirmed) the TOTP secret for ``principal``."""
    if not principal:
        raise ValueError("principal required")
    init_db()
    secret = generate_secret()
    with session() as s:
        existing = s.execute(
            select(AdminMFAEnrollment).where(AdminMFAEnrollment.principal == principal)
        ).scalar_one_or_none()
        if existing is None:
            existing = AdminMFAEnrollment(principal=principal, secret_b32=secret)
            s.add(existing)
        else:
            existing.secret_b32 = secret
            existing.confirmed_at = None
            existing.backup_hashes_csv = None
            existing.last_used_at = None
        s.commit()
        s.refresh(existing)
    return {
        "principal": principal,
        "secret_b32": secret,
        "otpauth_uri": otpauth_uri(principal, secret, issuer=issuer),
        "digits": TOTP_DIGITS,
        "period_seconds": TOTP_STEP_SECONDS,
    }


def confirm_enrollment(principal: str, code: str) -> list[str]:
    """Confirm the TOTP secret and mint single-use backup codes."""
    init_db()
    with session() as s:
        row = s.execute(
            select(AdminMFAEnrollment).where(AdminMFAEnrollment.principal == principal)
        ).scalar_one_or_none()
        if row is None:
            raise AuthError("mfa not enrolled")
        if row.confirmed_at is not None:
            raise AuthError("mfa already confirmed; rotate first")
        if not verify_totp(row.secret_b32, code):
            raise AuthError("invalid totp code")
        codes = _generate_backup_codes()
        row.backup_hashes_csv = ",".join(_hash_code(c) for c in codes)
        row.confirmed_at = datetime.utcnow()
        row.last_used_at = datetime.utcnow()
        s.commit()
        _record_challenge(s, principal, method="totp")
        s.commit()
    return codes


def disable_enrollment(principal: str) -> bool:
    init_db()
    with session() as s:
        row = s.execute(
            select(AdminMFAEnrollment).where(AdminMFAEnrollment.principal == principal)
        ).scalar_one_or_none()
        if row is None:
            return False
        s.delete(row)
        s.commit()
    return True


def enrollment_summary(principal: str) -> EnrollmentSummary:
    init_db()
    with session() as s:
        row = s.execute(
            select(AdminMFAEnrollment).where(AdminMFAEnrollment.principal == principal)
        ).scalar_one_or_none()
    if row is None:
        return EnrollmentSummary(principal=principal, enrolled=False, confirmed=False,
                                 backup_codes_remaining=0, last_used_at=None)
    remaining = 0
    if row.backup_hashes_csv:
        remaining = len([h for h in row.backup_hashes_csv.split(",") if h])
    return EnrollmentSummary(
        principal=principal,
        enrolled=True,
        confirmed=row.confirmed_at is not None,
        backup_codes_remaining=remaining,
        last_used_at=row.last_used_at,
    )


def is_mfa_required(principal: str) -> bool:
    """Admin actions are gated on MFA when the principal has confirmed it.

    This is opt-in per principal so the bootstrap admin key can complete
    its first enrolment. Once any admin confirms, every subsequent call
    they make to a guarded endpoint requires a fresh challenge.
    """
    summary = enrollment_summary(principal)
    return summary.enrolled and summary.confirmed


# ---- Verification + challenge tickets -------------------------------------


def _record_challenge(s, principal: str, *, method: str) -> None:
    now = datetime.utcnow()
    s.add(AdminMFAChallenge(
        principal=principal,
        verified_at=now,
        expires_at=now + timedelta(seconds=MFA_CHALLENGE_TTL_SECONDS),
        method=method,
    ))


def verify_code(principal: str, code: str) -> str:
    """Validate TOTP or burn a backup code; raise on failure.

    Returns the verification method ("totp" or "backup_code") used.
    """
    if not code:
        raise AuthError("mfa code required")
    init_db()
    with session() as s:
        row = s.execute(
            select(AdminMFAEnrollment).where(AdminMFAEnrollment.principal == principal)
        ).scalar_one_or_none()
        if row is None or row.confirmed_at is None:
            raise AuthError("mfa not enrolled")
        method: str | None = None
        cleaned = code.strip().replace(" ", "")
        if cleaned.isdigit() and len(cleaned) == TOTP_DIGITS:
            if verify_totp(row.secret_b32, cleaned):
                method = "totp"
        if method is None and row.backup_hashes_csv:
            target = _hash_code(cleaned.lower())
            hashes = [h for h in row.backup_hashes_csv.split(",") if h]
            if target in hashes:
                hashes.remove(target)
                row.backup_hashes_csv = ",".join(hashes)
                method = "backup_code"
        if method is None:
            raise AuthError("invalid mfa code")
        row.last_used_at = datetime.utcnow()
        _record_challenge(s, principal, method=method)
        s.commit()
        return method


def has_recent_challenge(principal: str, *, now: float | None = None) -> bool:
    init_db()
    cutoff = datetime.utcfromtimestamp(now if now is not None else time.time())
    with session() as s:
        row = s.execute(
            select(AdminMFAChallenge)
            .where(AdminMFAChallenge.principal == principal)
            .where(AdminMFAChallenge.expires_at > cutoff)
            .order_by(AdminMFAChallenge.verified_at.desc())
        ).first()
    return row is not None


def revoke_challenges(principal: str) -> int:
    """Invalidate all active challenges (e.g. on logout-all)."""
    init_db()
    with session() as s:
        rows = s.execute(
            select(AdminMFAChallenge).where(AdminMFAChallenge.principal == principal)
        ).scalars().all()
        n = 0
        for r in rows:
            s.delete(r)
            n += 1
        s.commit()
    return n


def list_enrollments() -> list[EnrollmentSummary]:
    init_db()
    with session() as s:
        rows = s.execute(select(AdminMFAEnrollment)).scalars().all()
    out: list[EnrollmentSummary] = []
    for row in rows:
        remaining = 0
        if row.backup_hashes_csv:
            remaining = len([h for h in row.backup_hashes_csv.split(",") if h])
        out.append(EnrollmentSummary(
            principal=row.principal,
            enrolled=True,
            confirmed=row.confirmed_at is not None,
            backup_codes_remaining=remaining,
            last_used_at=row.last_used_at,
        ))
    return out


__all__: Sequence[str] = (
    "AdminMFAEnrollment", "AdminMFAChallenge", "EnrollmentSummary",
    "start_enrollment", "confirm_enrollment", "disable_enrollment",
    "enrollment_summary", "is_mfa_required", "verify_code",
    "has_recent_challenge", "revoke_challenges", "list_enrollments",
    "current_totp", "verify_totp", "generate_secret", "otpauth_uri",
    "MFA_CHALLENGE_TTL_SECONDS",
)
