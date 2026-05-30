"""/v1/metrics/online: live model quality from audit + outcome joins.

Each prediction is logged to `prediction_audit.response_summary` (per-dose
miss_probability). When Med-Tracker reports the outcome via the webhook, we
join on (user_id, dose_id) and compute AUC / Brier / log-loss / calibration
on real traffic. Same numbers used by the challenger-promotion gate.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from math import log

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select

from adherence_api.deps import require_admin
from adherence_common.db import DoseOutcome, PredictionAudit, init_db, session

router = APIRouter(prefix="/v1/metrics", tags=["metrics"])


class CalibrationBin(BaseModel):
    p_lo: float
    p_hi: float
    n: int
    mean_pred: float
    miss_rate: float


class OnlineMetricsResponse(BaseModel):
    window_hours: int
    n_predictions: int
    n_matched: int
    n_positives: int
    base_rate: float | None
    auc: float | None
    brier: float | None
    log_loss: float | None
    ece: float | None
    calibration: list[CalibrationBin]
    by_model: dict[str, dict[str, float | int | None]]


def _auc(y: list[int], p: list[float]) -> float | None:
    pairs = sorted(zip(p, y))
    n_pos = sum(y)
    n_neg = len(y) - n_pos
    if n_pos == 0 or n_neg == 0:
        return None
    # Mann-Whitney with average ranks on ties.
    ranks: dict[float, float] = {}
    i = 0
    while i < len(pairs):
        j = i
        while j + 1 < len(pairs) and pairs[j + 1][0] == pairs[i][0]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[id(pairs[k])] = avg
        i = j + 1
    sum_pos = sum(ranks[id(t)] for t in pairs if t[1] == 1)
    return (sum_pos - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg)


def _brier(y: list[int], p: list[float]) -> float:
    return sum((pi - yi) ** 2 for pi, yi in zip(p, y)) / len(y)


def _log_loss(y: list[int], p: list[float]) -> float:
    eps = 1e-12
    return -sum(
        yi * log(max(pi, eps)) + (1 - yi) * log(max(1 - pi, eps))
        for pi, yi in zip(p, y)
    ) / len(y)


def _calibration(y: list[int], p: list[float], n_bins: int = 10
                 ) -> tuple[list[CalibrationBin], float]:
    bins: list[CalibrationBin] = []
    ece = 0.0
    total = len(p)
    for b in range(n_bins):
        lo = b / n_bins
        hi = (b + 1) / n_bins
        idx = [i for i, pi in enumerate(p)
               if (pi >= lo and pi < hi) or (b == n_bins - 1 and pi == 1.0)]
        if not idx:
            bins.append(CalibrationBin(p_lo=lo, p_hi=hi, n=0,
                                       mean_pred=0.0, miss_rate=0.0))
            continue
        mp = sum(p[i] for i in idx) / len(idx)
        mr = sum(y[i] for i in idx) / len(idx)
        bins.append(CalibrationBin(p_lo=lo, p_hi=hi, n=len(idx),
                                   mean_pred=mp, miss_rate=mr))
        ece += (len(idx) / total) * abs(mp - mr)
    return bins, ece


def _collect(window_hours: int, model_name: str | None
             ) -> tuple[list[tuple[str, float, int, str]], int]:
    """Return [(dose_id, p, y, model_name), ...] and raw n_predictions.

    `y` is 1 for missed, 0 for taken; `late` is treated as taken (delivered,
    just late). Predictions are taken from the audit's response_summary blob.
    """
    init_db()
    cutoff = datetime.utcnow() - timedelta(hours=window_hours)
    out: list[tuple[str, float, int, str]] = []
    n_preds = 0
    with session() as s:
        outcomes = list(s.scalars(
            select(DoseOutcome).where(DoseOutcome.received_at >= cutoff)
        ))
        if not outcomes:
            return out, 0
        by_key = {(o.user_id, o.dose_id): o for o in outcomes}
        q = select(PredictionAudit).where(
            PredictionAudit.created_at >= cutoff,
            PredictionAudit.ok == 1,
            PredictionAudit.user_id.in_({o.user_id for o in outcomes}),
        )
        if model_name:
            q = q.where(PredictionAudit.model_name == model_name)
        for row in s.scalars(q):
            preds = (row.response_summary or {}).get("predictions") or []
            for d in preds:
                n_preds += 1
                key = (row.user_id, d.get("dose_id"))
                o = by_key.get(key)
                if o is None:
                    continue
                p = float(d.get("miss_probability", 0.0))
                y = 1 if o.outcome == "missed" else 0
                out.append((d.get("dose_id"), p, y, row.model_name))
    return out, n_preds


class CohortReportRow(BaseModel):
    cohort: str
    n: int
    n_positives: int
    base_rate: float
    mean_pred: float
    auc: float | None
    brier: float


class LiftAtKRow(BaseModel):
    k_pct: int
    cum_positives: int
    precision: float
    recall: float
    lift: float


class ConfusionMatrix(BaseModel):
    threshold: float
    tp: int
    fp: int
    tn: int
    fn: int
    precision: float
    recall: float
    f1: float
    fpr: float


class OnlineReportResponse(BaseModel):
    window_hours: int
    n_matched: int
    n_positives: int
    base_rate: float | None
    auc: float | None
    brier: float | None
    log_loss: float | None
    ece: float | None
    threshold: float
    confusion: ConfusionMatrix | None
    lift_curve: list[LiftAtKRow]
    by_dose_class: list[CohortReportRow]
    by_hour_bucket: list[CohortReportRow]


def _confusion(y: list[int], p: list[float], threshold: float) -> ConfusionMatrix:
    tp = fp = tn = fn = 0
    for yi, pi in zip(y, p):
        pred = 1 if pi >= threshold else 0
        if pred == 1 and yi == 1: tp += 1
        elif pred == 1 and yi == 0: fp += 1
        elif pred == 0 and yi == 0: tn += 1
        else: fn += 1
    prec = tp / (tp + fp) if (tp + fp) else 0.0
    rec = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
    fpr = fp / (fp + tn) if (fp + tn) else 0.0
    return ConfusionMatrix(threshold=threshold, tp=tp, fp=fp, tn=tn, fn=fn,
                           precision=prec, recall=rec, f1=f1, fpr=fpr)


def _lift_curve(y: list[int], p: list[float],
                pcts: tuple[int, ...] = (5, 10, 20, 30, 50)) -> list[LiftAtKRow]:
    if not y or sum(y) == 0:
        return []
    n = len(y)
    total_pos = sum(y)
    base = total_pos / n
    order = sorted(range(n), key=lambda i: -p[i])
    out: list[LiftAtKRow] = []
    for k_pct in pcts:
        k = max(1, n * k_pct // 100)
        top = order[:k]
        cum_pos = sum(y[i] for i in top)
        precision = cum_pos / k
        recall = cum_pos / total_pos
        lift = precision / base if base else 0.0
        out.append(LiftAtKRow(k_pct=k_pct, cum_positives=cum_pos,
                              precision=precision, recall=recall, lift=lift))
    return out


def _cohort_rows(rows: list[tuple], key: str) -> list[CohortReportRow]:
    groups: dict[str, list[tuple[int, float]]] = {}
    for _did, p, y, _m, meta in rows:
        bucket = meta.get(key)
        if bucket is None:
            continue
        groups.setdefault(str(bucket), []).append((y, p))
    out: list[CohortReportRow] = []
    for name, items in sorted(groups.items()):
        ys = [t[0] for t in items]
        ps = [t[1] for t in items]
        out.append(CohortReportRow(
            cohort=name, n=len(ys), n_positives=sum(ys),
            base_rate=sum(ys) / len(ys),
            mean_pred=sum(ps) / len(ps),
            auc=_auc(ys, ps),
            brier=_brier(ys, ps),
        ))
    return out


def _collect_rich(window_hours: int, model_name: str | None) -> list[tuple]:
    """Like _collect but also returns per-prediction metadata
    (dose_class, hour_bucket) when available."""
    init_db()
    cutoff = datetime.utcnow() - timedelta(hours=window_hours)
    out: list[tuple] = []
    with session() as s:
        outcomes = list(s.scalars(
            select(DoseOutcome).where(DoseOutcome.received_at >= cutoff)
        ))
        if not outcomes:
            return out
        by_key = {(o.user_id, o.dose_id): o for o in outcomes}
        q = select(PredictionAudit).where(
            PredictionAudit.created_at >= cutoff,
            PredictionAudit.ok == 1,
            PredictionAudit.user_id.in_({o.user_id for o in outcomes}),
        )
        if model_name:
            q = q.where(PredictionAudit.model_name == model_name)
        for row in s.scalars(q):
            preds = (row.response_summary or {}).get("predictions") or []
            for d in preds:
                key = (row.user_id, d.get("dose_id"))
                o = by_key.get(key)
                if o is None:
                    continue
                p = float(d.get("miss_probability", 0.0))
                y = 1 if o.outcome == "missed" else 0
                meta: dict = {}
                if d.get("dose_class"):
                    meta["dose_class"] = d["dose_class"]
                sched_iso = d.get("scheduled_at")
                hour = None
                if sched_iso and isinstance(sched_iso, str):
                    try:
                        ss = sched_iso[:-1] + "+00:00" if sched_iso.endswith("Z") else sched_iso
                        hour = datetime.fromisoformat(ss).hour
                    except Exception:
                        hour = None
                if hour is None and o.scheduled_at is not None:
                    hour = o.scheduled_at.hour
                if hour is not None:
                    if hour < 6: bucket = "00-06"
                    elif hour < 12: bucket = "06-12"
                    elif hour < 18: bucket = "12-18"
                    else: bucket = "18-24"
                    meta["hour_bucket"] = bucket
                out.append((d.get("dose_id"), p, y, row.model_name, meta))
    return out


@router.get("/online/report", response_model=OnlineReportResponse)
def online_report(
    window_hours: int = Query(168, ge=1, le=24 * 90),
    model_name: str | None = Query(None),
    threshold: float = Query(0.5, ge=0.0, le=1.0,
        description="Decision threshold for the confusion matrix."),
    n_bins: int = Query(10, ge=2, le=50),
    _a=Depends(require_admin),
) -> OnlineReportResponse:
    """Cohort-sliced report: lift curve, confusion matrix at threshold,
    AUC/Brier by dose_class and hour-of-day bucket. Useful for spotting
    cohort regressions the headline AUC hides."""
    rich = _collect_rich(window_hours, model_name)
    if not rich:
        return OnlineReportResponse(
            window_hours=window_hours, n_matched=0, n_positives=0,
            base_rate=None, auc=None, brier=None, log_loss=None, ece=None,
            threshold=threshold, confusion=None, lift_curve=[],
            by_dose_class=[], by_hour_bucket=[],
        )
    y = [r[2] for r in rich]
    p = [r[1] for r in rich]
    _cal, ece = _calibration(y, p, n_bins=n_bins)
    confusion = _confusion(y, p, threshold)
    return OnlineReportResponse(
        window_hours=window_hours,
        n_matched=len(rich),
        n_positives=sum(y),
        base_rate=sum(y) / len(y),
        auc=_auc(y, p),
        brier=_brier(y, p),
        log_loss=_log_loss(y, p),
        ece=ece,
        threshold=threshold,
        confusion=confusion,
        lift_curve=_lift_curve(y, p),
        by_dose_class=_cohort_rows(rich, "dose_class"),
        by_hour_bucket=_cohort_rows(rich, "hour_bucket"),
    )


@router.get("/online", response_model=OnlineMetricsResponse)
def online_metrics(
    window_hours: int = Query(168, ge=1, le=24 * 90),
    model_name: str | None = Query(None),
    n_bins: int = Query(10, ge=2, le=50),
    _a=Depends(require_admin),
) -> OnlineMetricsResponse:
    """AUC / Brier / log-loss / calibration on the join of predictions and outcomes."""
    rows, n_preds = _collect(window_hours, model_name)
    if not rows:
        return OnlineMetricsResponse(
            window_hours=window_hours, n_predictions=n_preds, n_matched=0,
            n_positives=0, base_rate=None, auc=None, brier=None,
            log_loss=None, ece=None, calibration=[], by_model={},
        )
    y = [r[2] for r in rows]
    p = [r[1] for r in rows]
    cal, ece = _calibration(y, p, n_bins=n_bins)
    by_model: dict[str, dict[str, float | int | None]] = {}
    for name in {r[3] for r in rows}:
        ys = [r[2] for r in rows if r[3] == name]
        ps = [r[1] for r in rows if r[3] == name]
        by_model[name] = {
            "n": len(ys),
            "auc": _auc(ys, ps),
            "brier": _brier(ys, ps),
            "miss_rate": sum(ys) / len(ys),
        }
    return OnlineMetricsResponse(
        window_hours=window_hours,
        n_predictions=n_preds,
        n_matched=len(rows),
        n_positives=sum(y),
        base_rate=sum(y) / len(y),
        auc=_auc(y, p),
        brier=_brier(y, p),
        log_loss=_log_loss(y, p),
        ece=ece,
        calibration=cal,
        by_model=by_model,
    )
