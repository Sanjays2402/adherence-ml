"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  UploadSimple,
  FileCsv,
  Lightning,
  DownloadSimple,
  Spinner,
  Warning,
  CheckCircle,
  X,
  ArrowsClockwise,
  Code,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Button,
  Badge,
  ErrorBox,
  Empty,
  Stat,
  Skeleton,
} from "@/components/ui/primitives";
import { fmtPct, cn } from "@/lib/utils";

const MAX_BYTES = 256 * 1024;
const MAX_ROWS = 500;

const REQUIRED_COLUMNS = [
  "user_id",
  "dose_id",
  "scheduled_at",
  "dose_class",
  "dose_strength_mg",
] as const;

interface BatchOutRow {
  user_id: string;
  dose_id: string;
  scheduled_at: string;
  dose_class: string;
  miss_probability: number;
  risk_tier: "low" | "medium" | "high";
  top_reason: string;
  model_version: string;
}

interface BatchSummary {
  users: number;
  rows: number;
  predictions: number;
  high_risk: number;
  mean_miss_probability: number;
  latency_ms: number;
}

interface BatchResponse {
  summary: BatchSummary;
  per_user: Array<{ user_id: string; predictions: number; model_version: string }>;
  rows: BatchOutRow[];
}

const SAMPLE_CSV = `user_id,dose_id,scheduled_at,dose_class,dose_strength_mg
demo-cardio-001,d-001,2025-06-01T08:00:00Z,cardio,10
demo-cardio-001,d-002,2025-06-01T20:00:00Z,cardio,10
demo-cardio-001,d-003,2025-06-02T08:00:00Z,cardio,10
demo-psych-002,p-001,2025-06-01T09:00:00Z,psych,50
demo-psych-002,p-002,2025-06-02T09:00:00Z,psych,50
demo-endo-003,e-001,2025-06-01T07:30:00Z,endocrine,500
demo-endo-003,e-002,2025-06-01T19:30:00Z,endocrine,500
demo-endo-003,e-003,2025-06-02T07:30:00Z,endocrine,500
`;

function readableBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function tierBadge(t: BatchOutRow["risk_tier"]) {
  if (t === "high") return <Badge tone="danger">high</Badge>;
  if (t === "medium") return <Badge tone="warn">medium</Badge>;
  return <Badge tone="success">low</Badge>;
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

function escapeCsvField(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCsv(rows: BatchOutRow[]): string {
  const header = [
    "user_id",
    "dose_id",
    "scheduled_at",
    "dose_class",
    "miss_probability",
    "risk_tier",
    "top_reason",
    "model_version",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.user_id,
        r.dose_id,
        r.scheduled_at,
        r.dose_class,
        r.miss_probability,
        r.risk_tier,
        r.top_reason,
        r.model_version,
      ]
        .map(escapeCsvField)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

interface QuickPreview {
  totalLines: number;
  header: string[];
  missing: string[];
  preview: string[][];
}

function quickPreview(csv: string): QuickPreview {
  const lines = csv.replace(/\r\n/g, "\n").split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return { totalLines: 0, header: [], missing: [...REQUIRED_COLUMNS], preview: [] };
  const header = lines[0].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  const preview = lines
    .slice(1, 6)
    .map((l) => l.split(",").map((s) => s.trim().replace(/^"|"$/g, "")));
  return { totalLines: lines.length - 1, header, missing, preview };
}

export default function BatchClient() {
  const [csv, setCsv] = useState<string>("");
  const [filename, setFilename] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BatchResponse | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const preview = useMemo(() => (csv ? quickPreview(csv) : null), [csv]);
  const byteSize = useMemo(() => new Blob([csv]).size, [csv]);
  const overSize = byteSize > MAX_BYTES;
  const overRows = (preview?.totalLines ?? 0) > MAX_ROWS;
  const missingCols = preview?.missing ?? [];
  const canRun =
    !loading && !!csv && !overSize && !overRows && missingCols.length === 0 && (preview?.totalLines ?? 0) > 0;

  const acceptFile = useCallback(async (file: File) => {
    setError(null);
    setResult(null);
    if (file.size > MAX_BYTES) {
      setError(`File is ${readableBytes(file.size)}; the limit is ${readableBytes(MAX_BYTES)}.`);
      return;
    }
    const text = await file.text();
    setFilename(file.name);
    setCsv(text);
  }, []);

  const onDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) await acceptFile(file);
    },
    [acceptFile],
  );

  const onPick = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) await acceptFile(file);
      // reset so the same file can be re-picked
      if (fileRef.current) fileRef.current.value = "";
    },
    [acceptFile],
  );

  const loadSample = useCallback(() => {
    setError(null);
    setResult(null);
    setFilename("sample-doses.csv");
    setCsv(SAMPLE_CSV);
  }, []);

  const clear = useCallback(() => {
    setCsv("");
    setFilename("");
    setError(null);
    setResult(null);
  }, []);

  const run = useCallback(async () => {
    if (!csv) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/batch", {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: csv,
      });
      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        const e = body as { error?: string; detail?: unknown } | null;
        const msg =
          e?.error === "row_validation_failed"
            ? `Row validation failed. ${JSON.stringify(e.detail).slice(0, 240)}`
            : e?.error === "missing_columns"
              ? `Missing required columns: ${(e.detail as { missing?: string[] })?.missing?.join(", ") ?? "?"}`
              : e?.error
                ? `${e.error}: ${typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail).slice(0, 200)}`
                : `Request failed (${res.status})`;
        setError(msg);
        return;
      }
      setResult(body as BatchResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [csv]);

  const downloadCsv = useCallback(() => {
    if (!result) return;
    downloadBlob(
      `adherence-batch-${Date.now()}.csv`,
      new Blob([rowsToCsv(result.rows)], { type: "text/csv;charset=utf-8" }),
    );
  }, [result]);

  const downloadJson = useCallback(() => {
    if (!result) return;
    downloadBlob(
      `adherence-batch-${Date.now()}.json`,
      new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
    );
  }, [result]);

  return (
    <div className="px-4 sm:px-6 lg:px-10 py-6 max-w-6xl mx-auto space-y-6">
      <PageHeader
        eyebrow="Batch scoring"
        title="Score a CSV of scheduled doses"
        description="Upload up to 500 rows across 50 users. We return per-dose miss probability, risk tier, and the top reason, with CSV or JSON download."
      />

      <Card>
        <CardHeader title="Upload" hint="Drop a CSV file, paste rows, or start from a sample." />
        <div className="p-4 space-y-4">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={cn(
              "rounded-lg border border-dashed p-6 sm:p-8 text-center transition-colors",
              dragOver
                ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                : "border-[var(--color-border)] bg-[var(--color-surface)]/40",
            )}
          >
            <UploadSimple weight="duotone" size={28} className="mx-auto text-[var(--color-accent)]" />
            <div className="mt-2 text-sm">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="font-medium text-[var(--color-fg)] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] rounded"
              >
                Choose a CSV
              </button>
              <span className="text-[var(--color-muted)]"> or drag and drop here.</span>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={onPick}
              className="sr-only"
              aria-label="Upload CSV file"
            />
            <div className="mt-3 text-[11px] font-mono uppercase tracking-wider text-[var(--color-subtle)]">
              Required columns: {REQUIRED_COLUMNS.join(", ")}
            </div>
            <div className="mt-1 text-[11px] font-mono uppercase tracking-wider text-[var(--color-subtle)]">
              Max {readableBytes(MAX_BYTES)} / {MAX_ROWS} rows / 50 users
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={loadSample}>
              <FileCsv weight="duotone" size={16} /> Load sample
            </Button>
            {csv && (
              <Button variant="ghost" onClick={clear}>
                <X weight="duotone" size={16} /> Clear
              </Button>
            )}
            <div className="ml-auto" />
            <Button onClick={run} disabled={!canRun}>
              {loading ? (
                <>
                  <Spinner weight="duotone" size={16} className="animate-spin" /> Scoring
                </>
              ) : (
                <>
                  <Lightning weight="duotone" size={16} /> Run batch
                </>
              )}
            </Button>
          </div>

          {csv && preview && (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/60 p-3 text-xs space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <FileCsv weight="duotone" size={14} className="text-[var(--color-accent)]" />
                <span className="font-mono truncate max-w-[12rem]">{filename || "pasted.csv"}</span>
                <span className="text-[var(--color-subtle)]">·</span>
                <span className="text-[var(--color-muted)]">{readableBytes(byteSize)}</span>
                <span className="text-[var(--color-subtle)]">·</span>
                <span className="text-[var(--color-muted)]">{preview.totalLines} rows</span>
                {overSize && <Badge tone="danger">over size limit</Badge>}
                {overRows && <Badge tone="danger">over row limit</Badge>}
                {missingCols.length > 0 && (
                  <Badge tone="danger">missing: {missingCols.join(", ")}</Badge>
                )}
                {!overSize && !overRows && missingCols.length === 0 && (
                  <Badge tone="success">ready</Badge>
                )}
              </div>
              {preview.preview.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-[11px] font-mono">
                    <thead>
                      <tr className="text-[var(--color-subtle)] uppercase tracking-wider">
                        {preview.header.map((h) => (
                          <th key={h} className="text-left pr-4 pb-1">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.preview.map((row, i) => (
                        <tr key={i} className="border-t border-[var(--color-border)]/60">
                          {row.map((cell, j) => (
                            <td key={j} className="pr-4 py-1 text-[var(--color-fg)]">
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.totalLines > preview.preview.length && (
                    <div className="pt-1 text-[var(--color-subtle)]">
                      Showing first {preview.preview.length} of {preview.totalLines} rows.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {error && <ErrorBox message={error} />}
        </div>
      </Card>

      {loading && (
        <Card>
          <CardHeader title="Scoring in progress" hint="Calling the model for each user." />
          <div className="p-4 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-24 w-full" />
          </div>
        </Card>
      )}

      {!loading && !result && !csv && (
        <Card>
          <Empty
            icon={<UploadSimple weight="duotone" size={28} className="text-[var(--color-accent)]" />}
            title="No batch yet"
            hint="Drop a CSV above or click Load sample to see the round trip end to end."
          />
        </Card>
      )}

      {result && (
        <>
          <Card>
            <CardHeader
              title="Results"
              hint={`${result.summary.predictions} predictions across ${result.summary.users} users in ${result.summary.latency_ms} ms.`}
              right={
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={downloadCsv}>
                    <DownloadSimple weight="duotone" size={16} /> CSV
                  </Button>
                  <Button variant="ghost" onClick={downloadJson}>
                    <Code weight="duotone" size={16} /> JSON
                  </Button>
                  <Button variant="ghost" onClick={run}>
                    <ArrowsClockwise weight="duotone" size={16} /> Rerun
                  </Button>
                </div>
              }
            />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4">
              <Stat label="Users" value={String(result.summary.users)} />
              <Stat label="Predictions" value={String(result.summary.predictions)} />
              <Stat
                label="High risk"
                value={String(result.summary.high_risk)}
                sub={fmtPct(result.summary.predictions > 0 ? result.summary.high_risk / result.summary.predictions : 0)}
              />
              <Stat label="Mean miss p" value={fmtPct(result.summary.mean_miss_probability)} />
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Per dose"
              hint="Sorted by miss probability, highest first."
              right={
                <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--color-subtle)]">
                  showing first 200
                </span>
              }
            />
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="text-[10px] font-mono uppercase tracking-wider text-[var(--color-subtle)] border-b border-[var(--color-border)]">
                  <tr>
                    <th className="text-left px-3 py-2">User</th>
                    <th className="text-left px-3 py-2">Dose</th>
                    <th className="text-left px-3 py-2">Scheduled</th>
                    <th className="text-left px-3 py-2">Class</th>
                    <th className="text-right px-3 py-2">Miss p</th>
                    <th className="text-left px-3 py-2">Tier</th>
                    <th className="text-left px-3 py-2">Top reason</th>
                  </tr>
                </thead>
                <tbody>
                  {[...result.rows]
                    .sort((a, b) => b.miss_probability - a.miss_probability)
                    .slice(0, 200)
                    .map((r, i) => (
                      <tr key={i} className="border-b border-[var(--color-border)]/40 hover:bg-[var(--color-border)]/10">
                        <td className="px-3 py-2 font-mono text-[var(--color-fg)]">{r.user_id}</td>
                        <td className="px-3 py-2 font-mono text-[var(--color-muted)]">{r.dose_id}</td>
                        <td className="px-3 py-2 text-[var(--color-muted)] whitespace-nowrap">{r.scheduled_at}</td>
                        <td className="px-3 py-2 text-[var(--color-muted)]">{r.dose_class || "—"}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-[var(--color-fg)]">
                          {fmtPct(r.miss_probability)}
                        </td>
                        <td className="px-3 py-2">{tierBadge(r.risk_tier)}</td>
                        <td className="px-3 py-2 text-[var(--color-muted)] max-w-[24rem] truncate">{r.top_reason || "—"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {result.rows.length === 0 && (
              <div className="p-4">
                <Empty
                  icon={<Warning weight="duotone" size={24} className="text-[var(--color-warn)]" />}
                  title="No predictions returned"
                  hint="The model accepted the request but returned no rows. Double-check your scheduled_at values."
                />
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Per user" hint="One row per user_id in the upload." />
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="text-[10px] font-mono uppercase tracking-wider text-[var(--color-subtle)] border-b border-[var(--color-border)]">
                  <tr>
                    <th className="text-left px-3 py-2">User</th>
                    <th className="text-right px-3 py-2">Predictions</th>
                    <th className="text-left px-3 py-2">Model</th>
                    <th className="text-left px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.per_user.map((u) => (
                    <tr key={u.user_id} className="border-b border-[var(--color-border)]/40">
                      <td className="px-3 py-2 font-mono">{u.user_id}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{u.predictions}</td>
                      <td className="px-3 py-2 font-mono text-[var(--color-muted)]">{u.model_version}</td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1 text-[var(--color-success)]">
                          <CheckCircle weight="duotone" size={14} /> ok
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
