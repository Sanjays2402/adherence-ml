"use client";

/**
 * Saved searches bar for /history. Persists the current filter set as a
 * named "view" so power users can flip between views with one click.
 * Backed by /api/saved-searches (file-backed JSONL, per-user scoped).
 */
import { useCallback, useEffect, useState } from "react";
import {
  BookmarkSimple,
  FloppyDisk,
  Trash,
  X,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

export type SavedSearchKind =
  | "all"
  | "predict"
  | "demo"
  | "explain"
  | "cohort"
  | "forecast"
  | "other";

export interface SavedSearchFilters {
  q: string;
  kind: SavedSearchKind;
  from: string;
  to: string;
  tags: string[];
  pinned_only: boolean;
}

export interface SavedSearchRecord {
  id: string;
  user_id: string;
  name: string;
  created_at: number;
  updated_at: number;
  filters: SavedSearchFilters;
}

interface Props {
  current: SavedSearchFilters;
  /** active filter chip count, so we can disable Save when nothing is set */
  filterCount: number;
  onApply: (f: SavedSearchFilters) => void;
  onToast: (msg: string) => void;
}

export default function SavedSearchesBar({
  current,
  filterCount,
  onApply,
  onToast,
}: Props) {
  const [items, setItems] = useState<SavedSearchRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/saved-searches", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = (await r.json()) as { items: SavedSearchRecord[] };
      setItems(data.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load saved views");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback(
    (s: SavedSearchRecord) => {
      setActiveId(s.id);
      onApply(s.filters);
      onToast(`Applied view: ${s.name}`);
    },
    [onApply, onToast],
  );

  const save = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const r = await fetch("/api/saved-searches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed, filters: current }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const rec = (await r.json()) as SavedSearchRecord;
      setItems((prev) => [rec, ...prev]);
      setActiveId(rec.id);
      setShowForm(false);
      setName("");
      onToast(`Saved view: ${rec.name}`);
    } catch (e) {
      onToast(
        "Could not save view: " +
          (e instanceof Error ? e.message : "unknown error"),
      );
    } finally {
      setSaving(false);
    }
  }, [name, current, onToast]);

  const remove = useCallback(
    async (s: SavedSearchRecord) => {
      const ok = window.confirm(`Delete saved view "${s.name}"?`);
      if (!ok) return;
      try {
        const r = await fetch(`/api/saved-searches/${s.id}`, {
          method: "DELETE",
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        setItems((prev) => prev.filter((x) => x.id !== s.id));
        if (activeId === s.id) setActiveId(null);
        onToast(`Deleted view: ${s.name}`);
      } catch (e) {
        onToast(
          "Could not delete view: " +
            (e instanceof Error ? e.message : "unknown error"),
        );
      }
    },
    [activeId, onToast],
  );

  if (loading) {
    return (
      <div className="px-6 py-2 border-b border-[var(--color-border)] flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
        <BookmarkSimple weight="duotone" size={12} />
        loading saved views…
      </div>
    );
  }

  return (
    <div className="px-6 py-2 border-b border-[var(--color-border)] flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
        <BookmarkSimple weight="duotone" size={12} />
        saved views
      </span>
      {error && (
        <span className="text-[11px] text-red-400 font-mono">{error}</span>
      )}
      {items.length === 0 && !error && (
        <span className="text-[11px] text-[var(--color-muted)] italic">
          none yet. Set filters then click Save view.
        </span>
      )}
      {items.map((s) => (
        <div
          key={s.id}
          className={cn(
            "group inline-flex items-center rounded-md border text-[11px] font-mono",
            activeId === s.id
              ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-fg)]"
              : "border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)]",
          )}
        >
          <button
            type="button"
            onClick={() => apply(s)}
            className="px-2 py-1"
            title={describeFilters(s.filters)}
          >
            {s.name}
          </button>
          <button
            type="button"
            onClick={() => remove(s)}
            aria-label={`Delete view ${s.name}`}
            className="border-l border-[var(--color-border)] px-1.5 py-1 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-red-400"
          >
            <Trash weight="duotone" size={12} />
          </button>
        </div>
      ))}
      <div className="ml-auto flex items-center gap-2">
        {showForm ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="flex items-center gap-1"
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="View name"
              maxLength={80}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[12px] outline-none focus:border-[var(--color-accent)]"
            />
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px] font-mono uppercase tracking-wider hover:bg-[var(--color-border)]/30 disabled:opacity-40"
            >
              <FloppyDisk weight="duotone" size={12} />
              {saving ? "saving…" : "save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setName("");
              }}
              aria-label="Cancel"
              className="rounded-md border border-[var(--color-border)] px-1.5 py-1 text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            >
              <X weight="duotone" size={12} />
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            disabled={filterCount === 0}
            title={
              filterCount === 0
                ? "Set at least one filter to save a view"
                : "Save current filters as a view"
            }
            className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px] font-mono uppercase tracking-wider hover:bg-[var(--color-border)]/30 disabled:opacity-40"
          >
            <FloppyDisk weight="duotone" size={12} />
            save view
          </button>
        )}
      </div>
    </div>
  );
}

function describeFilters(f: SavedSearchFilters): string {
  const parts: string[] = [];
  if (f.q) parts.push(`q="${f.q}"`);
  if (f.kind !== "all") parts.push(`kind=${f.kind}`);
  if (f.from) parts.push(`from=${f.from}`);
  if (f.to) parts.push(`to=${f.to}`);
  if (f.pinned_only) parts.push("pinned");
  if (f.tags.length) parts.push(`tags=${f.tags.join(",")}`);
  return parts.length ? parts.join("  ") : "no filters";
}
