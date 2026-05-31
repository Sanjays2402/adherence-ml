"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  ArrowClockwise,
  Copy,
  DownloadSimple,
  MagnifyingGlass,
  PencilSimple,
  Share,
  Trash,
  ClockCounterClockwise,
  Tag as TagIcon,
} from "@phosphor-icons/react";
import { PageHeader, Card } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

type Run = {
  id: string;
  created_at: number;
  kind: "predict" | "demo" | "explain" | "cohort" | "forecast" | "other";
  title: string;
  summary: string;
  user_id: string | null;
  latency_ms: number | null;
  tags: string[];
};

type ListResp = { items: Run[]; total: number; limit: number; offset: number };

const KINDS = ["all", "predict", "demo", "explain", "cohort", "forecast", "other"] as const;
type KindFilter = (typeof KINDS)[number];

const PAGE = 25;

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleString();
}

function rerunHref(r: Run): string {
  if (r.kind === "predict" || r.kind === "demo") return "/predict";
  if (r.kind === "cohort") return "/cohort";
  if (r.kind === "forecast") return "/forecast";
  if (r.kind === "explain") return "/explain";
  return "/";
}

export default function HistoryClient() {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    setPage(0);
  }, [q, kind, from, to]);

  const url = useMemo(() => {
    const sp = new URLSearchParams();
    if (q.trim()) sp.set("q", q.trim());
    if (kind !== "all") sp.set("kind", kind);
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);
    sp.set("limit", String(PAGE));
    sp.set("offset", String(page * PAGE));
    return `/api/runs?${sp.toString()}`;
  }, [q, kind, from, to, page]);

  /** Build an /api/runs/export URL that honors the active filters. */
  const exportUrl = useCallback(
    (format: "csv" | "json" | "ndjson") => {
      const sp = new URLSearchParams();
      sp.set("format", format);
      if (q.trim()) sp.set("q", q.trim());
      if (kind !== "all") sp.set("kind", kind);
      if (from) sp.set("from", from);
      if (to) sp.set("to", to);
      return `/api/runs/export?${sp.toString()}`;
    },
    [q, kind, from, to],
  );

  const filterCount =
    (q.trim() ? 1 : 0) + (kind !== "all" ? 1 : 0) + (from ? 1 : 0) + (to ? 1 : 0);

  const { data, error, isLoading, mutate } = useSWR<ListResp>(url, fetcher, {
    keepPreviousData: true,
    refreshInterval: 15_000,
  });

  const flash = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2200);
  }, []);

  async function onDelete(id: string) {
    if (!confirm("Delete this run?")) return;
    const res = await fetch(`/api/runs/${id}`, { method: "DELETE" });
    if (res.ok) {
      flash("deleted");
      mutate();
    } else {
      flash("delete failed");
    }
  }

  async function onRename(r: Run) {
    const next = prompt("Rename run", r.title);
    if (next == null || next.trim() === "" || next === r.title) return;
    const res = await fetch(`/api/runs/${r.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: next.trim() }),
    });
    if (res.ok) {
      flash("renamed");
      mutate();
    } else flash("rename failed");
  }

  async function onTag(r: Run) {
    const next = prompt("Tags (comma separated)", r.tags.join(", "));
    if (next == null) return;
    const tags = next
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 12);
    const res = await fetch(`/api/runs/${r.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags }),
    });
    if (res.ok) {
      flash("tags saved");
      mutate();
    } else flash("save failed");
  }

  async function onCopyLink(id: string) {
    const url = `${window.location.origin}/history/${id}`;
    try {
      await navigator.clipboard.writeText(url);
      flash("link copied");
    } catch {
      flash(url);
    }
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="flex flex-col min-h-screen">
      <PageHeader
        eyebrow="history"
        title="Run history"
        description="Every prediction, cohort scan, and forecast is saved here. Search, rename, tag, share, replay, or export."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {filterCount > 0 && (
              <span
                className="hidden sm:inline-flex items-center rounded-md border border-[var(--color-border)] bg-[var(--color-accent-soft)] px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-[var(--color-muted)]"
                title="Exports below honor these filters"
              >
                {filterCount} filter{filterCount === 1 ? "" : "s"} active
              </span>
            )}
            <a
              href={exportUrl("csv")}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-border)]/30"
              title="Download filtered runs as CSV"
            >
              <DownloadSimple weight="duotone" size={14} /> CSV
            </a>
            <a
              href={exportUrl("json")}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-border)]/30"
              title="Download filtered runs as JSON"
            >
              <DownloadSimple weight="duotone" size={14} /> JSON
            </a>
            <a
              href={exportUrl("ndjson")}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-border)]/30"
              title="Download filtered runs as newline-delimited JSON"
            >
              <DownloadSimple weight="duotone" size={14} /> NDJSON
            </a>
          </div>
        }
      />

      <div className="px-6 py-4 flex flex-col gap-3 md:flex-row md:items-center md:gap-3 border-b border-[var(--color-border)]">
        <label className="relative flex-1 min-w-0">
          <MagnifyingGlass
            weight="duotone"
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-muted)]"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title, summary, user, tag"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] pl-7 pr-3 py-1.5 text-[13px] outline-none focus:border-[var(--color-accent)]"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
            from
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[12px] font-mono text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <label className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
            to
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[12px] font-mono text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          {(from || to) && (
            <button
              type="button"
              onClick={() => {
                setFrom("");
                setTo("");
              }}
              className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            >
              clear
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cn(
                "rounded-md border px-2 py-1 text-[11px] font-mono uppercase tracking-wider",
                kind === k
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-fg)]"
                  : "border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)]",
              )}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      <div className="p-6 flex-1">
        <Card>
          {isLoading && !data ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="h-12 rounded-md bg-[var(--color-border)]/30 animate-pulse"
                />
              ))}
            </div>
          ) : error ? (
            <div className="p-8 text-center text-sm text-[var(--color-muted)]">
              Could not load runs. Check the server log.
            </div>
          ) : items.length === 0 ? (
            <EmptyState />
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {items.map((r) => (
                <li
                  key={r.id}
                  className="px-4 py-3 flex flex-col gap-2 md:flex-row md:items-center md:gap-4 hover:bg-[var(--color-border)]/10"
                >
                  <Link
                    href={`/history/${r.id}`}
                    className="flex-1 min-w-0 flex items-start gap-3"
                  >
                    <KindBadge kind={r.kind} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium truncate">{r.title}</div>
                      <div className="text-[11px] text-[var(--color-muted)] truncate">
                        {r.summary || "no summary"}
                        {r.tags.length > 0 && (
                          <span className="ml-2 font-mono">
                            {r.tags.map((t) => `#${t}`).join(" ")}
                          </span>
                        )}
                      </div>
                    </div>
                  </Link>
                  <div className="text-[11px] font-mono text-[var(--color-subtle)] whitespace-nowrap">
                    {r.latency_ms != null ? `${r.latency_ms}ms` : ""}
                    <span className="mx-1.5">·</span>
                    {fmtTime(r.created_at)}
                  </div>
                  <div className="flex items-center gap-1">
                    <IconBtn label="Re-run" onClick={() => undefined} as="a" href={rerunHref(r)}>
                      <ArrowClockwise weight="duotone" size={14} />
                    </IconBtn>
                    <IconBtn label="Rename" onClick={() => onRename(r)}>
                      <PencilSimple weight="duotone" size={14} />
                    </IconBtn>
                    <IconBtn label="Tag" onClick={() => onTag(r)}>
                      <TagIcon weight="duotone" size={14} />
                    </IconBtn>
                    <IconBtn label="Copy link" onClick={() => onCopyLink(r.id)}>
                      <Share weight="duotone" size={14} />
                    </IconBtn>
                    <IconBtn label="Delete" onClick={() => onDelete(r.id)} danger>
                      <Trash weight="duotone" size={14} />
                    </IconBtn>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {total > PAGE && (
          <div className="mt-4 flex items-center justify-between text-[12px] text-[var(--color-muted)]">
            <div>
              {page * PAGE + 1}–{Math.min((page + 1) * PAGE, total)} of {total}
            </div>
            <div className="flex gap-2">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="rounded-md border border-[var(--color-border)] px-2.5 py-1 disabled:opacity-40"
              >
                Prev
              </button>
              <button
                disabled={page + 1 >= pages}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-md border border-[var(--color-border)] px-2.5 py-1 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-6 right-6 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12px] shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="p-10 flex flex-col items-center text-center gap-3">
      <ClockCounterClockwise
        weight="duotone"
        size={32}
        className="text-[var(--color-accent)]"
      />
      <div className="text-sm">No runs yet.</div>
      <div className="text-[12px] text-[var(--color-muted)] max-w-sm">
        Run a prediction, score a cohort, or forecast a user. The result lands here automatically so you can search, share, and replay it later.
      </div>
      <div className="flex gap-2 pt-1">
        <Link
          href="/predict"
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[12px] hover:bg-[var(--color-border)]/30"
        >
          Try predict
        </Link>
        <Link
          href="/demo"
          className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-3 py-1.5 text-[12px]"
        >
          Open demo
        </Link>
      </div>
    </div>
  );
}

function KindBadge({ kind }: { kind: Run["kind"] }) {
  const color: Record<Run["kind"], string> = {
    predict: "text-[var(--color-accent)] border-[var(--color-accent)]/40",
    demo: "text-[var(--color-low)] border-[var(--color-low)]/40",
    explain: "text-amber-300 border-amber-300/30",
    cohort: "text-sky-300 border-sky-300/30",
    forecast: "text-violet-300 border-violet-300/30",
    other: "text-[var(--color-muted)] border-[var(--color-border)]",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider",
        color[kind],
      )}
    >
      {kind}
    </span>
  );
}

function IconBtn({
  children,
  onClick,
  label,
  danger,
  as,
  href,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  label: string;
  danger?: boolean;
  as?: "a";
  href?: string;
}) {
  const cls = cn(
    "inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-border)]/30",
    danger && "hover:border-red-400/50 hover:text-red-300",
  );
  if (as === "a" && href) {
    return (
      <Link href={href} title={label} aria-label={label} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

// keep Copy import used to avoid tree-shaking warnings in some builds
void Copy;
