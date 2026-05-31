"use client";

/**
 * Audit chain integrity panel.
 *
 * One-pane SOC2-evidence card: shows entry count, head/tip timestamps and
 * hashes, chain status, and offers a one-click signed bundle download. The
 * verification call itself is audited so each click advances the tip hash.
 */
import useSWR from "swr";
import { useCallback, useState } from "react";
import {
  ShieldCheck,
  ShieldWarning,
  DownloadSimple,
  ArrowClockwise,
  Fingerprint,
  Hash,
} from "@phosphor-icons/react";
import {
  Card,
  CardHeader,
  Empty,
  ErrorBox,
  Skeleton,
  Button,
  Badge,
  MonoChip,
} from "@/components/ui/primitives";

interface IntegrityReport {
  entries: number;
  chain_valid: boolean;
  tip_hash: string | null;
  tip_ts: number | null;
  head_ts: number | null;
  genesis_hash: string;
  first_break_index: number | null;
  first_break_id: string | null;
  first_break_reason: string | null;
  has_corrupt_lines: boolean;
  verified_at: string;
}

const fetcher = async (url: string): Promise<IntegrityReport> => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))) as { detail?: string };
    throw new Error(detail.detail ?? `HTTP ${r.status}`);
  }
  return (await r.json()) as IntegrityReport;
};

function fmtAbs(ms: number | null): string {
  if (!ms) return "never";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function truncateHash(h: string | null): string {
  if (!h) return "0000…";
  return `${h.slice(0, 12)}…${h.slice(-8)}`;
}

export default function AuditIntegrityPanel() {
  const { data, error, isLoading, mutate, isValidating } = useSWR<IntegrityReport>(
    "/api/audit/integrity",
    fetcher,
    { revalidateOnFocus: false },
  );

  const [downloading, setDownloading] = useState(false);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);

  const handleDownload = useCallback(async () => {
    setDownloadErr(null);
    setDownloading(true);
    try {
      const r = await fetch("/api/audit/bundle", { cache: "no-store" });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { detail?: string };
        setDownloadErr(d.detail ?? `HTTP ${r.status}`);
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const disp = r.headers.get("content-disposition") ?? "";
      const m = disp.match(/filename="([^"]+)"/);
      a.download =
        m?.[1] ?? `audit-bundle-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      // re-fetch so the panel shows the new tip (the export call appended one entry).
      void mutate();
    } catch {
      setDownloadErr("Network error during bundle download.");
    } finally {
      setDownloading(false);
    }
  }, [mutate]);

  if (isLoading) {
    return (
      <Card>
        <CardHeader
          title="audit chain integrity"
          hint="Tamper-evident SHA-256 chain over every dashboard mutation."
        />
        <div className="space-y-2 px-4 pb-4 pt-3">
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-80" />
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader
          title="audit chain integrity"
          hint="Tamper-evident SHA-256 chain over every dashboard mutation."
        />
        <div className="px-4 pb-4 pt-3">
          <ErrorBox message={(error as Error).message} />
          <div className="mt-3">
            <Button onClick={() => mutate()} variant="ghost">
              <ArrowClockwise size={14} weight="bold" /> retry
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardHeader title="audit chain integrity" />
        <div className="px-4 pb-4 pt-3">
          <Empty title="no report" hint="Audit chain report unavailable." />
        </div>
      </Card>
    );
  }

  const valid = data.chain_valid;
  return (
    <Card>
      <CardHeader
        title="audit chain integrity"
        hint="Tamper-evident SHA-256 chain over every dashboard mutation. Each entry stores prev_hash plus hash, so any edit invalidates the chain."
        right={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => mutate()}
              disabled={isValidating}
              aria-label="re-verify chain"
            >
              <ArrowClockwise size={14} weight="bold" />
              {isValidating ? "verifying" : "re-verify"}
            </Button>
            <Button
              onClick={handleDownload}
              disabled={downloading || data.entries === 0}
              aria-label="download signed evidence bundle"
            >
              <DownloadSimple size={14} weight="bold" />
              {downloading ? "preparing" : "download bundle"}
            </Button>
          </div>
        }
      />
      <div className="space-y-4 px-4 pb-4 pt-3">
        <div className="flex flex-wrap items-center gap-3">
          {valid ? (
            <Badge tone="success">
              <ShieldCheck size={14} weight="duotone" /> chain valid
            </Badge>
          ) : (
            <Badge tone="danger">
              <ShieldWarning size={14} weight="duotone" /> chain broken
            </Badge>
          )}
          <span className="text-xs text-[var(--color-muted)]">
            {data.entries.toLocaleString()} entries
          </span>
          <span className="text-xs text-[var(--color-muted)]">
            verified {fmtAbs(Date.parse(data.verified_at))}
          </span>
        </div>

        {data.entries === 0 ? (
          <Empty
            title="no audit entries yet"
            hint="Mutations will appear here once anyone changes settings, exports data, or signs in."
          />
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
                <Fingerprint size={12} weight="duotone" className="-mt-0.5 mr-1 inline" />
                head entry
              </dt>
              <dd className="mt-0.5 tabular-nums">{fmtAbs(data.head_ts)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
                <Fingerprint size={12} weight="duotone" className="-mt-0.5 mr-1 inline" />
                tip entry
              </dt>
              <dd className="mt-0.5 tabular-nums">{fmtAbs(data.tip_ts)}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
                <Hash size={12} weight="duotone" className="-mt-0.5 mr-1 inline" />
                tip hash
              </dt>
              <dd className="mt-1 break-all">
                <MonoChip>{data.tip_hash ?? "none"}</MonoChip>
                <span className="ml-2 text-xs text-[var(--color-muted)]">
                  short: {truncateHash(data.tip_hash)}
                </span>
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
                <Hash size={12} weight="duotone" className="-mt-0.5 mr-1 inline" />
                genesis
              </dt>
              <dd className="mt-1 break-all">
                <MonoChip>{data.genesis_hash}</MonoChip>
              </dd>
            </div>
          </dl>
        )}

        {!valid && (
          <div className="rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium">
              <ShieldWarning size={14} weight="duotone" /> chain integrity failed
            </div>
            <ul className="mt-2 space-y-1 text-xs">
              {data.first_break_index !== null && (
                <li>
                  first break at index{" "}
                  <MonoChip>{data.first_break_index}</MonoChip> (entry id{" "}
                  <MonoChip>{data.first_break_id ?? "?"}</MonoChip>)
                </li>
              )}
              {data.first_break_reason && (
                <li>reason: {data.first_break_reason}</li>
              )}
              {data.has_corrupt_lines && <li>one or more lines failed to parse</li>}
              <li>
                Treat earlier entries as authoritative up to index{" "}
                <MonoChip>
                  {data.first_break_index !== null
                    ? data.first_break_index - 1
                    : "n/a"}
                </MonoChip>
                .
              </li>
            </ul>
          </div>
        )}

        {downloadErr && <ErrorBox message={downloadErr} />}

        <p className="text-xs text-[var(--color-muted)]">
          The bundle is a single JSON document with a manifest (entries_root =
          sha256 over every entry hash), the verification report, and every
          entry in chronological order. Recompute entries_root on the bundle
          alone to detect any post-export tampering.
        </p>
      </div>
    </Card>
  );
}
