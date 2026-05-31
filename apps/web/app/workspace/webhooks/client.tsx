"use client";

import { Fragment, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  ArrowLeft,
  ArrowsClockwise,
  Check,
  Copy,
  DownloadSimple,
  Lightning,
  Plus,
  PaperPlaneTilt,
  Pause,
  Play,
  Trash,
  WebhooksLogo,
  X,
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorBox,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Stat,
} from "@/components/ui/primitives";

type EventName = "run.created" | "test.ping";

type Endpoint = {
  id: string;
  name: string;
  url: string;
  events: EventName[];
  secret_prefix: string;
  active: boolean;
  created_at: number;
  last_delivery_at: number | null;
  success_count: number;
  failure_count: number;
};

type DeliveryAttempt = {
  attempt: number;
  at: number;
  status: number | null;
  ok: boolean;
  duration_ms: number;
  error: string | null;
};

type Delivery = {
  id: string;
  endpoint_id: string;
  event: EventName;
  url: string;
  created_at: number;
  finished_at: number | null;
  delivered: boolean;
  attempts: DeliveryAttempt[];
};

type StatusFilter = "all" | "ok" | "failed" | "pending";

async function fetcher<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (r.status === 401)
    throw new Error("Sign in required. Visit /dashboard to authenticate.");
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { detail?: string };
    throw new Error(j.detail ?? `request failed (${r.status})`);
  }
  return (await r.json()) as T;
}

function fmtTime(ms: number | null): string {
  if (!ms) return "never";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function fmtAgo(ms: number | null): string {
  if (!ms) return "never";
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.max(1, Math.floor(d / 1000))}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function deliveryStatusOf(d: Delivery): "ok" | "failed" | "pending" {
  if (d.delivered) return "ok";
  if (d.finished_at) return "failed";
  return "pending";
}

function CopyChip({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* noop */
        }
      }}
      className="inline-flex items-center gap-1 rounded border border-[var(--color-border-strong)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-fg)]/85 hover:border-[var(--color-accent)]/40 hover:bg-[var(--color-border)]/40"
      title="copy"
    >
      <span className="truncate max-w-[260px]">{value}</span>
      {done ? <Check size={12} weight="bold" /> : <Copy size={12} weight="duotone" />}
    </button>
  );
}

function StatusBadge({ kind }: { kind: "ok" | "failed" | "pending" }) {
  if (kind === "ok") return <Badge tone="success">delivered</Badge>;
  if (kind === "failed") return <Badge tone="danger">failed</Badge>;
  return <Badge tone="warn">pending</Badge>;
}


function CreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<EventName[]>(["run.created"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);

  if (!open) return null;

  const reset = () => {
    setName("");
    setUrl("");
    setEvents(["run.created"]);
    setBusy(false);
    setError(null);
    setSecret(null);
    setSecretCopied(false);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), url: url.trim(), events }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        secret?: string;
        detail?: string;
        error?: string;
      };
      if (!res.ok)
        throw new Error(j.detail ?? j.error ?? `create failed (${res.status})`);
      if (j.secret) setSecret(j.secret);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "create failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <div className="text-sm font-medium">
            {secret ? "Secret issued" : "New webhook endpoint"}
          </div>
          <button
            type="button"
            onClick={() => { reset(); onClose(); }}
            className="text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            aria-label="close"
          >
            <X size={16} />
          </button>
        </div>

        {secret ? (
          <div className="space-y-3 px-4 py-4">
            <p className="text-[13px] text-[var(--color-fg)]/85">
              Copy this signing secret now. It is shown exactly once and is
              required to verify the <code>X-Adherence-Signature</code> header
              on incoming POST bodies.
            </p>
            <div className="rounded-md border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5 px-3 py-2 font-mono text-[12px] break-all">
              {secret}
            </div>
            <div className="flex gap-2">
              <Button
                variant="accent"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(secret);
                    setSecretCopied(true);
                    setTimeout(() => setSecretCopied(false), 2000);
                  } catch { /* noop */ }
                }}
              >
                {secretCopied ? (<><Check size={14} weight="bold" /> copied</>) : (<><Copy size={14} weight="duotone" /> copy secret</>)}
              </Button>
              <Button variant="ghost" onClick={() => { reset(); onClose(); }}>done</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 px-4 py-4">
            <div>
              <label htmlFor="ep-name" className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)] mb-1">name</label>
              <Input id="ep-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="prod" maxLength={80} disabled={busy} />
            </div>
            <div>
              <label htmlFor="ep-url" className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)] mb-1">target url</label>
              <Input id="ep-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hook" maxLength={500} disabled={busy} />
              <p className="mt-1 text-[11px] text-[var(--color-muted)]">
                SSRF policy at{" "}
                <Link href="/workspace/security" className="underline hover:text-[var(--color-fg)]">/workspace/security</Link>{" "}
                blocks loopback and link-local targets by default.
              </p>
            </div>
            <div>
              <div className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)] mb-1">events</div>
              <div className="flex flex-wrap gap-2">
                {(["run.created", "test.ping"] as EventName[]).map((ev) => {
                  const checked = events.includes(ev);
                  return (
                    <label
                      key={ev}
                      className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[12px] font-mono cursor-pointer ${checked ? "border-[var(--color-accent)]/50 bg-[var(--color-accent)]/10 text-[var(--color-fg)]" : "border-[var(--color-border-strong)] text-[var(--color-muted)]"}`}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={checked}
                        onChange={(e) => setEvents((prev) => e.target.checked ? Array.from(new Set([...prev, ev])) : prev.filter((x) => x !== ev))}
                      />
                      {ev}
                    </label>
                  );
                })}
              </div>
            </div>
            {error ? <ErrorBox message={error} /> : null}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => { reset(); onClose(); }} disabled={busy}>cancel</Button>
              <Button
                variant="accent"
                onClick={submit}
                disabled={busy || name.trim().length === 0 || url.trim().length === 0 || events.length === 0}
              >
                {busy ? "creating..." : "create endpoint"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


export default function WebhooksClient() {
  const [creating, setCreating] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [endpointFilter, setEndpointFilter] = useState<string>("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const epQuery = useSWR<{ endpoints: Endpoint[] }>("/api/webhooks", fetcher);

  const delQs = new URLSearchParams();
  if (statusFilter !== "all") delQs.set("status", statusFilter);
  if (endpointFilter) delQs.set("endpoint_id", endpointFilter);
  delQs.set("limit", "100");
  const delQuery = useSWR<{ deliveries: Delivery[] }>(
    `/api/webhooks/deliveries?${delQs.toString()}`,
    fetcher,
  );

  const endpoints = epQuery.data?.endpoints ?? [];
  const deliveries = delQuery.data?.deliveries ?? [];

  const endpointById = useMemo(() => {
    const m = new Map<string, Endpoint>();
    for (const e of endpoints) m.set(e.id, e);
    return m;
  }, [endpoints]);

  const stats = useMemo(() => {
    const total = endpoints.length;
    const active = endpoints.filter((e) => e.active).length;
    const success = endpoints.reduce((a, e) => a + e.success_count, 0);
    const failure = endpoints.reduce((a, e) => a + e.failure_count, 0);
    return { total, active, success, failure };
  }, [endpoints]);

  const flash = useCallback((kind: "ok" | "err", msg: string) => {
    setToast({ kind, msg });
    setTimeout(() => setToast(null), 2500);
  }, []);

  const refreshAll = useCallback(() => {
    void epQuery.mutate();
    void delQuery.mutate();
  }, [epQuery, delQuery]);

  const toggleActive = async (ep: Endpoint) => {
    setPendingAction(`toggle:${ep.id}`);
    try {
      const r = await fetch(`/api/webhooks/${ep.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: !ep.active }),
      });
      if (!r.ok) throw new Error(`toggle failed (${r.status})`);
      flash("ok", `${ep.name} ${!ep.active ? "enabled" : "paused"}`);
      await epQuery.mutate();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "toggle failed");
    } finally {
      setPendingAction(null);
    }
  };

  const removeEndpoint = async (ep: Endpoint) => {
    if (!window.confirm(`Delete webhook '${ep.name}'? Past delivery rows remain in the audit log but no further events will be sent.`)) return;
    setPendingAction(`delete:${ep.id}`);
    try {
      const r = await fetch(`/api/webhooks/${ep.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`delete failed (${r.status})`);
      flash("ok", `${ep.name} deleted`);
      await epQuery.mutate();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "delete failed");
    } finally {
      setPendingAction(null);
    }
  };

  const sendTest = async (ep: Endpoint) => {
    setPendingAction(`test:${ep.id}`);
    try {
      const r = await fetch(`/api/webhooks/${ep.id}/test`, { method: "POST" });
      const j = (await r.json().catch(() => ({}))) as { delivered?: boolean; detail?: string };
      if (!r.ok) throw new Error(j.detail ?? `test failed (${r.status})`);
      flash(j.delivered ? "ok" : "err", j.delivered ? "test ping delivered" : "test ping failed");
      refreshAll();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "test failed");
    } finally {
      setPendingAction(null);
    }
  };

  const replay = async (d: Delivery) => {
    setPendingAction(`replay:${d.id}`);
    try {
      const r = await fetch(`/api/webhooks/deliveries/${d.id}/redeliver`, { method: "POST" });
      const j = (await r.json().catch(() => ({}))) as { delivered?: boolean; detail?: string };
      if (!r.ok) throw new Error(j.detail ?? `replay failed (${r.status})`);
      flash(j.delivered ? "ok" : "err", j.delivered ? "delivery replayed" : "replay attempt failed");
      refreshAll();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "replay failed");
    } finally {
      setPendingAction(null);
    }
  };

  const exportHref = useMemo(() => {
    const p = new URLSearchParams({ format: "csv", limit: "500" });
    if (statusFilter !== "all") p.set("status", statusFilter);
    if (endpointFilter) p.set("endpoint_id", endpointFilter);
    return `/api/webhooks/deliveries/export?${p.toString()}`;
  }, [statusFilter, endpointFilter]);

  return (
    <div className="min-h-screen pb-16">
      <PageHeader
        eyebrow="workspace"
        title="webhooks"
        description="Register HMAC-signed outbound endpoints, browse every delivery attempt, and replay anything that failed. Every mutation is recorded in the dashboard audit log."
        actions={
          <>
            <Link
              href="/workspace"
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-2.5 py-1.5 text-[13px] hover:bg-[var(--color-border)]/40"
            >
              <ArrowLeft size={14} weight="duotone" /> back
            </Link>
            <Button variant="ghost" onClick={refreshAll}>
              <ArrowsClockwise size={14} weight="duotone" /> refresh
            </Button>
            <Button variant="accent" onClick={() => setCreating(true)}>
              <Plus size={14} weight="bold" /> new endpoint
            </Button>
          </>
        }
      />

      <div className="px-4 sm:px-6 py-5 space-y-6 max-w-[1200px] mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="endpoints" value={stats.total} />
          <Stat label="active" value={stats.active} />
          <Stat label="delivered" value={stats.success} sub="lifetime" />
          <Stat label="failed" value={stats.failure} sub="lifetime" />
        </div>

        <Card>
          <CardHeader title="endpoints" hint="HMAC-SHA256 signing. Pause to stop deliveries without losing history." />
          {epQuery.error ? (
            <div className="p-4"><ErrorBox message={(epQuery.error as Error).message} /></div>
          ) : epQuery.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : endpoints.length === 0 ? (
            <Empty
              title="No endpoints registered"
              hint="Create one to start receiving signed POSTs for run.created and test.ping events."
              icon={<WebhooksLogo size={28} weight="duotone" />}
            />
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {endpoints.map((ep) => (
                <li key={ep.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-[14px]">{ep.name}</span>
                      {ep.active ? (<Badge tone="success">active</Badge>) : (<Badge tone="warn">paused</Badge>)}
                      {ep.events.map((e) => (<Badge key={e} tone="accent">{e}</Badge>))}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-[var(--color-muted)]">
                      <CopyChip value={ep.url} />
                      <span className="font-mono">secret {ep.secret_prefix}...</span>
                      <span className="font-mono tabular-nums">ok {ep.success_count} / fail {ep.failure_count}</span>
                      <span className="font-mono tabular-nums">last {fmtAgo(ep.last_delivery_at)}</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 sm:justify-end">
                    <Button
                      variant="ghost"
                      onClick={() => sendTest(ep)}
                      disabled={!ep.active || pendingAction === `test:${ep.id}`}
                      title={ep.active ? "Send a test.ping event" : "Enable endpoint first"}
                    >
                      <PaperPlaneTilt size={13} weight="duotone" />
                      {pendingAction === `test:${ep.id}` ? "sending" : "test"}
                    </Button>
                    <Button variant="ghost" onClick={() => toggleActive(ep)} disabled={pendingAction === `toggle:${ep.id}`}>
                      {ep.active ? (<><Pause size={13} weight="duotone" /> pause</>) : (<><Play size={13} weight="duotone" /> resume</>)}
                    </Button>
                    <Button variant="ghost" onClick={() => setEndpointFilter(ep.id)} title="filter delivery log to this endpoint">
                      <Lightning size={13} weight="duotone" /> deliveries
                    </Button>
                    <Button variant="danger" onClick={() => removeEndpoint(ep)} disabled={pendingAction === `delete:${ep.id}`}>
                      <Trash size={13} weight="duotone" /> delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="recent deliveries"
            hint="Most recent 100 attempts. Replay re-signs and re-sends without mutating the original row."
            right={
              <div className="flex flex-wrap items-center gap-2">
                <Select value={endpointFilter} onChange={(e) => setEndpointFilter(e.target.value)} aria-label="filter by endpoint">
                  <option value="">all endpoints</option>
                  {endpoints.map((e) => (<option key={e.id} value={e.id}>{e.name}</option>))}
                </Select>
                <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} aria-label="filter by status">
                  <option value="all">all</option>
                  <option value="ok">delivered</option>
                  <option value="failed">failed</option>
                  <option value="pending">pending</option>
                </Select>
                <Link
                  href={exportHref}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-2.5 py-1.5 text-[13px] font-medium hover:bg-[var(--color-border)]/40"
                  prefetch={false}
                >
                  <DownloadSimple size={13} weight="duotone" /> export csv
                </Link>
              </div>
            }
          />
          {delQuery.error ? (
            <div className="p-4"><ErrorBox message={(delQuery.error as Error).message} /></div>
          ) : delQuery.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : deliveries.length === 0 ? (
            <Empty
              title="No deliveries match this filter"
              hint="Trigger a run or send a test ping from an active endpoint to see entries here."
              icon={<Lightning size={28} weight="duotone" />}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead className="bg-[var(--color-border)]/20 text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)] font-mono">
                  <tr>
                    <th className="px-3 py-2 text-left">status</th>
                    <th className="px-3 py-2 text-left">event</th>
                    <th className="px-3 py-2 text-left">endpoint</th>
                    <th className="px-3 py-2 text-left">attempts</th>
                    <th className="px-3 py-2 text-left">last code</th>
                    <th className="px-3 py-2 text-left">created</th>
                    <th className="px-3 py-2 text-right">replay</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {deliveries.map((d) => {
                    const last = d.attempts[d.attempts.length - 1];
                    const ep = endpointById.get(d.endpoint_id);
                    const isOpen = expanded === d.id;
                    return (
                      <Fragment key={d.id}>
                        <tr className="hover:bg-[var(--color-border)]/15 cursor-pointer" onClick={() => setExpanded(isOpen ? null : d.id)}>
                          <td className="px-3 py-2"><StatusBadge kind={deliveryStatusOf(d)} /></td>
                          <td className="px-3 py-2 font-mono">{d.event}</td>
                          <td className="px-3 py-2">
                            <span className="font-mono">{ep?.name ?? <em className="text-[var(--color-muted)]">deleted</em>}</span>
                          </td>
                          <td className="px-3 py-2 font-mono tabular-nums">{d.attempts.length}</td>
                          <td className="px-3 py-2 font-mono tabular-nums">
                            {last?.status ?? "-"}
                            {last?.error ? <span className="ml-1 text-[var(--color-danger)]">err</span> : null}
                          </td>
                          <td className="px-3 py-2 font-mono text-[var(--color-muted)] tabular-nums">{fmtTime(d.created_at)}</td>
                          <td className="px-3 py-2 text-right">
                            <Button
                              variant="ghost"
                              onClick={(e) => { e.stopPropagation(); replay(d); }}
                              disabled={!ep || pendingAction === `replay:${d.id}`}
                              title={ep ? "Replay this delivery" : "Original endpoint deleted"}
                            >
                              <ArrowsClockwise size={12} weight="duotone" />
                              {pendingAction === `replay:${d.id}` ? "..." : "replay"}
                            </Button>
                          </td>
                        </tr>
                        {isOpen ? (
                          <tr className="bg-[var(--color-border)]/10">
                            <td colSpan={7} className="px-4 py-3">
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div>
                                  <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)] mb-1">target</div>
                                  <CopyChip value={d.url} />
                                  <div className="mt-2 text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)] mb-1">delivery id</div>
                                  <CopyChip value={d.id} />
                                </div>
                                <div>
                                  <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)] mb-1">attempt log</div>
                                  <ul className="space-y-1">
                                    {d.attempts.map((a) => (
                                      <li key={a.attempt} className="flex items-center gap-2 text-[12px] font-mono tabular-nums">
                                        <span className="text-[var(--color-muted)] w-8">#{a.attempt}</span>
                                        <span className={a.ok ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}>
                                          {a.status ?? "ERR"}
                                        </span>
                                        <span>{a.duration_ms}ms</span>
                                        <span className="text-[var(--color-muted)]">{fmtTime(a.at)}</span>
                                        {a.error ? <span className="truncate text-[var(--color-danger)]">{a.error}</span> : null}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <CreateDialog open={creating} onClose={() => setCreating(false)} onCreated={() => { void epQuery.mutate(); }} />

      {toast ? (
        <div
          className={`fixed bottom-4 right-4 z-50 rounded-md border px-3 py-2 text-[13px] shadow-lg ${toast.kind === "ok" ? "border-[var(--color-success)]/40 bg-[var(--color-success)]/10 text-[var(--color-fg)]" : "border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 text-[var(--color-fg)]"}`}
          role="status"
        >
          {toast.msg}
        </div>
      ) : null}
    </div>
  );
}
