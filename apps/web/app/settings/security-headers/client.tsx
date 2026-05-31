"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  ShieldCheck,
  ShieldWarning,
  Copy,
  CheckCircle,
  ArrowClockwise,
} from "@phosphor-icons/react";
import {
  Button,
  Card,
  CardHeader,
  ErrorBox,
  Input,
  Skeleton,
  Badge,
} from "@/components/ui/primitives";

type Check = { id: string; label: string; ok: boolean };
type Resp = {
  path: string;
  nonce_sample: string;
  hsts_enabled: boolean;
  headers: Record<string, string>;
  checks: Check[];
};

const fetcher = (url: string) =>
  fetch(url).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as Resp;
  });

export default function SecurityHeadersClient() {
  const [path, setPath] = useState("/");
  const [copied, setCopied] = useState<string | null>(null);
  const { data, error, isLoading, mutate } = useSWR<Resp>(
    `/api/security-headers?path=${encodeURIComponent(path)}`,
    fetcher,
    { revalidateOnFocus: false },
  );

  const copy = useCallback(async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
    } catch {
      // clipboard blocked, ignore
    }
  }, []);

  const passing = data?.checks.filter((c) => c.ok).length ?? 0;
  const total = data?.checks.length ?? 0;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
      <Link
        href="/settings"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
      >
        <ArrowLeft size={14} weight="duotone" />
        back to settings
      </Link>

      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">security headers</h1>
        <p className="mt-2 text-sm text-zinc-500">
          Exact HTTP response headers the dashboard sets for every request. Paste
          these into your vendor security questionnaire or aim a scanner at the
          live URL.
        </p>
      </header>

      <Card>
        <CardHeader
          title="response inspector"
          hint="pick any path and see the headers we attach"
          right={
            passing === total && total > 0 ? (
              <ShieldCheck size={16} weight="duotone" className="text-emerald-500" />
            ) : (
              <ShieldWarning size={16} weight="duotone" className="text-amber-500" />
            )
          }
        />
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-zinc-500" htmlFor="sh-path">
              path
            </label>
            <Input
              id="sh-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            onClick={() => mutate()}
            disabled={isLoading}
            aria-label="refresh"
          >
            <ArrowClockwise size={14} weight="duotone" />
            refresh
          </Button>
        </div>
      </Card>

      {error ? (
        <div className="mt-4">
          <ErrorBox message={`could not load security headers: ${(error as Error).message}`} />
        </div>
      ) : null}

      {isLoading && !data ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-3/4" />
        </div>
      ) : null}

      {data ? (
        <>
          <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {data.checks.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-950"
              >
                {c.ok ? (
                  <CheckCircle size={16} weight="duotone" className="text-emerald-500" />
                ) : (
                  <ShieldWarning size={16} weight="duotone" className="text-amber-500" />
                )}
                <span className="truncate">{c.label}</span>
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <Badge>
              {passing} / {total} checks passing
            </Badge>
            <Badge>HSTS {data.hsts_enabled ? "on" : "off (dev)"}</Badge>
            <span className="font-mono">nonce sample: {data.nonce_sample}</span>
          </div>

          <Card className="mt-6">
            <CardHeader title="raw headers" hint={`as served for ${data.path}`} />
            <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {Object.entries(data.headers).map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-start sm:gap-4">
                  <div className="w-full shrink-0 font-mono text-xs text-zinc-700 sm:w-72 dark:text-zinc-300">
                    {k}
                  </div>
                  <div className="min-w-0 flex-1 break-all font-mono text-xs text-zinc-500">
                    {v}
                  </div>
                  <button
                    type="button"
                    onClick={() => copy(k, `${k}: ${v}`)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900"
                    aria-label={`copy ${k}`}
                  >
                    {copied === k ? (
                      <CheckCircle size={12} weight="duotone" />
                    ) : (
                      <Copy size={12} weight="duotone" />
                    )}
                    {copied === k ? "copied" : "copy"}
                  </button>
                </div>
              ))}
            </div>
          </Card>

          <p className="mt-4 text-xs text-zinc-500">
            Sources: OWASP Secure Headers Project, Mozilla Observatory, SOC2 CC6.
            Configure looser CSP connect-src via ADHERENCE_CSP_CONNECT_SRC.
            Disable HSTS in non-TLS environments with ADHERENCE_DISABLE_HSTS=1.
          </p>
        </>
      ) : null}
    </main>
  );
}
