"""Admin MFA enrollment, verification, and management.

Endpoints are mounted under ``/v1/admin/mfa``. They let an admin
principal enrol a TOTP authenticator app, confirm with a one-time code,
verify a fresh challenge (so subsequent admin mutations within a five
minute window do not require re-entering the code on every request),
list their backup codes, and disable enrolment.

Once an admin principal has *confirmed* MFA, every other admin-gated
mutation (api-key create/revoke, model rollback, audit retention sweep,
etc.) enforces a fresh challenge via ``require_admin_mfa``. The first
admin can therefore bootstrap MFA without being locked out, but after
enrolment the policy is non-bypassable for that operator.
"""
from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import current_principal, require_admin
from adherence_common import mfa
from adherence_common.admin_audit import record_admin_action
from adherence_common.errors import AuthError

router = APIRouter(prefix="/v1/admin/mfa", tags=["admin-mfa"])


def _rid(request: Request) -> str:
    return request.headers.get("x-request-id", "") or ""


def _principal_id(p: dict) -> str:
    sub = (p.get("sub") or "").strip()
    if not sub:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="principal has no subject")
    return sub


class EnrollStartOut(BaseModel):
    principal: str
    secret_b32: str
    otpauth_uri: str
    digits: int
    period_seconds: int


class EnrollConfirmIn(BaseModel):
    code: str = Field(min_length=6, max_length=8)


class EnrollConfirmOut(BaseModel):
    principal: str
    confirmed: bool
    backup_codes: list[str]


class VerifyIn(BaseModel):
    code: str = Field(min_length=4, max_length=16)


class VerifyOut(BaseModel):
    principal: str
    verified: bool
    method: str
    expires_in_seconds: int


class StatusOut(BaseModel):
    principal: str
    enrolled: bool
    confirmed: bool
    backup_codes_remaining: int
    backup_codes_low: bool
    backup_codes_low_watermark: int
    last_used_at: str | None
    challenge_active: bool


class RegenerateBackupCodesIn(BaseModel):
    code: str = Field(min_length=4, max_length=16)


class RegenerateBackupCodesOut(BaseModel):
    principal: str
    backup_codes: list[str]
    issued_count: int


class EnrollmentRow(BaseModel):
    principal: str
    enrolled: bool
    confirmed: bool
    backup_codes_remaining: int
    last_used_at: str | None


# ---- self-service endpoints (any admin principal) -------------------------


@router.post("/enroll", response_model=EnrollStartOut)
def start_enroll(request: Request, p=Depends(require_admin)) -> EnrollStartOut:
    """Begin (or rotate) TOTP enrolment for the calling admin principal."""
    sub = _principal_id(p)
    payload = mfa.start_enrollment(sub)
    record_admin_action(
        action="mfa.enroll.start", principal=p, target=sub,
        details={"otpauth_issuer": "adherence-ml"},
        request_id=_rid(request),
    )
    return EnrollStartOut(**payload)


@router.post("/confirm", response_model=EnrollConfirmOut)
def confirm_enroll(
    body: EnrollConfirmIn,
    request: Request,
    p=Depends(require_admin),
) -> EnrollConfirmOut:
    sub = _principal_id(p)
    try:
        codes = mfa.confirm_enrollment(sub, body.code)
    except AuthError as exc:
        record_admin_action(
            action="mfa.enroll.confirm", principal=p, target=sub,
            ok=False, error=str(exc), request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    record_admin_action(
        action="mfa.enroll.confirm", principal=p, target=sub,
        details={"backup_codes_issued": len(codes)},
        request_id=_rid(request),
    )
    return EnrollConfirmOut(principal=sub, confirmed=True, backup_codes=codes)


@router.post("/verify", response_model=VerifyOut)
def verify(
    body: VerifyIn,
    request: Request,
    p=Depends(require_admin),
) -> VerifyOut:
    """Validate a TOTP or backup code; returns a short-lived challenge ticket."""
    sub = _principal_id(p)
    try:
        method = mfa.verify_code(sub, body.code)
    except AuthError as exc:
        record_admin_action(
            action="mfa.verify", principal=p, target=sub,
            ok=False, error=str(exc), request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    record_admin_action(
        action="mfa.verify", principal=p, target=sub,
        details={"method": method},
        request_id=_rid(request),
    )
    return VerifyOut(
        principal=sub, verified=True, method=method,
        expires_in_seconds=mfa.MFA_CHALLENGE_TTL_SECONDS,
    )


@router.post("/disable")
def disable(
    body: VerifyIn,
    request: Request,
    p=Depends(require_admin),
) -> dict:
    """Disable MFA for the caller; requires a fresh code to prevent lockout-bypass."""
    sub = _principal_id(p)
    try:
        mfa.verify_code(sub, body.code)
    except AuthError as exc:
        record_admin_action(
            action="mfa.disable", principal=p, target=sub,
            ok=False, error=str(exc), request_id=_rid(request),
        )
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    removed = mfa.disable_enrollment(sub)
    record_admin_action(
        action="mfa.disable", principal=p, target=sub,
        details={"removed": removed}, request_id=_rid(request),
    )
    return {"disabled": removed, "principal": sub}


@router.get("/status", response_model=StatusOut)
def status_self(p=Depends(require_admin)) -> StatusOut:
    sub = _principal_id(p)
    summary = mfa.enrollment_summary(sub)
    return StatusOut(
        principal=sub,
        enrolled=summary.enrolled,
        confirmed=summary.confirmed,
        backup_codes_remaining=summary.backup_codes_remaining,
        backup_codes_low=(
            summary.confirmed
            and summary.backup_codes_remaining <= mfa.BACKUP_CODE_LOW_WATERMARK
        ),
        backup_codes_low_watermark=mfa.BACKUP_CODE_LOW_WATERMARK,
        last_used_at=summary.last_used_at.isoformat() if summary.last_used_at else None,
        challenge_active=mfa.has_recent_challenge(sub),
    )


@router.post(
    "/backup-codes/regenerate",
    response_model=RegenerateBackupCodesOut,
)
def regenerate_backup_codes(
    body: RegenerateBackupCodesIn,
    request: Request,
    p=Depends(require_admin),
) -> RegenerateBackupCodesOut:
    """Mint a fresh set of single-use backup codes for the calling admin.

    Requires a fresh TOTP or unused backup code in the body so a stolen
    long-lived challenge cannot silently re-arm the account. Previous
    codes are discarded atomically. The response is the only chance to
    capture the new plaintext codes; the server stores only sha256
    hashes.
    """
    sub = _principal_id(p)
    try:
        codes = mfa.regenerate_backup_codes(sub, body.code)
    except AuthError as exc:
        record_admin_action(
            action="mfa.backup_codes.regenerate", principal=p, target=sub,
            ok=False, error=str(exc), request_id=_rid(request),
        )
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail=str(exc),
            headers={"X-MFA-Required": "totp"},
        ) from exc
    record_admin_action(
        action="mfa.backup_codes.regenerate", principal=p, target=sub,
        details={"issued": len(codes)}, request_id=_rid(request),
    )
    return RegenerateBackupCodesOut(
        principal=sub, backup_codes=codes, issued_count=len(codes),
    )


@router.get("", response_model=list[EnrollmentRow])
def list_all(_p=Depends(require_admin)) -> list[EnrollmentRow]:
    """Audit view: which admin principals have MFA enrolled."""
    return [
        EnrollmentRow(
            principal=e.principal, enrolled=e.enrolled, confirmed=e.confirmed,
            backup_codes_remaining=e.backup_codes_remaining,
            last_used_at=e.last_used_at.isoformat() if e.last_used_at else None,
        )
        for e in mfa.list_enrollments()
    ]


# ---- shared dependency ----------------------------------------------------


def require_admin_mfa(
    request: Request,
    p=Depends(require_admin),
    x_mfa_code: Annotated[str | None, Header(alias="X-MFA-Code")] = None,
) -> dict:
    """Admin guard that also enforces an active MFA challenge.

    Behaviour:
      * If the principal is not enrolled+confirmed, behaves like
        ``require_admin`` so the bootstrap admin can still set up MFA.
      * Otherwise, allows the call if there is a verified challenge
        within ``MFA_CHALLENGE_TTL_SECONDS``, or if ``X-MFA-Code`` is
        provided and validates (TOTP or backup code). The header path
        records a challenge so subsequent calls in the window pass.
      * Returns 401 with ``X-MFA-Required: totp`` when neither holds.
    """
    sub = _principal_id(p)
    if not mfa.is_mfa_required(sub):
        return p
    if x_mfa_code:
        try:
            method = mfa.verify_code(sub, x_mfa_code)
        except AuthError as exc:
            record_admin_action(
                action="mfa.gate", principal=p, target=sub,
                ok=False, error=str(exc), request_id=_rid(request),
            )
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, detail=str(exc),
                headers={"X-MFA-Required": "totp"},
            ) from exc
        record_admin_action(
            action="mfa.gate", principal=p, target=sub,
            details={"method": method, "path": request.url.path},
            request_id=_rid(request),
        )
        return p
    if mfa.has_recent_challenge(sub):
        return p
    raise HTTPException(
        status.HTTP_401_UNAUTHORIZED,
        detail="mfa challenge required for admin action",
        headers={
            "X-MFA-Required": "totp",
            "X-MFA-Challenge-TTL-Seconds": str(mfa.MFA_CHALLENGE_TTL_SECONDS),
        },
    )
