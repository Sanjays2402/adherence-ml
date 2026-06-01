"""/v1/admin/invite-policy: workspace invitation email-domain policy.

Admin-only and tenant-scoped. Mutations are audit-logged. Supports
``?dry_run=true`` on add and remove so a buyer's IT team can preview
what a change would do before committing.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from adherence_api.deps import require_admin
from adherence_api.dry_run import dry_run_response
from adherence_common import invite_policy as invp
from adherence_common.admin_audit import record_admin_action

router = APIRouter(prefix="/v1/admin/invite-policy", tags=["admin"])


class DomainRuleOut(BaseModel):
    id: int
    tenant_id: str
    kind: str
    domain: str
    note: str | None
    created_by: str | None
    created_at: str


class DomainRuleIn(BaseModel):
    kind: str = Field(..., description="'allow' or 'block'")
    domain: str = Field(..., min_length=1, max_length=253)
    note: str | None = Field(None, max_length=256)


class PolicySummaryOut(BaseModel):
    tenant_id: str
    allowlist_enforced: bool
    blocklist_enforced: bool
    allow_domains: list[str]
    block_domains: list[str]
    rules: list[DomainRuleOut]


class EvaluateIn(BaseModel):
    email: str = Field(..., min_length=3, max_length=320)


class EvaluateOut(BaseModel):
    email: str
    domain: str
    allowed: bool
    code: str | None
    message: str | None


def _rid(request: Request | None) -> str | None:
    if request is None:
        return None
    return getattr(request.state, "request_id", None)


def _to_out(v: invp.DomainRuleView) -> DomainRuleOut:
    return DomainRuleOut(
        id=v.id,
        tenant_id=v.tenant_id,
        kind=v.kind,
        domain=v.domain,
        note=v.note,
        created_by=v.created_by,
        created_at=v.created_at,
    )


@router.get("", response_model=PolicySummaryOut)
def get_policy(p=Depends(require_admin)) -> PolicySummaryOut:
    tid = str(p.get("tenant") or "default")
    summary = invp.policy_summary(tid)
    rules = invp.list_rules(tid)
    return PolicySummaryOut(
        tenant_id=summary["tenant_id"],
        allowlist_enforced=summary["allowlist_enforced"],
        blocklist_enforced=summary["blocklist_enforced"],
        allow_domains=summary["allow_domains"],
        block_domains=summary["block_domains"],
        rules=[_to_out(r) for r in rules],
    )


@router.post("/rules", response_model=DomainRuleOut, status_code=201)
def add_rule(
    body: DomainRuleIn,
    request: Request,
    dry_run: bool = Query(
        False,
        description="Preview only; validates kind/domain but does not persist.",
    ),
    p=Depends(require_admin),
) -> DomainRuleOut:
    tid = str(p.get("tenant") or "default")
    try:
        kind = invp.normalise_kind(body.kind)
        domain = invp.normalise_domain(body.domain)
    except invp.InvitePolicyError as exc:
        record_admin_action(
            action="invite_policy.rule.add", principal=p, target=body.domain,
            details={"kind": body.kind, "note": body.note},
            ok=False, error=str(exc), request_id=_rid(request), tenant_id=tid,
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if dry_run:
        record_admin_action(
            action="invite_policy.rule.add", principal=p, target=domain,
            details={"kind": kind, "note": body.note, "dry_run": True},
            ok=True, request_id=_rid(request), tenant_id=tid,
        )
        return DomainRuleOut(
            id=0,
            tenant_id=tid,
            kind=kind,
            domain=domain,
            note=body.note,
            created_by=str(p.get("sub") or "unknown"),
            created_at="dry-run",
        )
    try:
        view = invp.add_rule(
            tenant_id=tid,
            kind=kind,
            domain=domain,
            note=body.note,
            created_by=str(p.get("sub") or "unknown"),
        )
    except invp.InvitePolicyError as exc:
        record_admin_action(
            action="invite_policy.rule.add", principal=p, target=domain,
            details={"kind": kind, "note": body.note},
            ok=False, error=str(exc), request_id=_rid(request), tenant_id=tid,
        )
        raise HTTPException(status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    record_admin_action(
        action="invite_policy.rule.add", principal=p, target=view.domain,
        details={"id": view.id, "kind": view.kind, "note": view.note},
        ok=True, request_id=_rid(request), tenant_id=tid,
    )
    return _to_out(view)


@router.delete("/rules/{rule_id}")
def delete_rule(
    rule_id: int,
    request: Request,
    dry_run: bool = Query(False, description="Preview without removing."),
    p=Depends(require_admin),
) -> dict:
    tid = str(p.get("tenant") or "default")
    if dry_run:
        rules = invp.list_rules(tid)
        match = next((r for r in rules if r.id == rule_id), None)
        if match is None:
            record_admin_action(
                action="invite_policy.rule.remove", principal=p, target=str(rule_id),
                details={"dry_run": True},
                ok=False, error="rule not found",
                request_id=_rid(request), tenant_id=tid,
            )
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="rule not found")
        record_admin_action(
            action="invite_policy.rule.remove", principal=p, target=str(rule_id),
            details={
                "dry_run": True,
                "kind": match.kind,
                "domain": match.domain,
            },
            ok=True, request_id=_rid(request), tenant_id=tid,
        )
        return dry_run_response(
            would="remove",
            id=rule_id,
            kind=match.kind,
            domain=match.domain,
        )
    view = invp.remove_rule(tenant_id=tid, rule_id=rule_id)
    if view is None:
        record_admin_action(
            action="invite_policy.rule.remove", principal=p, target=str(rule_id),
            ok=False, error="rule not found",
            request_id=_rid(request), tenant_id=tid,
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="rule not found")
    record_admin_action(
        action="invite_policy.rule.remove", principal=p, target=str(rule_id),
        details={"kind": view.kind, "domain": view.domain},
        ok=True, request_id=_rid(request), tenant_id=tid,
    )
    return {"removed": True, "id": rule_id, "kind": view.kind, "domain": view.domain}


@router.post("/evaluate", response_model=EvaluateOut)
def evaluate(
    body: EvaluateIn,
    p=Depends(require_admin),
) -> EvaluateOut:
    """Dry-run an email against the current policy without sending an invite."""
    tid = str(p.get("tenant") or "default")
    em = body.email.strip().lower()
    if "@" not in em:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="invalid email")
    domain = em.rsplit("@", 1)[1]
    try:
        invp.evaluate(tid, em)
    except invp.InviteDomainBlocked as exc:
        return EvaluateOut(
            email=em,
            domain=domain,
            allowed=False,
            code=exc.code,
            message=str(exc),
        )
    return EvaluateOut(email=em, domain=domain, allowed=True, code=None, message=None)
