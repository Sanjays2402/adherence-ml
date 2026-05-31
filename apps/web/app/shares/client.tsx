"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  Share as ShareIcon,
  Copy,
  Check,
  Trash,
  ArrowSquareOut,
  MagnifyingGlass,
  ArrowClockwise,
  CaretLeft,
  CaretRight,
  Warning,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Button,
  Input,
  Empty,
  ErrorBox,
  Skeleton,
  Badge,
  MonoChip,
  Stat,
} from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

type ShareSummary = {
  id: string;
  created_at: number;
  user_id: string;
  title?: string;
  row_count: number;
  prediction_count: number;
  top_risk: number;
  model_version: string;
};

type ListResp = {
  items: ShareSummary[];
  total: number;
  limit: number;
  offset: number;
};

const PAGE = 25;
const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body?.detail || body?.error || `request failed (${res.status})`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return res.json();
};

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleString();
}

function riskTone(p: number): "success" | "warn" | "danger" {
  if (p >= 0.6) return "danger";
  if (p >= 0.3) return "warn";
  return "success";
}

export default function SharesClient() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const url = useMemo(() => {
    const sp = new URLSearchParams();
    if (q.trim()) sp.set("q", q.trim());
    sp.set("limit", String(PAGE));
    sp.set("offset", String(page * PAGE));
    return `/api/shares?${sp.toString()}`;
  }, [q, page]);

  const { data, error, isLoading, mutate } = useSWR<ListResp>(url, fetcher, {
    revalidateOnFocus: false,
    keepPreviousData: true,
  });

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(null), 1800);
  }, []);

  const copy = useCallback(
    async (id: string) => {
      const full = `${window.location.origin}/r/${id}`;
      try {
        await navigator.clipboard.writeText(full);
        setCopiedId(id);
        window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
        flash("Link copied");
      } catch {
        flash("Clipboard blocked");
      }
    },
    [flash],
  );

  const revoke = useCallback(
    async (id: string) => {
      setPendingDelete(id);
      try {
        const res = await fetch(`/api/shares/${id}`, { method: "DELETE" });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.detail || body?.error || `revoke failed (${res.status})`);
        }
        flash("Share revoked");
        setConfirming(null);
        await mutate();
      } catch (err) {
        flash((err as Error).message);
      } finally {
        setPendingDelete(null);
      }
    },
    [flash, mutate],
  );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE));
  const showSkeleton = isLoading && !data;
  const isUnauthenticated =
    (error as (Error & { status?: number }) | undefined)?.status === 401;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        eyebrow="Account"
        title="Share links"
        description="Public links you created from your runs. Anyone with the link can view. Revoke to take it offline."
        actions={
          <Button variant="ghost" onClick={() => mutate()} aria-label="Refresh">
            <ArrowClockwise size={14} weight="duotone" />
            Refresh
          </Button>
        }
      />

      <div className="p-4 md:p-6 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Total links" value={isLoading && !data ? "..." : total} />
          <Stat
            label="On this page"
            value={isLoading && !data ? "..." : items.length}
          />
          <Stat
            label="High risk shared"
            value={
              isLoading && !data
                ? "..."
                : items.filter((i) => i.top_risk >= 0.6).length
            }
          />
          <Stat
            label="Page"
            value={`${page + 1} / ${pageCount}`}
          />
        </div>

        <Card>
          <CardHeader
            title="Your share links"
            hint="Search by id, title, or owner."
            right={
              <div className="relative w-full sm:w-72">
                <MagnifyingGlass
                  size={14}
                  weight="duotone"
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-muted)]"
                />
                <Input
                  value={q}
                  onChange={(e) => {
                    setPage(0);
                    setQ(e.target.value);
                  }}
                  placeholder="search..."
                  className="pl-7"
                  aria-label="Search share links"
                />
              </div>
            }
          />

          {showSkeleton ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : isUnauthenticated ? (
            <div className="p-6">
              <ErrorBox message="Sign in to view share links scoped to your account." />
              <div className="mt-3">
                <Link
                  href="/settings"
                  className="text-[13px] text-[var(--color-accent)] hover:underline"
                >
                  Go to settings to sign in
                </Link>
              </div>
            </div>
          ) : error ? (
            <div className="p-6">
              <ErrorBox message={(error as Error).message} />
            </div>
          ) : items.length === 0 ? (
            <Empty
              icon={<ShareIcon size={32} weight="duotone" />}
              title={q ? "No links match that search" : "No share links yet"}
              hint={
                q
                  ? "Try a different search term, or clear the box to see everything."
                  : "Create a prediction on /predict or /demo, then click Share to publish a read-only link."
              }
            />
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {items.map((s) => {
                const isConfirming = confirming === s.id;
                const isDeleting = pendingDelete === s.id;
                return (
                  <li
                    key={s.id}
                    className={cn(
                      "px-3 sm:px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3",
                      isDeleting && "opacity-50",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link
                          href={`/r/${s.id}`}
                          className="text-[13px] font-medium hover:underline truncate max-w-[28ch]"
                          target="_blank"
                          rel="noreferrer"
                        >
                          {s.title || `Share ${s.id}`}
                        </Link>
                        <MonoChip>{s.id}</MonoChip>
                        <Badge tone={riskTone(s.top_risk)}>
                          top {Math.round(s.top_risk * 100)}%
                        </Badge>
                      </div>
                      <div className="mt-1 text-[11px] text-[var(--color-muted)] font-mono tabular-nums flex flex-wrap gap-x-3 gap-y-0.5">
                        <span>{fmtTime(s.created_at)}</span>
                        <span>{s.prediction_count} predictions</span>
                        <span>{s.row_count} rows</span>
                        <span>{s.model_version}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 self-end sm:self-auto shrink-0">
                      <Button
                        variant="ghost"
                        onClick={() => copy(s.id)}
                        aria-label={`Copy link for ${s.id}`}
                      >
                        {copiedId === s.id ? (
                          <Check size={14} weight="duotone" />
                        ) : (
                          <Copy size={14} weight="duotone" />
                        )}
                        Copy
                      </Button>
                      <Link
                        href={`/r/${s.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex"
                      >
                        <Button variant="ghost" aria-label={`Open ${s.id}`}>
                          <ArrowSquareOut size={14} weight="duotone" />
                          Open
                        </Button>
                      </Link>
                      {isConfirming ? (
                        <>
                          <Button
                            variant="danger"
                            onClick={() => revoke(s.id)}
                            disabled={isDeleting}
                          >
                            <Warning size={14} weight="duotone" />
                            Confirm revoke
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => setConfirming(null)}
                            disabled={isDeleting}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          onClick={() => setConfirming(s.id)}
                          aria-label={`Revoke ${s.id}`}
                          disabled={isDeleting}
                        >
                          <Trash size={14} weight="duotone" />
                          Revoke
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {total > PAGE ? (
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-[var(--color-border)] text-[12px] font-mono text-[var(--color-muted)]">
              <span>
                Showing {page * PAGE + 1} to {Math.min(total, (page + 1) * PAGE)} of{" "}
                {total}
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  aria-label="Previous page"
                >
                  <CaretLeft size={14} weight="duotone" />
                  Prev
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={page >= pageCount - 1}
                  aria-label="Next page"
                >
                  Next
                  <CaretRight size={14} weight="duotone" />
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      </div>

      {toast ? (
        <div
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-1.5 text-[12px] font-mono shadow-lg"
          role="status"
          aria-live="polite"
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}
