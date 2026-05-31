"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  Bell,
  BellSlash,
  Lightning,
  UploadSimple,
  Plugs,
  CheckCircle,
  Warning,
  Sparkle,
  ArrowsClockwise,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

interface NotificationView {
  id: string;
  created_at: number;
  user_id: string | null;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  read_for_user: boolean;
}

interface ApiResp {
  items: NotificationView[];
  unread: number;
  authenticated: boolean;
}

const ICONS: Record<string, React.ComponentType<{ weight?: "duotone"; size?: number; className?: string }>> = {
  "run.completed": Lightning,
  "batch.completed": UploadSimple,
  "webhook.failed": Warning,
  "webhook.delivered": CheckCircle,
  system: Sparkle,
};

function relTime(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function NotificationsClient() {
  const [data, setData] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (which: "all" | "unread") => {
    setLoading(true);
    setError(null);
    try {
      const url = which === "unread" ? "/api/notifications?unread=1" : "/api/notifications";
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error(`load_failed:${r.status}`);
      setData((await r.json()) as ApiResp);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown_error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  async function markOne(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/notifications/${id}/read`, { method: "POST" });
      await load(filter);
    } finally {
      setBusy(false);
    }
  }

  async function markAll() {
    setBusy(true);
    try {
      await fetch("/api/notifications/read-all", { method: "POST" });
      await load(filter);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-8 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Bell weight="duotone" size={22} className="text-[var(--color-accent)]" />
            <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
            {data && data.unread > 0 ? (
              <span className="rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)] text-[11px] font-mono px-2 py-0.5">
                {data.unread} unread
              </span>
            ) : null}
          </div>
          <p className="text-sm text-[var(--color-muted)] mt-1">
            Activity on your account: completed runs, batch jobs, and webhook deliveries.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-[var(--color-border)] overflow-hidden text-xs">
            <button
              onClick={() => setFilter("all")}
              className={cn(
                "px-2.5 py-1.5 transition-colors",
                filter === "all"
                  ? "bg-[var(--color-accent-soft)] text-[var(--color-fg)]"
                  : "text-[var(--color-muted)] hover:text-[var(--color-fg)]",
              )}
            >
              All
            </button>
            <button
              onClick={() => setFilter("unread")}
              className={cn(
                "px-2.5 py-1.5 border-l border-[var(--color-border)] transition-colors",
                filter === "unread"
                  ? "bg-[var(--color-accent-soft)] text-[var(--color-fg)]"
                  : "text-[var(--color-muted)] hover:text-[var(--color-fg)]",
              )}
            >
              Unread
            </button>
          </div>
          <button
            onClick={() => void load(filter)}
            className="rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] transition-colors"
            aria-label="Refresh"
          >
            <ArrowsClockwise weight="duotone" size={14} />
          </button>
          <button
            onClick={markAll}
            disabled={busy || !data || data.unread === 0 || !data.authenticated}
            className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Mark all read
          </button>
        </div>
      </header>

      {data && !data.authenticated ? (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/40 px-4 py-3 text-sm text-[var(--color-muted)]">
          You are not signed in. You can still see broadcast announcements; sign in to
          receive notifications for your runs and webhooks.{" "}
          <Link href="/login" className="text-[var(--color-accent)] underline">
            Sign in
          </Link>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md border border-[var(--color-high)]/40 bg-[var(--color-high)]/10 px-4 py-3 text-sm text-[var(--color-high)]">
          Could not load notifications. {error}
        </div>
      ) : null}

      {loading ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/30 animate-pulse"
            />
          ))}
        </div>
      ) : data && data.items.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface)]/30 p-10 text-center">
          <BellSlash weight="duotone" size={28} className="mx-auto text-[var(--color-muted)]" />
          <p className="mt-3 text-sm text-[var(--color-fg)]">No notifications</p>
          <p className="text-xs text-[var(--color-muted)] mt-1">
            {filter === "unread"
              ? "You are all caught up."
              : "Activity on your runs, batches, and webhooks will show up here."}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/30 overflow-hidden">
          {data?.items.map((n) => {
            const Icon = ICONS[n.kind] ?? Sparkle;
            return (
              <li
                key={n.id}
                className={cn(
                  "flex gap-3 p-4 transition-colors",
                  !n.read_for_user && "bg-[var(--color-accent-soft)]/40",
                )}
              >
                <div className="pt-0.5">
                  <Icon
                    weight="duotone"
                    size={18}
                    className={cn(
                      n.kind === "webhook.failed"
                        ? "text-[var(--color-high)]"
                        : "text-[var(--color-accent)]",
                    )}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium truncate">{n.title}</span>
                    {!n.read_for_user ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" aria-label="unread" />
                    ) : null}
                    <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-subtle)] ml-auto">
                      {relTime(n.created_at)}
                    </span>
                  </div>
                  {n.body ? (
                    <p className="text-xs text-[var(--color-muted)] mt-0.5 break-words">{n.body}</p>
                  ) : null}
                  <div className="mt-2 flex items-center gap-3">
                    {n.href ? (
                      <Link
                        href={n.href}
                        className="text-xs text-[var(--color-accent)] hover:underline"
                      >
                        Open
                      </Link>
                    ) : null}
                    {!n.read_for_user ? (
                      <button
                        onClick={() => markOne(n.id)}
                        disabled={busy}
                        className="text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:opacity-40"
                      >
                        Mark read
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
