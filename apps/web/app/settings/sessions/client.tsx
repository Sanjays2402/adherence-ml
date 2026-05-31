"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  Monitor,
  DeviceMobile,
  Globe,
  SignOut,
  Trash,
  ArrowClockwise,
  ShieldWarning,
} from "@phosphor-icons/react";
import {
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorBox,
  Skeleton,
  Badge,
} from "@/components/ui/primitives";

type SessionRow = {
  sid: string;
  label: string;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  current: boolean;
};

type ListResp = {
  current_sid: string | null;
  sessions: SessionRow[];
};

const fetcher = (url: string) =>
  fetch(url).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

function fmtRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return "in the future";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function fmtAbs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function deviceIconFor(ua: string | null) {
  if (!ua) return Globe;
  const s = ua.toLowerCase();
  if (/(iphone|android|mobile)/.test(s)) return DeviceMobile;
  return Monitor;
}

function shortUa(ua: string | null): string {
  if (!ua) return "unknown client";
  const s = ua;
  // Pull out a friendly bit: browser + os if obvious.
  const browserMatch = s.match(/(Firefox|Edg|Chrome|Safari)\/([\d.]+)/);
  const osMatch = s.match(/\(([^)]+)\)/);
  const browser = browserMatch ? `${browserMatch[1]} ${browserMatch[2]!.split(".")[0]}` : "browser";
  const os = osMatch ? osMatch[1]!.split(";")[0]!.trim() : "";
  return os ? `${browser} on ${os}` : browser;
}

export default function SessionsClient() {
  const { data, error, isLoading, mutate } = useSWR<ListResp>(
    "/api/auth/sessions/list",
    fetcher,
    { revalidateOnFocus: true, refreshInterval: 30_000 },
  );

  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeErr, setRevokeErr] = useState<string | null>(null);
  const [revokeAllBusy, setRevokeAllBusy] = useState(false);

  const sessions = useMemo(() => data?.sessions ?? [], [data]);
  const otherCount = sessions.filter((s) => !s.current).length;

  const revoke = useCallback(
    async (sid: string) => {
      setRevokeErr(null);
      setRevoking(sid);
      try {
        const r = await fetch(`/api/auth/sessions/revoke/${encodeURIComponent(sid)}`, {
          method: "DELETE",
        });
        if (!r.ok) {
          const d = (await r.json().catch(() => ({}))) as { detail?: string };
          setRevokeErr(d.detail ?? `HTTP ${r.status}`);
        } else {
          await mutate();
        }
      } catch {
        setRevokeErr("Network error.");
      } finally {
        setRevoking(null);
      }
    },
    [mutate],
  );

  const revokeAllOthers = useCallback(async () => {
    if (otherCount === 0) return;
    setRevokeErr(null);
    setRevokeAllBusy(true);
    try {
      const r = await fetch("/api/auth/sessions/revoke-all", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keep_current: true }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { detail?: string };
        setRevokeErr(d.detail ?? `HTTP ${r.status}`);
      } else {
        await mutate();
      }
    } catch {
      setRevokeErr("Network error.");
    } finally {
      setRevokeAllBusy(false);
    }
  }, [mutate, otherCount]);

  return (
    <main className="min-h-dvh bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-10 space-y-6">
        <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
          <Link
            href="/settings"
            className="inline-flex items-center gap-1 hover:text-[var(--color-text)] transition-colors"
          >
            <ArrowLeft size={12} />
            settings
          </Link>
          <span aria-hidden>/</span>
          <span>active sessions</span>
        </div>

        <header className="space-y-1">
          <h1 className="text-[20px] tracking-tight">active sessions</h1>
          <p className="text-[13px] text-[var(--color-muted)]">
            Every browser currently signed into this account. Revoke any one
            you do not recognize. The session you are reading this from is
            marked current and cannot be revoked here; sign out instead.
          </p>
        </header>

        {revokeErr ? <ErrorBox message={revokeErr} /> : null}
        {error ? <ErrorBox message="Could not load sessions." /> : null}

        <Card>
          <CardHeader
            title="sessions"
            hint={
              data
                ? `${sessions.length} active`
                : "loading"
            }
            right={
              <button
                type="button"
                onClick={() => mutate()}
                className="inline-flex items-center gap-1 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)] transition"
                aria-label="Refresh sessions list"
              >
                <ArrowClockwise size={12} />
                refresh
              </button>
            }
          />
          {isLoading ? (
            <div className="p-4 space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="p-6">
              <Empty
                title="no active sessions"
                hint="If you can read this, something is off. Refresh the page."
              />
            </div>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {sessions.map((s) => {
                const Icon = deviceIconFor(s.user_agent);
                const isCurrent = s.current;
                const busy = revoking === s.sid;
                return (
                  <li
                    key={s.sid}
                    className="flex items-start sm:items-center gap-3 px-4 py-3 flex-col sm:flex-row"
                  >
                    <div className="flex items-start gap-3 min-w-0 flex-1 w-full">
                      <Icon
                        weight="duotone"
                        size={22}
                        className="text-[var(--color-accent)] mt-0.5 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="text-[13px] truncate">
                            {shortUa(s.user_agent)}
                          </div>
                          {isCurrent ? (
                            <Badge>this device</Badge>
                          ) : null}
                          <Badge>{s.label}</Badge>
                        </div>
                        <div className="text-[11px] text-[var(--color-muted)] mt-0.5 truncate">
                          {s.ip ?? "ip unknown"} {" \u00b7 "}
                          active {fmtRelative(s.last_seen_at)} {" \u00b7 "}
                          signed in {fmtRelative(s.created_at)} {" \u00b7 "}
                          expires {fmtAbs(s.expires_at)}
                        </div>
                      </div>
                    </div>
                    <div className="shrink-0 self-end sm:self-auto">
                      {isCurrent ? (
                        <a
                          href="/api/auth/logout"
                          className="inline-flex items-center gap-1 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)] transition"
                        >
                          <SignOut size={12} />
                          sign out
                        </a>
                      ) : (
                        <Button
                          variant="ghost"
                          onClick={() => revoke(s.sid)}
                          disabled={busy}
                          aria-label={`Revoke session ${s.sid}`}
                        >
                          <Trash size={12} />
                          {busy ? "revoking" : "revoke"}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="sign out everywhere"
            hint="Revoke every other session and keep this one."
            right={
              <ShieldWarning
                weight="duotone"
                size={16}
                className="text-[var(--color-accent)]"
              />
            }
          />
          <div className="p-4 flex items-center justify-between gap-3 flex-wrap">
            <p className="text-[12px] text-[var(--color-muted)] max-w-md">
              Use this if you lost a device or suspect a cookie was stolen.
              This bumps your session generation so even legacy cookies that
              predate per-session tracking stop verifying immediately.
            </p>
            <Button
              variant="primary"
              onClick={revokeAllOthers}
              disabled={revokeAllBusy || otherCount === 0}
            >
              <SignOut size={12} />
              {revokeAllBusy
                ? "revoking"
                : otherCount === 0
                  ? "nothing to revoke"
                  : `revoke ${otherCount} other session${otherCount === 1 ? "" : "s"}`}
            </Button>
          </div>
        </Card>
      </div>
    </main>
  );
}
