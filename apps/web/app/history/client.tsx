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
  PushPin,
  Share,
  Trash,
  ClockCounterClockwise,
  Tag as TagIcon,
  X,
} from "@phosphor-icons/react";
import { PageHeader, Card } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import SavedSearchesBar, {
  type SavedSearchFilters,
} from "./saved-searches-bar";

type Run = {
  id: string;
  created_at: number;
  kind: "predict" | "demo" | "explain" | "cohort" | "forecast" | "other";
  title: string;
  summary: string;
  user_id: string | null;
  latency_ms: number | null;
  tags: string[];
  pinned?: boolean;
};

type ListResp = { items: Run[]; total: number; limit: number; offset: number };
type TagsResp = { tags: Array<{ tag: string; count: number }>; total: number };

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
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  // Bulk-select state: set of run ids currently checked across pages.
  // We deliberately preserve selection across page/filter changes so a user
  // can build a working set, then act on it from the toolbar.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    setPage(0);
  }, [q, kind, from, to, selectedTags, pinnedOnly]);

  const url = useMemo(() => {
    const sp = new URLSearchParams();
    if (q.trim()) sp.set("q", q.trim());
    if (kind !== "all") sp.set("kind", kind);
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);
    for (const t of selectedTags) sp.append("tag", t);
    if (pinnedOnly) sp.set("pinned", "1");
    sp.set("limit", String(PAGE));
    sp.set("offset", String(page * PAGE));
    return `/api/runs?${sp.toString()}`;
  }, [q, kind, from, to, selectedTags, pinnedOnly, page]);

  /** Build an /api/runs/export URL that honors the active filters. */
  const exportUrl = useCallback(
    (format: "csv" | "json" | "ndjson") => {
      const sp = new URLSearchParams();
      sp.set("format", format);
      if (q.trim()) sp.set("q", q.trim());
      if (kind !== "all") sp.set("kind", kind);
      if (from) sp.set("from", from);
      if (to) sp.set("to", to);
      for (const t of selectedTags) sp.append("tag", t);
      if (pinnedOnly) sp.set("pinned", "1");
      return `/api/runs/export?${sp.toString()}`;
    },
    [q, kind, from, to, selectedTags, pinnedOnly],
  );

  const filterCount =
    (q.trim() ? 1 : 0) +
    (kind !== "all" ? 1 : 0) +
    (from ? 1 : 0) +
    (to ? 1 : 0) +
    (pinnedOnly ? 1 : 0) +
    selectedTags.length;

  const { data, error, isLoading, mutate } = useSWR<ListResp>(url, fetcher, {
    keepPreviousData: true,
    refreshInterval: 15_000,
  });

  const tagsKey = useMemo(() => {
    const sp = new URLSearchParams();
    if (kind !== "all") sp.set("kind", kind);
    return `/api/runs/tags${sp.toString() ? "?" + sp.toString() : ""}`;
  }, [kind]);
  const { data: tagsData } = useSWR<TagsResp>(tagsKey, fetcher, {
    keepPreviousData: true,
    refreshInterval: 30_000,
  });
  const allTags = tagsData?.tags ?? [];

  const toggleTag = useCallback((t: string) => {
    setSelectedTags((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );
  }, []);

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

  async function onTogglePin(r: Run) {
    const next = !r.pinned;
    const res = await fetch(`/api/runs/${r.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: next }),
    });
    if (res.ok) {
      flash(next ? "pinned" : "unpinned");
      mutate();
    } else {
      flash(next ? "pin failed" : "unpin failed");
    }
  }

  const toggleOne = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  async function runBulk(action: "delete" | "pin" | "unpin") {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (action === "delete" && !confirm(`Delete ${ids.length} run${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) {
      return;
    }
    setBulkBusy(true);
    try {
      const res = await fetch("/api/runs/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ids }),
      });
      if (!res.ok) {
        flash(`bulk ${action} failed`);
        return;
      }
      const body = (await res.json()) as { affected: number };
      flash(`${action} ${body.affected} run${body.affected === 1 ? "" : "s"}`);
      clearSelection();
      mutate();
    } catch {
      flash(`bulk ${action} failed`);
    } finally {
      setBulkBusy(false);
    }
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
  const visibleIds = items.map((r) => r.id);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected =
    visibleIds.some((id) => selectedIds.has(id)) && !allVisibleSelected;
  const toggleAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  };
  const selectionCount = selectedIds.size;

  return (
    <div className="flex flex-col min-h-screen">
      <SavedSearchesBar
        current={{ q, kind, from, to, tags: selectedTags, pinned_only: pinnedOnly }}
        filterCount={filterCount}
        onApply={(f: SavedSearchFilters) => {
          setQ(f.q);
          setKind(f.kind);
          setFrom(f.from);
          setTo(f.to);
          setSelectedTags(f.tags);
          setPinnedOnly(f.pinned_only);
        }}
        onToast={(m) => setToast(m)}
      />
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
          <button
            type="button"
            onClick={() => setPinnedOnly((v) => !v)}
            aria-pressed={pinnedOnly}
            title={pinnedOnly ? "Show all runs" : "Show pinned runs only"}
            className={cn(
              "rounded-md border px-2 py-1 text-[11px] font-mono uppercase tracking-wider inline-flex items-center gap-1",
              pinnedOnly
                ? "border-amber-300/60 bg-amber-300/10 text-amber-200"
                : "border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)]",
            )}
          >
            <PushPin weight="duotone" size={12} />
            pinned
          </button>
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

      {allTags.length > 0 && (
        <div className="px-6 py-3 border-b border-[var(--color-border)] flex items-start gap-3">
          <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)] pt-1 shrink-0">
            <TagIcon weight="duotone" size={12} /> tags
          </div>
          <div className="flex flex-wrap gap-1 flex-1 min-w-0">
            {allTags.map(({ tag, count }) => {
              const active = selectedTags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleTag(tag)}
                  aria-pressed={active}
                  title={active ? `Remove #${tag} filter` : `Filter by #${tag}`}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[11px] font-mono inline-flex items-center gap-1",
                    active
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-fg)]"
                      : "border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)]",
                  )}
                >
                  <span>#{tag}</span>
                  <span className="opacity-60">{count}</span>
                </button>
              );
            })}
            {selectedTags.length > 0 && (
              <button
                type="button"
                onClick={() => setSelectedTags([])}
                className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)] hover:text-[var(--color-fg)]"
              >
                clear
              </button>
            )}
          </div>
        </div>
      )}

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
            <>
              <div className="px-4 py-2 border-b border-[var(--color-border)] flex items-center gap-3 text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
                <label className="inline-flex items-center gap-2 cursor-pointer select-none" title={allVisibleSelected ? "Clear selection on this page" : "Select all on this page"}>
                  <input
                    type="checkbox"
                    aria-label="Select all runs on this page"
                    className="h-3.5 w-3.5 accent-[var(--color-accent)] cursor-pointer"
                    checked={allVisibleSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someVisibleSelected;
                    }}
                    onChange={toggleAllVisible}
                  />
                  <span>{allVisibleSelected ? "selected" : "select page"}</span>
                </label>
                {selectionCount > 0 && (
                  <span className="text-[var(--color-fg)]">{selectionCount} selected</span>
                )}
              </div>
            <ul className="divide-y divide-[var(--color-border)]">
              {items.map((r) => (
                <li
                  key={r.id}
                  className="px-4 py-3 flex flex-col gap-2 md:flex-row md:items-center md:gap-4 hover:bg-[var(--color-border)]/10"
                >
                  <input
                    type="checkbox"
                    aria-label={`Select run ${r.title}`}
                    className="h-3.5 w-3.5 accent-[var(--color-accent)] cursor-pointer self-start md:self-center"
                    checked={selectedIds.has(r.id)}
                    onChange={() => toggleOne(r.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <Link
                    href={`/history/${r.id}`}
                    className="flex-1 min-w-0 flex items-start gap-3"
                  >
                    <KindBadge kind={r.kind} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium truncate flex items-center gap-1.5">
                        {r.pinned && (
                          <PushPin
                            weight="fill"
                            size={12}
                            className="text-amber-300 shrink-0"
                            aria-label="pinned"
                          />
                        )}
                        <span className="truncate">{r.title}</span>
                      </div>
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
                    <IconBtn
                      label={r.pinned ? "Unpin" : "Pin"}
                      onClick={() => onTogglePin(r)}
                      active={!!r.pinned}
                    >
                      <PushPin
                        weight={r.pinned ? "fill" : "duotone"}
                        size={14}
                      />
                    </IconBtn>
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
            </>
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

      {selectionCount > 0 && (
        <div
          role="region"
          aria-label="Bulk actions"
          className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur supports-[backdrop-filter]:bg-[var(--color-surface)]/80 px-4 py-3 shadow-[0_-4px_24px_-12px_rgba(0,0,0,0.6)]"
        >
          <div className="mx-auto flex max-w-5xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3 text-[12px]">
              <span className="inline-flex items-center rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-fg)]">
                {selectionCount} selected
              </span>
              <button
                type="button"
                onClick={clearSelection}
                className="inline-flex items-center gap-1 text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)] hover:text-[var(--color-fg)]"
              >
                <X weight="duotone" size={12} /> clear
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => runBulk("pin")}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-border)]/30 disabled:opacity-50"
              >
                <PushPin weight="duotone" size={14} /> Pin
              </button>
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => runBulk("unpin")}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-border)]/30 disabled:opacity-50"
              >
                <PushPin weight="regular" size={14} /> Unpin
              </button>
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => runBulk("delete")}
                className="inline-flex items-center gap-1.5 rounded-md border border-red-400/40 bg-red-500/10 px-2.5 py-1.5 text-[12px] text-red-200 hover:bg-red-500/20 disabled:opacity-50"
              >
                <Trash weight="duotone" size={14} /> Delete
              </button>
            </div>
          </div>
        </div>
      )}

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
  active,
  as,
  href,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  label: string;
  danger?: boolean;
  active?: boolean;
  as?: "a";
  href?: string;
}) {
  const cls = cn(
    "inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-border)]/30",
    danger && "hover:border-red-400/50 hover:text-red-300",
    active && "border-amber-300/60 bg-amber-300/10 text-amber-200",
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
