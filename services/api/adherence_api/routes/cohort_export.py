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
  exclude_user_ids: comma-separated denylist of user ids to skip
  offset: number of post-filter rows to skip before emitting (paging)

The request body matches /v1/cohort/risk so the two endpoints are
interchangeable from a payload perspective.

Response headers ``X-Scored-At``, ``X-Model-Name``, ``X-Model-Version``
and ``X-Total-Candidates`` are set on every export shape (NDJSON, CSV,
count_only) so reverse proxies, audit loggers and snapshot pipelines
can partition by run and compute filter selectivity
(emitted / total_candidates) without parsing the response body.
"""
from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timezone
from typing import Any, Iterator

import pandas as pd
from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse, StreamingResponse

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


def _utc_now_iso() -> str:
    """Second-precision UTC ISO-8601 timestamp for export envelopes.

    Stamped once per export so every row in an NDJSON/CSV file shares the
    same scored_at, which is what nightly snapshot pipelines need to
    partition by run (BigQuery / Snowflake `_PARTITIONTIME`-style) and to
    do point-in-time joins against the underlying patient table.
    """
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _stream(
    df: pd.DataFrame,
    *,
    model_name: str,
    model_version: str,
    scored_at: str,
    tier_filter: set[str] | None,
    min_prob: float,
    max_prob: float,
    class_filter: set[str] | None,
    bucket_filter: set[str] | None,
    user_filter: set[str] | None,
    user_denylist: set[str] | None,
    offset: int,
    limit: int | None,
) -> Iterator[bytes]:
    class_decode = {i: c for i, c in enumerate(DOSE_CLASSES)}
    bucket_decode = {i: b for i, b in enumerate(TIME_BUCKETS)}
    emitted = 0
    skipped = 0
    by_tier = {"low": 0, "medium": 0, "high": 0}
    by_dose_class: dict[str, int] = {}
    by_time_bucket: dict[str, int] = {}
    probs: list[float] = []
    header = {
        "kind": "header",
        "model_name": model_name,
        "model_version": model_version,
        "scored_at": scored_at,
        "total_candidates": int(len(df)),
    }
    yield (json.dumps(header) + "\n").encode("utf-8")
    for row in df.itertuples(index=False):
        uid = str(row.user_id)
        if user_filter is not None and uid not in user_filter:
            continue
        if user_denylist is not None and uid in user_denylist:
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
        if skipped < offset:
            skipped += 1
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
        by_tier[tier] += 1
        by_dose_class[dose_class] = by_dose_class.get(dose_class, 0) + 1
        by_time_bucket[time_bucket] = by_time_bucket.get(time_bucket, 0) + 1
        probs.append(prob)
        if limit is not None and emitted >= limit:
            break
    # Include by_dose_class / by_time_bucket in the footer so streaming
    # consumers get the same one-pass breakdown count_only already returns,
    # without re-reading the NDJSON to tally per-class / per-bucket volume.
    # probability_stats mirrors count_only so streaming consumers can write
    # a manifest row (min/max/mean/p50/p95 of emitted miss_probability)
    # straight from the footer without a second pass over the NDJSON.
    probability_stats: dict[str, float] | None = None
    if probs:
        probs_sorted = sorted(probs)
        n = len(probs_sorted)

        def _pct(p: float) -> float:
            # nearest-rank percentile, 1-indexed, matches count_only
            k = max(1, min(n, int(-(-p * n // 1))))  # ceil(p*n)
            return probs_sorted[k - 1]

        probability_stats = {
            "min": round(probs_sorted[0], 6),
            "max": round(probs_sorted[-1], 6),
            "mean": round(sum(probs_sorted) / n, 6),
            "p50": round(_pct(0.50), 6),
            "p95": round(_pct(0.95), 6),
        }
    yield (
        json.dumps(
            {
                "kind": "footer",
                "emitted": emitted,
                "by_tier": by_tier,
                "by_dose_class": dict(sorted(by_dose_class.items())),
                "by_time_bucket": dict(sorted(by_time_bucket.items())),
                "probability_stats": probability_stats,
                "scored_at": scored_at,
            }
        )
        + "\n"
    ).encode("utf-8")


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
    user_denylist: set[str] | None,
    offset: int,
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
    skipped = 0
    for row in df.itertuples(index=False):
        uid = str(row.user_id)
        if user_filter is not None and uid not in user_filter:
            continue
        if user_denylist is not None and uid in user_denylist:
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
        if skipped < offset:
            skipped += 1
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
    exclude_user_ids: str | None = Query(
        None,
        description=(
            "Comma-separated user_id denylist. Rows whose user_id appears"
            " here are skipped. Lets nightly pipelines exclude patients"
            " already contacted today (or opted out of outreach) without"
            " post-filtering downstream. Applied after `user_ids`"
            " allowlist, so a user listed in both is excluded."
        ),
    ),
    limit: int | None = Query(
        None, ge=1, le=1_000_000,
        description="Max rows to emit after filtering (None = unlimited).",
    ),
    offset: int = Query(
        0, ge=0, le=10_000_000,
        description=(
            "Number of post-filter, post-sort rows to skip before emitting."
            " Combined with `limit`, gives stable chunked pagination of large"
            " nightly cohorts (for example offset=0/limit=10000, then"
            " offset=10000/limit=10000, ...) without holding the full export"
            " in memory. Applied after `sort` so paging through `risk_desc`"
            " yields next-N highest-risk doses."
        ),
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
    worst_per_user: bool = Query(
        False,
        description=(
            "If true, collapse the cohort to one row per user_id keeping"
            " only that user's highest miss_probability dose. Lets care"
            " teams build a per-patient outreach list (one call per"
            " patient on their riskiest dose of the day) without"
            " deduplicating downstream. Ties are broken by the natural"
            " cohort order. Dedup runs before per-row filters, so a"
            " patient whose worst dose falls outside `risk_tier` /"
            " `min_probability` / `max_probability` is dropped entirely"
            " (which is what an outreach list wants: do not page a"
            " patient on their second-worst dose). Applied before `sort`,"
            " `offset`, `limit`, so paging through `risk_desc` with"
            " `worst_per_user=true` yields the top-N highest-risk"
            " patients. In `count_only` mode the breakdowns also reflect"
            " the deduplicated set, so `count` equals distinct users."
        ),
    ),
    count_only: bool = Query(
        False,
        description=(
            "If true, skip streaming rows and return a single JSON object"
            " with the post-filter row count and a per-tier breakdown."
            " Lets operators size a nightly outreach batch (`how many high"
            " risk patients will I page tonight?`) before kicking off the"
            " full export. All other filters (`risk_tier`, `min_probability`,"
            " `max_probability`, `dose_class`, `time_bucket`, `user_ids`,"
            " `exclude_user_ids`) apply identically. `offset`, `limit`, and"
            " `sort` are ignored because they do not affect the count."
            " Response also breaks the count down by dose_class and"
            " time_bucket so staffing models can see, in one call, how many"
            " high-risk insulin doses fall in the evening bucket without"
            " running the export per (class, bucket) pair."
        ),
    ),
    _p=Depends(require_service),
):
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
    user_denylist = _parse_csv(exclude_user_ids)

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

    scored_at = _utc_now_iso()
    total_candidates = int(len(df))

    if worst_per_user:
        # Stable sort by probability descending, then drop_duplicates keeps
        # the first occurrence per user_id, which is that user's worst dose.
        # `total_candidates` is captured pre-dedupe so consumers can still
        # compute filter selectivity against the underlying cohort size.
        df = (
            df.sort_values("miss_probability", ascending=False, kind="mergesort")
              .drop_duplicates(subset=["user_id"], keep="first")
        )

    if count_only:
        class_decode = {i: c for i, c in enumerate(DOSE_CLASSES)}
        bucket_decode = {i: b for i, b in enumerate(TIME_BUCKETS)}
        min_prob = float(min_probability)
        max_prob = float(max_probability)
        counts = {"low": 0, "medium": 0, "high": 0}
        by_dose_class: dict[str, int] = {}
        by_time_bucket: dict[str, int] = {}
        # Cross-tab of risk tier per dose_class and per time_bucket.
        # Lets staffing planners see, in one call, the severity mix
        # inside each medication class (e.g. "how many of tonight's
        # insulin doses are high risk vs low risk") without rerunning
        # the export per (class, tier) or (bucket, tier) pair.
        by_tier_dose_class: dict[str, dict[str, int]] = {}
        by_tier_time_bucket: dict[str, dict[str, int]] = {}
        probs: list[float] = []
        total = 0
        for row in df.itertuples(index=False):
            uid = str(row.user_id)
            if user_filter is not None and uid not in user_filter:
                continue
            if user_denylist is not None and uid in user_denylist:
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
            tb = bucket_decode.get(int(row.time_bucket_idx), "unknown")
            if bucket_filter is not None and tb not in bucket_filter:
                continue
            counts[tier] += 1
            by_dose_class[dose_class] = by_dose_class.get(dose_class, 0) + 1
            by_time_bucket[tb] = by_time_bucket.get(tb, 0) + 1
            dc_tiers = by_tier_dose_class.setdefault(
                dose_class, {"low": 0, "medium": 0, "high": 0}
            )
            dc_tiers[tier] += 1
            tb_tiers = by_tier_time_bucket.setdefault(
                tb, {"low": 0, "medium": 0, "high": 0}
            )
            tb_tiers[tier] += 1
            probs.append(prob)
            total += 1
        # Distribution of miss_probability across post-filter rows so
        # staffing planners can see, in one call, both `how many` and
        # `how risky` without streaming the full export. p50/p95 use
        # nearest-rank on the sorted array (no numpy dependency, no
        # interpolation surprises). All values rounded to 6 decimals
        # to match the row-level miss_probability precision.
        probability_stats: dict[str, float] | None = None
        if probs:
            probs_sorted = sorted(probs)
            n = len(probs_sorted)

            def _pct(p: float) -> float:
                # nearest-rank percentile, 1-indexed
                k = max(1, min(n, int(-(-p * n // 1))))  # ceil(p*n)
                return probs_sorted[k - 1]

            probability_stats = {
                "min": round(probs_sorted[0], 6),
                "max": round(probs_sorted[-1], 6),
                "mean": round(sum(probs_sorted) / n, 6),
                "p50": round(_pct(0.50), 6),
                "p95": round(_pct(0.95), 6),
            }
        return JSONResponse(
            {
                "model_name": model_name,
                "model_version": art.version,
                "scored_at": scored_at,
                "total_candidates": total_candidates,
                "count": total,
                "by_tier": counts,
                "by_dose_class": dict(sorted(by_dose_class.items())),
                "by_time_bucket": dict(sorted(by_time_bucket.items())),
                "by_tier_dose_class": {
                    k: by_tier_dose_class[k] for k in sorted(by_tier_dose_class)
                },
                "by_tier_time_bucket": {
                    k: by_tier_time_bucket[k] for k in sorted(by_tier_time_bucket)
                },
                "probability_stats": probability_stats,
            },
            headers={
                "X-Scored-At": scored_at,
                "X-Model-Name": model_name,
                "X-Model-Version": art.version,
                "X-Total-Candidates": str(total_candidates),
            },
        )

    if sort_mode == "risk_desc":
        df = df.sort_values("miss_probability", ascending=False, kind="mergesort")
    elif sort_mode == "risk_asc":
        df = df.sort_values("miss_probability", ascending=True, kind="mergesort")

    # Date stamp in filename so nightly snapshot downloads (e.g. via
    # browser / curl -OJ / Airflow HttpOperator) don't overwrite each
    # other in the destination folder. Uses the same scored_at the
    # response headers advertise so the file on disk matches the
    # X-Scored-At header byte-for-byte (date portion).
    file_date = scored_at[:10]  # YYYY-MM-DD from ISO-8601

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
                user_denylist=user_denylist,
                offset=int(offset),
                limit=limit,
            ),
            media_type="text/csv; charset=utf-8",
            headers={
                "Content-Disposition": (
                    'attachment; filename="'
                    f"cohort_risk_{model_name}_{art.version}_{file_date}.csv"
                    '"'
                ),
                "X-Scored-At": scored_at,
                "X-Model-Name": model_name,
                "X-Model-Version": art.version,
                "X-Total-Candidates": str(total_candidates),
            },
        )

    return StreamingResponse(
        _stream(
            df,
            model_name=model_name,
            model_version=art.version,
            scored_at=scored_at,
            tier_filter=tier_filter,
            min_prob=float(min_probability),
            max_prob=float(max_probability),
            class_filter=class_filter,
            bucket_filter=bucket_filter,
            user_filter=user_filter,
            user_denylist=user_denylist,
            offset=int(offset),
            limit=limit,
        ),
        media_type="application/x-ndjson",
        headers={
            "Content-Disposition": (
                'attachment; filename="'
                f"cohort_risk_{model_name}_{art.version}_{file_date}.ndjson"
                '"'
            ),
            "X-Scored-At": scored_at,
            "X-Model-Name": model_name,
            "X-Model-Version": art.version,
            "X-Total-Candidates": str(total_candidates),
        },
    )
