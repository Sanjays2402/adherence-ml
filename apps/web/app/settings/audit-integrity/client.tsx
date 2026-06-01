"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle,
  Fingerprint,
  ShieldCheck,
  ShieldWarning,
  WarningOctagon,
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorBox,
  PageHeader,
  Skeleton,
  Stat,
} from "@/components/ui/primitives";

type ChainBreak = {
  row_id: number;
  reason: string;
  expected: string | null;
  actual: string | null;
};

type VerifyResp = {
  tenant: string;
  n_rows: number;
  n_hashed: number;
  ok: boolean;
  head_hash: string | null;
  breaks: ChainBreak[];
};

function shortHash(h: string | null): string {
  if (!h) return "none";
  return `${h.slice(0, 8)}…${h.slice(-6)}`;
}

function reasonLabel(reason: string): string {
  if (reason === "row_hash_mismatch") return "row contents changed";
  if (reason === "prev_hash_mismatch") return "link to previous row broken";
  return reason;
}

export default function AuditIntegrityClient() {
  const [result, setResult] = useState<VerifyResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);

  const verify = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/audit-chain", { cache: "no-store" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(
          typeof body?.detail === "string"
            ? body.detail
            : `verification failed (${r.status})`,
        );
      }
      setResult(body as VerifyResp);
      setVerifiedAt(
        new Date().toISOString().replace("T", " ").slice(0, 19) + "Z",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "verification failed");
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-4">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          <ArrowLeft size={12} weight="duotone" /> settings
        </Link>
      </div>

      <Card>
        <PageHeader
          eyebrow="soc2 cc7.2 / iso 27001 a.12.4.2"
          title="audit integrity"
          description="Recompute the tamper-evident sha256 hash chain on the admin audit log. Any edit, deletion, or reordering of a privileged action is detected and reported with the offending row id."
          actions={
            <Button
              variant="accent"
              onClick={verify}
              disabled={loading}
              aria-label="run chain verification"
            >
              <Fingerprint size={14} weight="duotone" />
              {loading ? "verifying" : "verify chain"}
            </Button>
          }
        />

        <div className="p-4">
          {loading && !result ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : null}

          {error ? <ErrorBox message={error} /> : null}

          {!loading && !error && !result ? (
            <Empty
              icon={<ShieldCheck size={22} weight="duotone" />}
              title="no verification run yet"
              hint="Click verify chain. The result and your identity are written back into the audit log so an auditor can prove a check was performed."
            />
          ) : null}

          {result ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Stat
                  label="rows scanned"
                  value={result.n_rows.toLocaleString()}
                  sub={`${result.n_hashed.toLocaleString()} chained`}
                />
                <Stat
                  label="head hash"
                  value={shortHash(result.head_hash)}
                  sub={result.head_hash ?? "no chained rows"}
                />
                <Stat
                  label="status"
                  value={
                    result.ok
                      ? "intact"
                      : `${result.breaks.length} break${result.breaks.length === 1 ? "" : "s"}`
                  }
                  sub={verifiedAt ? `verified ${verifiedAt}` : undefined}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {result.ok ? (
                  <Badge tone="success">
                    <CheckCircle size={11} weight="duotone" /> chain intact
                  </Badge>
                ) : (
                  <Badge tone="danger">
                    <ShieldWarning size={11} weight="duotone" /> tampering
                    detected
                  </Badge>
                )}
                <Badge tone="neutral">scope {result.tenant}</Badge>
              </div>

              {!result.ok && result.breaks.length > 0 ? (
                <Card>
                  <CardHeader
                    title="chain breaks"
                    hint="Earliest divergence first. Cross-reference row id against /v1/admin/audit/admin to see what was changed."
                  />
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-[var(--color-border)]/30 text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
                        <tr>
                          <th className="px-3 py-2">row id</th>
                          <th className="px-3 py-2">reason</th>
                          <th className="hidden px-3 py-2 sm:table-cell">
                            expected
                          </th>
                          <th className="hidden px-3 py-2 sm:table-cell">
                            actual
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--color-border)] font-mono">
                        {result.breaks.map((b, i) => (
                          <tr key={`${b.row_id}-${b.reason}-${i}`}>
                            <td className="px-3 py-2 tabular-nums">
                              {b.row_id}
                            </td>
                            <td className="px-3 py-2 text-[var(--color-warn)]">
                              <span className="inline-flex items-center gap-1">
                                <WarningOctagon
                                  size={12}
                                  weight="duotone"
                                />
                                {reasonLabel(b.reason)}
                              </span>
                            </td>
                            <td className="hidden px-3 py-2 text-[var(--color-muted)] sm:table-cell">
                              {shortHash(b.expected)}
                            </td>
                            <td className="hidden px-3 py-2 text-[var(--color-muted)] sm:table-cell">
                              {shortHash(b.actual)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              ) : null}

              <p className="text-[11px] leading-relaxed text-[var(--color-muted)]">
                Each verification is itself recorded as an audit event
                (action{" "}
                <code className="text-[var(--color-fg)]">
                  audit.chain.verify
                </code>
                ), so an auditor can prove a check was run, by whom, and what
                it found.
              </p>
            </div>
          ) : null}
        </div>
      </Card>
    </main>
  );
}
