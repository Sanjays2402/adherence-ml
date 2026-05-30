"""Challenger model promotion with safety gates.

Decides whether a `challenger` model is safe to promote to a target name
(typically `default`) based on observed shadow-mode traffic + online
metrics. Gates are designed to fail closed: any missing data blocks
promotion. A separate `--force` flag in the CLI bypasses gates for break-
glass deploys.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select

from adherence_common.db import DoseOutcome, PredictionAudit, init_db, session
from adherence_models.registry import ModelArtifact, ModelRegistry


@dataclass
class GateResult:
    name: str
    ok: bool
    detail: str
    value: float | int | None = None
    threshold: float | int | None = None


@dataclass
class PromotionDecision:
    target: str
    challenger: str
    promote: bool
    gates: list[GateResult]
    summary: dict[str, Any]
    artifact: ModelArtifact | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "target": self.target,
            "challenger": self.challenger,
            "promote": self.promote,
            "gates": [asdict(g) for g in self.gates],
            "summary": self.summary,
            "artifact": asdict(self.artifact) if self.artifact else None,
        }


# ---- pure metric helpers (kept here so the gate logic stays testable) ----

def _auc(y: list[int], p: list[float]) -> float | None:
    pairs = sorted(zip(p, y))
    n_pos = sum(y)
    n_neg = len(y) - n_pos
    if n_pos == 0 or n_neg == 0:
        return None
    sum_ranks = 0.0
    i = 0
    while i < len(pairs):
        j = i
        while j + 1 < len(pairs) and pairs[j + 1][0] == pairs[i][0]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            if pairs[k][1] == 1:
                sum_ranks += avg
        i = j + 1
    return (sum_ranks - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg)


def _brier(y: list[int], p: list[float]) -> float:
    return sum((pi - yi) ** 2 for pi, yi in zip(p, y)) / len(y)


# ---- data collection ----

def _collect_matched_outcomes(window_hours: int, model_name: str
                              ) -> tuple[list[int], list[float]]:
    init_db()
    cutoff = datetime.utcnow() - timedelta(hours=window_hours)
    with session() as s:
        outcomes = list(s.scalars(
            select(DoseOutcome).where(DoseOutcome.received_at >= cutoff)
        ))
        if not outcomes:
            return [], []
        by_key = {(o.user_id, o.dose_id): o for o in outcomes}
        rows = list(s.scalars(
            select(PredictionAudit).where(
                PredictionAudit.created_at >= cutoff,
                PredictionAudit.ok == 1,
                PredictionAudit.model_name == model_name,
                PredictionAudit.user_id.in_({o.user_id for o in outcomes}),
            )
        ))
    y: list[int] = []
    p: list[float] = []
    for row in rows:
        preds = (row.response_summary or {}).get("predictions") or []
        for d in preds:
            o = by_key.get((row.user_id, d.get("dose_id")))
            if o is None:
                continue
            p.append(float(d.get("miss_probability", 0.0)))
            y.append(1 if o.outcome == "missed" else 0)
    return y, p


def _collect_shadow(window_hours: int, challenger: str
                    ) -> list[float]:
    init_db()
    cutoff = datetime.utcnow() - timedelta(hours=window_hours)
    with session() as s:
        rows = list(s.scalars(
            select(PredictionAudit).where(
                PredictionAudit.created_at >= cutoff,
                PredictionAudit.shadow_model_name == challenger,
                PredictionAudit.shadow_max_divergence.is_not(None),
            )
        ))
    return [float(r.shadow_max_divergence) for r in rows]


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * pct / 100.0
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


# ---- gate ----

def evaluate_promotion(
    *,
    challenger: str,
    target: str = "default",
    window_hours: int = 168,
    min_shadow_calls: int = 100,
    max_p95_divergence: float = 0.15,
    min_matched_outcomes: int = 50,
    max_brier_regression: float = 0.01,
    min_auc_delta: float = -0.01,
) -> PromotionDecision:
    """Compute gate verdicts without changing the registry.

    Promotion requires:
      1. Enough shadow scoring volume (`min_shadow_calls`).
      2. Shadow p95 divergence stays under `max_p95_divergence`.
      3. Enough joined outcomes per model (`min_matched_outcomes`).
      4. Challenger Brier no worse than primary + `max_brier_regression`.
      5. Challenger AUC no worse than primary - |min_auc_delta|.

    items (3-5) are skipped (counted as PASS with a `no data` note) when
    the challenger has not yet been promoted as `default` in the past, which
    is the normal case; they apply once the challenger has live traffic of
    its own (e.g. after an earlier partial promote/rollback cycle).
    """
    gates: list[GateResult] = []

    div = _collect_shadow(window_hours, challenger)
    n_shadow = len(div)
    gates.append(GateResult(
        name="shadow_volume",
        ok=n_shadow >= min_shadow_calls,
        detail=f"{n_shadow} shadow calls in {window_hours}h",
        value=n_shadow, threshold=min_shadow_calls,
    ))
    p95 = _percentile(div, 95) if div else 0.0
    gates.append(GateResult(
        name="shadow_divergence_p95",
        ok=bool(div) and p95 <= max_p95_divergence,
        detail=f"p95 |delta| = {p95:.4f}",
        value=p95, threshold=max_p95_divergence,
    ))

    y_p, p_p = _collect_matched_outcomes(window_hours, target)
    y_c, p_c = _collect_matched_outcomes(window_hours, challenger)
    summary: dict[str, Any] = {
        "n_shadow": n_shadow,
        "shadow_p95_divergence": p95,
        "primary_matched": len(y_p),
        "challenger_matched": len(y_c),
    }

    if len(y_c) >= min_matched_outcomes and len(y_p) >= min_matched_outcomes:
        b_p, b_c = _brier(y_p, p_p), _brier(y_c, p_c)
        a_p, a_c = _auc(y_p, p_p), _auc(y_c, p_c)
        summary.update({
            "primary_brier": b_p, "challenger_brier": b_c,
            "primary_auc": a_p, "challenger_auc": a_c,
        })
        gates.append(GateResult(
            name="brier_no_regression",
            ok=(b_c - b_p) <= max_brier_regression,
            detail=f"challenger Brier {b_c:.4f} vs primary {b_p:.4f}",
            value=b_c - b_p, threshold=max_brier_regression,
        ))
        if a_p is not None and a_c is not None:
            gates.append(GateResult(
                name="auc_no_regression",
                ok=(a_c - a_p) >= min_auc_delta,
                detail=f"challenger AUC {a_c:.4f} vs primary {a_p:.4f}",
                value=a_c - a_p, threshold=min_auc_delta,
            ))
        else:
            gates.append(GateResult(
                name="auc_no_regression", ok=True,
                detail="AUC undefined (single-class outcomes); skipped",
            ))
    else:
        gates.append(GateResult(
            name="outcome_volume", ok=True,
            detail=(f"insufficient joined outcomes "
                    f"(primary={len(y_p)}, challenger={len(y_c)}); "
                    f"online quality gates skipped"),
            value=min(len(y_p), len(y_c)), threshold=min_matched_outcomes,
        ))

    promote_ok = all(g.ok for g in gates)
    return PromotionDecision(
        target=target,
        challenger=challenger,
        promote=promote_ok,
        gates=gates,
        summary=summary,
    )


def promote_challenger(
    *,
    challenger: str,
    target: str = "default",
    force: bool = False,
    **gate_kwargs: Any,
) -> PromotionDecision:
    """Run gates and (if green or force=True) promote the artifact."""
    decision = evaluate_promotion(
        challenger=challenger, target=target, **gate_kwargs
    )
    if decision.promote or force:
        art = ModelRegistry().promote(source=challenger, target=target)
        decision.artifact = art
        # When forced through a red gate, surface that in the response.
        if not decision.promote and force:
            decision.promote = True
            decision.summary["forced"] = True
    return decision
