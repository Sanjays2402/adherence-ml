"use client";

import { useState, useCallback, useMemo } from "react";
import useSWR from "swr";
import {
  ChatCircleText,
  Trash,
  CircleNotch,
  PaperPlaneTilt,
  User as UserIcon,
} from "@phosphor-icons/react";

interface NoteRecord {
  id: string;
  run_id: string;
  created_at: number;
  user_id: string | null;
  author_email: string | null;
  body: string;
}

interface ListResp {
  items: NoteRecord[];
  total: number;
}

const fetcher = async (u: string): Promise<ListResp> => {
  const r = await fetch(u, { cache: "no-store" });
  if (!r.ok) throw new Error(`http_${r.status}`);
  return r.json();
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

interface Props {
  runId: string;
  currentUserId: string | null;
}

export default function RunNotes({ runId, currentUserId }: Props) {
  const key = `/api/runs/${runId}/notes`;
  const { data, error, isLoading, mutate } = useSWR<ListResp>(key, fetcher, {
    refreshInterval: 0,
  });
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const items = data?.items ?? [];
  const remaining = useMemo(() => 2000 - draft.length, [draft]);

  const submit = useCallback(async () => {
    const body = draft.trim();
    if (!body) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await fetch(key, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.detail || j.error || `http_${r.status}`);
      }
      setDraft("");
      await mutate();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "save failed";
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  }, [draft, key, mutate]);

  const remove = useCallback(
    async (noteId: string) => {
      setDeletingId(noteId);
      try {
        const r = await fetch(`/api/runs/${runId}/notes/${noteId}`, {
          method: "DELETE",
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.detail || j.error || `http_${r.status}`);
        }
        await mutate();
      } catch {
        // surface inline next time; keep UX silent if delete races
      } finally {
        setDeletingId(null);
      }
    },
    [runId, mutate],
  );

  return (
    <div className="flex flex-col">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between gap-2">
        <div className="inline-flex items-center gap-1.5 text-[12px] uppercase tracking-wider text-[var(--color-muted)]">
          <ChatCircleText weight="duotone" size={14} /> Notes
        </div>
        <div className="text-[11px] font-mono text-[var(--color-muted)]">
          {data ? `${data.total} total` : isLoading ? "loading" : ""}
        </div>
      </div>

      <div className="p-4 flex flex-col gap-3">
        {error && (
          <div
            role="alert"
            className="text-[12px] rounded-md border border-red-500/40 bg-red-500/10 text-red-300 px-3 py-2"
          >
            Could not load notes. Try refreshing.
          </div>
        )}

        {isLoading && !data && (
          <div className="space-y-2" aria-busy="true" aria-live="polite">
            <div className="h-14 rounded-md bg-[var(--color-border)]/30 animate-pulse" />
            <div className="h-14 rounded-md bg-[var(--color-border)]/30 animate-pulse" />
          </div>
        )}

        {data && items.length === 0 && (
          <div className="rounded-md border border-dashed border-[var(--color-border)] px-4 py-6 text-center">
            <div className="text-[12px] text-[var(--color-muted)]">
              No notes yet. Add context, follow-up actions, or links to a chart
              review so this run is useful weeks from now.
            </div>
          </div>
        )}

        <ul className="flex flex-col gap-2">
          {items.map((n) => {
            const mine = (n.user_id ?? null) === (currentUserId ?? null);
            return (
              <li
                key={n.id}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
                    <UserIcon weight="duotone" size={12} />
                    <span className="font-mono">
                      {n.author_email ?? "anonymous"}
                    </span>
                    <span>·</span>
                    <span title={new Date(n.created_at).toLocaleString()}>
                      {timeAgo(n.created_at)}
                    </span>
                  </div>
                  {mine && (
                    <button
                      type="button"
                      onClick={() => remove(n.id)}
                      disabled={deletingId === n.id}
                      aria-label="Delete note"
                      className="inline-flex items-center justify-center rounded-sm text-[var(--color-muted)] hover:text-red-400 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] disabled:opacity-50"
                    >
                      {deletingId === n.id ? (
                        <CircleNotch
                          weight="duotone"
                          size={14}
                          className="animate-spin"
                        />
                      ) : (
                        <Trash weight="duotone" size={14} />
                      )}
                    </button>
                  )}
                </div>
                <div className="mt-1 text-[13px] whitespace-pre-wrap break-words">
                  {n.body}
                </div>
              </li>
            );
          })}
        </ul>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex flex-col gap-2 pt-2 border-t border-[var(--color-border)]"
        >
          <label htmlFor="note-body" className="sr-only">
            Add a note
          </label>
          <textarea
            id="note-body"
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, 2000))}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="Add context, a follow-up action, or a chart link. Cmd+Enter to save."
            rows={3}
            className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
          />
          <div className="flex items-center justify-between text-[11px] text-[var(--color-muted)]">
            <div>
              {submitError ? (
                <span className="text-red-400">{submitError}</span>
              ) : (
                <span className="font-mono">
                  {remaining} chars left
                </span>
              )}
            </div>
            <button
              type="submit"
              disabled={submitting || draft.trim().length === 0}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-accent)]/15 text-[var(--color-accent)] px-3 py-1.5 text-[12px] hover:bg-[var(--color-accent)]/25 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
            >
              {submitting ? (
                <CircleNotch
                  weight="duotone"
                  size={12}
                  className="animate-spin"
                />
              ) : (
                <PaperPlaneTilt weight="duotone" size={12} />
              )}
              Save note
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
