"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import {
  ArrowsClockwise,
  Broom,
  ClockCounterClockwise,
  Info,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Empty,
  Button,
  Select,
  Skeleton,
  ErrorBox,
  MonoChip,
  Badge,
} from "@/components/ui/primitives";

type Workspace = {
  id: string;
  name: string;
  role: "owner" | "editor" | "viewer";
};

type Item = {
  key: string;
  request_hash: string;
  status: number;
  created_at: number;
  expires_at: number;
  bytes: number;
};

type Resp = { ttl_hours: number; items: Item[] };

const fetcher = async (url: string) => {
  const r = await fetch(url, { cache: "no-store" });
  if (r.status === 401) throw new Error("Sign in to view the cache.");
  if (r.status === 403) throw new Error("Owner role required for this workspace.");
  if (r.status === 404) throw new Error("Workspace not found.");
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.detail ?? `request failed (${r.status})`);
  }
  return r.json();
};

function fmtTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleString();
}

function fmtUntil(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "expired";
  const hours = Math.floor(diff / 3_600_000);
  if (hours >= 1) return `${hours}h left`;
  const mins = Math.max(1, Math.floor(diff / 60_000));
  return `${mins}m left`;
}

function statusTone(status: number): "success" | "warn" | "danger" {
  if (status >= 200 && status < 300) return "success";
  if (status >= 400 && status < 500) return "warn";
  return "danger";
}

export default function IdempotencyClient() {
  const wsList = useSWR<{ items: Workspace[] }>("/api/workspaces", fetcher, {
    revalidateOnFocus: false,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (wsList.data?.items?.length && !selected) {
      const firstOwned = wsList.data.items.find((w) => w.role === "owner");
      setSelected((firstOwned ?? wsList.data.items[0]).id);
    }
  }, [wsList.data, selected]);

  const ws = useMemo(
    () => wsList.data?.items.find((w) => w.id === selected) ?? null,
    [wsList.data, selected],
  );
  const ownerOnly = ws?.role !== "owner";

  const cache = useSWR<Resp>(
    selected ? `/api/workspaces/${selected}/idempotency` : null,
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 0 },
  );

  const onClear = useCallback(async () => {
    if (!selected) return;
    if (!confirm("Clear every cached Idempotency-Key for this workspace?")) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/workspaces/${selected}/idempotency`, {
        method: "DELETE",
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.detail ?? `failed (${r.status})`);
      }
      const j = (await r.json()) as { removed: number };
      setToast(
        j.removed === 0
          ? "Cache already empty."
          : `Removed ${j.removed} cached ${j.removed === 1 ? "key" : "keys"}.`,
      );
      cache.mutate();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Clear failed.");
    } finally {
      setBusy(false);
    }
  }, [selected, cache]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        eyebrow="workspace"
        title="Idempotency-Key cache"
        description="Inspect and purge the per-workspace cache that protects mutating API calls from duplicate writes on client retries. Cache TTL is 24 hours."
      />

      <div className="mt-6 grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card>
          <CardHeader title="Workspace" />
          {wsList.isLoading ? (
            <Skeleton className="h-9 w-full" />
          ) : wsList.error ? (
            <ErrorBox message={(wsList.error as Error).message} />
          ) : !wsList.data?.items?.length ? (
            <Empty
              icon={<Info weight="duotone" />}
              title="No workspaces"
              hint="Create a workspace to use idempotent retries."
            />
          ) : (
            <div className="space-y-3">
              <Select
                value={selected ?? ""}
                onChange={(e) => setSelected(e.target.value)}
                aria-label="Choose workspace"
              >
                {wsList.data.items.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.role})
                  </option>
                ))}
              </Select>
              {ws && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone={ownerOnly ? "warn" : "success"}>
                    {ownerOnly ? "owner only" : "you are owner"}
                  </Badge>
                  <Badge tone="neutral">TTL 24h</Badge>
                </div>
              )}
              <p className="text-xs text-zinc-500 leading-relaxed">
                Set an <code className="mono">Idempotency-Key</code> header on
                any mutating request. Replays return the original response
                with <code className="mono">Idempotent-Replay: true</code>.
              </p>
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Cached responses"
              right={
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => cache.mutate()}
                    disabled={!selected || cache.isLoading}
                    aria-label="Refresh cache"
                  >
                    <ArrowsClockwise weight="duotone" size={14} />
                    Refresh
                  </Button>
                  <Button
                    variant="danger"
                    onClick={onClear}
                    disabled={
                      busy || ownerOnly || !cache.data?.items?.length
                    }
                    aria-label="Clear all cached idempotency keys"
                  >
                    <Broom weight="duotone" size={14} />
                    Clear all
                  </Button>
                </div>
              }
            />
            {!selected ? (
              <Empty
                icon={<Info weight="duotone" />}
                title="Pick a workspace"
                hint="Choose a workspace to view its cached keys."
              />
            ) : cache.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : cache.error ? (
              <ErrorBox message={(cache.error as Error).message} />
            ) : !cache.data?.items?.length ? (
              <Empty
                icon={<ClockCounterClockwise weight="duotone" />}
                title="No cached keys"
                hint="Calls made with an Idempotency-Key header will appear here for 24 hours."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wider text-zinc-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Key</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Body</th>
                      <th className="px-3 py-2 font-medium">Cached</th>
                      <th className="px-3 py-2 font-medium">Expires</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
                    {cache.data.items.map((it) => (
                      <tr key={it.key} className="align-middle">
                        <td className="px-3 py-2">
                          <MonoChip>{it.key}</MonoChip>
                          <div className="mt-1 text-[10px] text-zinc-500 mono">
                            hash {it.request_hash.slice(0, 12)}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <Badge tone={statusTone(it.status)}>{it.status}</Badge>
                        </td>
                        <td className="px-3 py-2 text-zinc-500">
                          {(it.bytes / 1024).toFixed(1)} KiB
                        </td>
                        <td className="px-3 py-2 text-zinc-500">
                          {fmtTime(it.created_at)}
                        </td>
                        <td className="px-3 py-2 text-zinc-500">
                          {fmtUntil(it.expires_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="How clients use this" />
            <div className="space-y-3 text-sm text-zinc-600 dark:text-zinc-400">
              <p>
                Send a unique <code className="mono">Idempotency-Key</code>{" "}
                header (8 to 200 printable ASCII characters) on any mutating
                request. The server caches the response for 24 hours scoped
                to this workspace.
              </p>
              <pre className="overflow-x-auto rounded-lg border border-zinc-200/60 bg-zinc-50 p-3 text-xs leading-relaxed dark:border-zinc-800/60 dark:bg-zinc-900/50 mono">
{`curl -X POST \\
  -H "Content-Type: application/json" \\
  -H "Cookie: \$SESSION" \\
  -H "Idempotency-Key: invite-acme-2026-05-31-a4f1" \\
  -d '{"email":"new.hire@acme.com","role":"editor"}' \\
  http://localhost:3000/api/workspaces/\${WS_ID}/invites`}
              </pre>
              <ul className="list-inside list-disc space-y-1 text-xs">
                <li>Retrying the same key with the same body returns the original response with <code className="mono">Idempotent-Replay: true</code>.</li>
                <li>Reusing the same key with a different body returns <code className="mono">409 Conflict</code>.</li>
                <li>Keys are isolated per workspace; reusing a key across tenants is safe.</li>
              </ul>
            </div>
          </Card>
        </div>
      </div>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg border border-zinc-200/60 bg-white px-3 py-2 text-sm shadow-lg dark:border-zinc-800/60 dark:bg-zinc-900"
        >
          <WarningCircle weight="duotone" size={14} />
          {toast}
        </div>
      )}
    </div>
  );
}
