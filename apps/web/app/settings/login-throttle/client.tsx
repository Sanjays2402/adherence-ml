"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  Lock,
  LockOpen,
  ShieldCheck,
  At,
  Globe,
  Trash,
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorBox,
  Skeleton,
} from "@/components/ui/primitives";

type Bucket = {
  scope: "magic_request" | "totp_verify";
  key: string;
  key_kind: "email" | "ip";
  fails: number;
  first_fail_at: number;
  last_fail_at: number;
  locked_until: number | null;
};

type ListResp = {
  now: number;
  only_locked: boolean;
  count: number;
  buckets: Bucket[];
};

const fetcher = async (url: string): Promise<ListResp> => {
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body?.detail || body?.error || `request failed (${r.status})`);
  }
  return r.json();
};

function fmtAgo(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function fmtIn(ms: number, now: number): string {
  const d = Math.max(0, ms - now);
  if (d <= 0) return "expired";
  if (d < 60_000) return `${Math.ceil(d / 1000)}s`;
  return `${Math.ceil(d / 60_000)}m`;
}

function scopeLabel(s: Bucket["scope"]): string {
  return s === "magic_request" ? "magic link" : "TOTP code";
}

export default function LoginThrottleClient() {
  const [onlyLocked, setOnlyLocked] = useState(true);
  const url = `/api/auth/lockouts${onlyLocked ? "?only_locked=1" : ""}`;
  const { data, error, isLoading, mutate } = useSWR<ListResp>(url, fetcher);
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const onClear = useCallback(
    async (b: Bucket) => {
      const id = `${b.scope}::${b.key}`;
      setBusy(id);
      setFormError(null);
      try {
        const r = await fetch("/api/auth/lockouts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: b.scope, key: b.key }),
        });
        if (!r.ok && r.status !== 404) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.detail || body?.error || `request failed (${r.status})`);
        }
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed to clear");
      } finally {
        setBusy(null);
      }
    },
    [mutate],
  );

  const buckets = data?.buckets ?? [];
  const now = data?.now ?? Date.now();
  const lockedCount = buckets.filter((b) => b.locked_until && b.locked_until > now).length;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="mb-6">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          <ArrowLeft size={14} weight="duotone" aria-hidden />
          back to settings
        </Link>
      </div>

      <header className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
            Login throttle
          </h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Brute-force and mailbox-pump protection. 5 failed magic-link or TOTP
            attempts inside the rolling window lock the offending email or IP
            for 15 minutes. Successful 2FA clears the email bucket
            automatically.
          </p>
        </div>
        <div className="shrink-0">
          {isLoading ? (
            <Skeleton className="h-6 w-28" />
          ) : (
            <Badge tone={lockedCount > 0 ? "warn" : "success"}>
              {lockedCount > 0 ? (
                <Lock size={12} weight="duotone" aria-hidden />
              ) : (
                <ShieldCheck size={12} weight="duotone" aria-hidden />
              )}
              {lockedCount} locked
            </Badge>
          )}
        </div>
      </header>

      <Card className="mb-6">
        <CardHeader
          title="Filter"
          hint="Toggle to see every bucket with recent failures or just those currently locked out."
          right={
            <Button
              variant="ghost"
              onClick={() => setOnlyLocked((v) => !v)}
              aria-pressed={onlyLocked}
            >
              {onlyLocked ? (
                <>
                  <Lock size={14} weight="duotone" aria-hidden /> locked only
                </>
              ) : (
                <>
                  <LockOpen size={14} weight="duotone" aria-hidden /> all recent
                </>
              )}
            </Button>
          }
        />
      </Card>

      {formError ? (
        <div className="mb-4">
          <ErrorBox message={formError} />
        </div>
      ) : null}

      <Card>
        <CardHeader
          title={onlyLocked ? "Active lockouts" : "Recent throttle activity"}
          hint={
            buckets.length === 0
              ? "Nothing to show. The auth surface is quiet."
              : "Clear a bucket to forgive a specific email or IP. The action is recorded in the dashboard audit log."
          }
          right={<Lock size={16} weight="duotone" aria-hidden />}
        />
        <div className="border-t border-neutral-200 dark:border-neutral-800">
          {error ? (
            <div className="p-4">
              <ErrorBox
                message={error instanceof Error ? error.message : "failed to load"}
              />
            </div>
          ) : isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : buckets.length === 0 ? (
            <div className="p-4">
              <Empty
                title={onlyLocked ? "No active lockouts" : "No recent throttle activity"}
                hint="Failed sign-in attempts will appear here as they accumulate."
              />
            </div>
          ) : (
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {buckets.map((b) => {
                const id = `${b.scope}::${b.key}`;
                const isLocked = !!(b.locked_until && b.locked_until > now);
                return (
                  <li
                    key={id}
                    className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={isLocked ? "warn" : "neutral"}>
                          {isLocked ? "locked" : "tracking"}
                        </Badge>
                        <Badge tone="neutral">{scopeLabel(b.scope)}</Badge>
                        <Badge tone="neutral">
                          {b.key_kind === "email" ? (
                            <At size={12} weight="duotone" aria-hidden />
                          ) : (
                            <Globe size={12} weight="duotone" aria-hidden />
                          )}
                          {b.key_kind}
                        </Badge>
                      </div>
                      <div className="mt-1 truncate font-mono text-sm text-neutral-900 dark:text-neutral-50">
                        {b.key}
                      </div>
                      <div className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                        {b.fails} failure{b.fails === 1 ? "" : "s"} {"\u00b7 "}
                        last {fmtAgo(b.last_fail_at, now)}
                        {isLocked && b.locked_until
                          ? ` \u00b7 unlocks in ${fmtIn(b.locked_until, now)}`
                          : ""}
                      </div>
                    </div>
                    <div className="shrink-0">
                      <Button
                        variant="ghost"
                        onClick={() => onClear(b)}
                        disabled={busy === id}
                        aria-label={`Clear ${scopeLabel(b.scope)} bucket for ${b.key}`}
                      >
                        <Trash size={14} weight="duotone" aria-hidden />
                        {busy === id ? "clearing" : "clear"}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>

      <p className="mt-6 text-xs text-neutral-500 dark:text-neutral-400">
        Locked requests return HTTP 429 with{" "}
        <span className="font-mono">Retry-After</span> and{" "}
        <span className="font-mono">{"{ \"error\": { \"code\": \"locked_out\" } }"}</span>.
        The throttle protects{" "}
        <span className="font-mono">/api/auth/request</span> and{" "}
        <span className="font-mono">/api/auth/2fa/verify</span> from credential
        stuffing and email-bombing without affecting SSO sign-in.
      </p>
    </div>
  );
}
