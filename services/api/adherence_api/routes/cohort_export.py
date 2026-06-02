"""/v1/cohort/risk/export: streaming NDJSON cohort risk export.

Same scoring logic as POST /v1/cohort/risk but designed for nightly
snapshot pipelines. Streams one JSON object per scored dose so callers
can sink directly into BigQuery / Snowflake / Parquet without holding
the full cohort in memory.

Filters:
  risk_tier: comma-separated subset of low,medium,high
  min_probability: minimum miss_probability to include (inclusive)
  max_probability: maximum miss_probability to include (inclusive)
  dose_class: comma-separated subset of dose classes
  time_bucket: comma-separated subset of time-of-day buckets
  user_ids: comma-separated allowlist of user ids

The request body matches /v1/cohort/risk so the two endpoints are
interchangeable from a payload perspective.
"""
from __future__ import annotations

import csv
import io
import json
from typing import Any, Iterator

import pandas as pd
from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse

from adherence_api.deps import require_service
from adherence_common.constants import DEFAULT_RISK_THRESHOLDS, DOSE_CLASSES, TIME_BUCKETS

_VALID_BUCKETS = set(TIME_BUCKETS)
from adherence_common.csv_safe import safe_row
from adherence_common.errors import ModelNotFoundError
from adherence_common.logging import get_logger
from adherence_data import SyntheticConfig, generate_events
from adherence_features.engineering import build_training_frame
from adherence_models.registry import ModelRegistry

router = APIRouter(prefix="/v1/cohort", tags=["cohort"])
log = get_logger(__name__)


_VALID_TIERS = {"low", "medium", "high"}
_VALID_FORMATS = {"ndjson", "csv"}
_VALID_SORTS = {"none", "risk_desc", "risk_asc"}
_CSV_COLUMNS = (
    "user_id",
    "dose_id",
    "dose_class",
    "time_bucket",
    "miss_probability",
    "risk_tier",
    "model_name",
    "model_version",
)


def _tier(p: float) -> str:
    high = DEFAULT_RISK_THRESHOLDS["high"]
    med = DEFAULT_RISK_THRESHOLDS["medium"]
    if p >= high:
        return "high"
    if p >= med:
        return "medium"
    return "low"


def _parse_csv(v: str | None) -> set[str] | None:
    if not v:
        return None
    out = {x.strip() for x in v.split(",") if x.strip()}
    return out or None


def _stream(
    df: pd.DataFrame,
    *,
    model_name: str,
    model_version: str,
    tier_filter: set[str] | None,
    min_prob: float,
    max_prob: float,
    class_filter: set[str] | None,
    bucket_filter: set[str] | None,
    user_filter: set[str] | None,
    limit: int | None,
) -> Iterator[bytes]:
    class_decode = {i: c for i, c in enumerate(DOSE_CLASSES)}
    bucket_decode = {i: b for i, b in enumerate(TIME_BUCKETS)}
    emitted = 0
    header = {
        "kind": "header",
        "model_name": model_name,
        "model_version": model_version,
        "total_candidates": int(len(df)),
    }
    yield (json.dumps(header) + "\n").encode("utf-8")
    for row in df.itertuples(index=False):
        uid = str(row.user_id)
        if user_filter is not None and uid not in user_filter:
            continue
        prob = float(row.miss_probability)
        if prob < min_prob or prob > max_prob:
            continue
        tier = _tier(prob)
        if tier_filter is not None and tier not in tier_filter:
            continue
        dose_class = class_decode.get(int(row.dose_class_idx), "unknown")
        if class_filter is not None and dose_class not in class_filter:
            continue
        time_bucket = bucket_decode.get(int(row.time_bucket_idx), "unknown")
        if bucket_filter is not None and time_bucket not in bucket_filter:
            continue
        record: dict[str, Any] = {
            "kind": "row",
            "user_id": uid,
            "dose_id": getattr(row, "dose_id", None),
            "dose_class": dose_class,
            "time_bucket": time_bucket,
            "miss_probability": round(prob, 6),
            "risk_tier": tier,
        }
        yield (json.dumps(record) + "\n").encode("utf-8")
        emitted += 1
        if limit is not None and emitted >= limit:
            break
    yield (json.dumps({"kind": "footer", "emitted": emitted}) + "\n").encode("utf-8")


def _stream_csv(
    df: pd.DataFrame,
    *,
    model_name: str,
    model_version: str,
    tier_filter: set[str] | None,
    min_prob: float,
    max_prob: float,
    class_filter: set[str] | None,
    bucket_filter: set[str] | None,
    user_filter: set[str] | None,
    limit: int | None,
) -> Iterator[bytes]:
    """Stream cohort risk scores as CSV with formula-injection-safe cells.

    Mirrors :func:`_stream` filtering exactly so the two formats produce
    the same row set for the same request.
    """
    class_decode = {i: c for i, c in enumerate(DOSE_CLASSES)}
    bucket_decode = {i: b for i, b in enumerate(TIME_BUCKETS)}
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(_CSV_COLUMNS)
    yield buf.getvalue().encode("utf-8")
    buf.seek(0)
    buf.truncate(0)
    emitted = 0
    for row in df.itertuples(index=False):
        uid = str(row.user_id)
        if user_filter is not None and uid not in user_filter:
            continue
        prob = float(row.miss_probability)
        if prob < min_prob or prob > max_prob:
            continue
        tier = _tier(prob)
        if tier_filter is not None and tier not in tier_filter:
            continue
        dose_class = class_decode.get(int(row.dose_class_idx), "unknown")
        if class_filter is not None and dose_class not in class_filter:
            continue
        time_bucket = bucket_decode.get(int(row.time_bucket_idx), "unknown")
        if bucket_filter is not None and time_bucket not in bucket_filter:
            continue
        writer.writerow(
            safe_row(
                [
                    uid,
                    getattr(row, "dose_id", "") or "",
                    dose_class,
                    time_bucket,
                    f"{round(prob, 6):.6f}",
                    tier,
                    model_name,
                    model_version,
                ]
            )
        )
        chunk = buf.getvalue()
        if chunk:
            yield chunk.encode("utf-8")
            buf.seek(0)
            buf.truncate(0)
        emitted += 1
        if limit is not None and emitted >= limit:
            break


@router.post("/risk/export")
def cohort_risk_export(
    payload: dict[str, Any] = Body(default_factory=dict),
    model_name: str = Query("default"),
    risk_tier: str | None = Query(
        None, description="Comma-separated tier filter: low,medium,high"
    ),
    min_probability: float = Query(0.0, ge=0.0, le=1.0),
    max_probability: float = Query(
        1.0, ge=0.0, le=1.0,
        description=(
            "Inclusive upper bound on miss_probability. Combined with"
            " `min_probability`, lets callers carve out a single risk band"
            " (for example 0.4..0.7 to export only borderline-medium doses"
            " for nurse review) without post-filtering downstream."
        ),
    ),
    dose_class: str | None = Query(
        None, description="Comma-separated dose class allowlist"
    ),
    time_bucket: str | None = Query(
        None,
        description=(
            "Comma-separated time-of-day bucket allowlist. Subset of"
            " early_morning,morning,midday,afternoon,evening,night."
            " Lets care teams pull, for example, only evening doses for"
            " a pharmacist call list without post-filtering downstream."
        ),
    ),
    user_ids: str | None = Query(
        None, description="Comma-separated user_id allowlist"
    ),
    limit: int | None = Query(
        None, ge=1, le=1_000_000,
        description="Max rows to emit after filtering (None = unlimited).",
    ),
    format: str = Query(
        "ndjson",
        description=(
            "Output format. `ndjson` (default) streams one JSON object per"
            " line with header/row/footer envelopes. `csv` streams a flat"
            " CSV with a header row, suitable for direct Excel / BI ingest."
            " CSV cells are neutralized against spreadsheet formula"
            " injection (OWASP CWE-1236)."
        ),
    ),
    sort: str = Query(
        "none",
        description=(
            "Row ordering before `limit` is applied. `none` (default)"
            " preserves the natural cohort order. `risk_desc` emits highest"
            " miss_probability first, which combined with `limit` gives a"
            " top-N highest-risk export. `risk_asc` reverses that."
        ),
    ),
    _p=Depends(require_service),
) -> StreamingResponse:
    fmt = format.lower().strip()
    if fmt not in _VALID_FORMATS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"format must be one of {sorted(_VALID_FORMATS)}",
        )
    sort_mode = sort.lower().strip()
    if sort_mode not in _VALID_SORTS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"sort must be one of {sorted(_VALID_SORTS)}",
        )
    try:
        art, model = ModelRegistry().latest(model_name)
    except ModelNotFoundError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc))

    tier_filter = _parse_csv(risk_tier)
    if tier_filter is not None and not tier_filter.issubset(_VALID_TIERS):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"risk_tier must be subset of {sorted(_VALID_TIERS)}",
        )
    class_filter = _parse_csv(dose_class)
    if class_filter is not None and not class_filter.issubset(set(DOSE_CLASSES)):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"dose_class must be subset of {DOSE_CLASSES}",
        )
    bucket_filter = _parse_csv(time_bucket)
    if bucket_filter is not None and not bucket_filter.issubset(_VALID_BUCKETS):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"time_bucket must be subset of {sorted(_VALID_BUCKETS)}",
        )
    user_filter = _parse_csv(user_ids)

    if max_probability < min_probability:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="max_probability must be >= min_probability",
        )

    events_payload = payload.get("events")
    if events_payload:
        events = pd.DataFrame(events_payload)
        events["scheduled_at"] = pd.to_datetime(events["scheduled_at"], utc=True, errors="coerce")
        if "taken_at" in events.columns:
            events["taken_at"] = pd.to_datetime(events["taken_at"], utc=True, errors="coerce")
    else:
        cfg = payload.get("synthetic", {}) or {}
        events = generate_events(
            SyntheticConfig(
                n_users=int(cfg.get("n_users", 200)),
                n_days=int(cfg.get("n_days", 14)),
                seed=int(cfg.get("seed", 11)),
            )
        )

    df = build_training_frame(events)
    if df.empty:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "no scoreable doses in cohort")

    X = df[model.feature_columns]
    df = df.copy()
    df["miss_probability"] = model.predict_proba(X)

    if sort_mode == "risk_desc":
        df = df.sort_values("miss_probability", ascending=False, kind="mergesort")
    elif sort_mode == "risk_asc":
        df = df.sort_values("miss_probability", ascending=True, kind="mergesort")

    if fmt == "csv":
        return StreamingResponse(
            _stream_csv(
                df,
                model_name=model_name,
                model_version=art.version,
                tier_filter=tier_filter,
                min_prob=float(min_probability),
                max_prob=float(max_probability),
                class_filter=class_filter,
                bucket_filter=bucket_filter,
                user_filter=user_filter,
                limit=limit,
            ),
            media_type="text/csv; charset=utf-8",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="cohort_risk_{model_name}_{art.version}.csv"'
                ),
            },
        )

    return StreamingResponse(
        _stream(
            df,
            model_name=model_name,
            model_version=art.version,
            tier_filter=tier_filter,
            min_prob=float(min_probability),
            max_prob=float(max_probability),
            class_filter=class_filter,
            bucket_filter=bucket_filter,
            user_filter=user_filter,
            limit=limit,
        ),
        media_type="application/x-ndjson",
        headers={
            "Content-Disposition": (
                f'attachment; filename="cohort_risk_{model_name}_{art.version}.ndjson"'
            ),
        },
    )
