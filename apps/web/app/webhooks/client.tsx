"use client";

import { useCallback, useMemo, useState } from "react";
import { Fragment } from "react";
import useSWR from "swr";
import {
  Plugs as WebhookIcon,
  Plus,
  Trash,
  Copy,
  Check,
  PaperPlaneTilt,
  CheckCircle,
  XCircle,
  Pulse,
  Power,
  ShieldCheck,
  Warning,
  ArrowClockwise,
  CaretRight,
  ArrowCounterClockwise,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Button,
  Input,
  Empty,
  ErrorBox,
  Skeleton,
  Badge,
  MonoChip,
} from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

type Endpoint = {
  id: string;
  name: string;
  url: string;
  events: ("run.created" | "test.ping")[];
  secret_prefix: string;
  active: boolean;
  created_at: number;
  last_delivery_at: number | null;
  success_count: number;
  failure_count: number;
};
type EndpointsResp = { endpoints: Endpoint[] };

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
  event: string;
  url: string;
  payload: unknown;
  created_at: number;
  finished_at: number | null;
  delivered: boolean;
  attempts: DeliveryAttempt[];
};
type DeliveriesResp = { deliveries: Delivery[] };

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function fmtTime(ms: number | null): string {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function CopyBtn({ text, label = "copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* noop */
        }
      }}
      className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
      aria-label={label}
    >
      {done ? <Check weight="bold" size={12} /> : <Copy weight="duotone" size={12} />}
      {done ? "copied" : label}
    </button>
  );
}

export default function WebhooksClient() {
  const { data, error, isLoading, mutate } = useSWR<EndpointsResp>(
    "/api/webhooks",
    fetcher,
    { refreshInterval: 0 },
  );
  const [statusFilter, setStatusFilter] = useState<"all" | "ok" | "failed" | "pending">("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [redeliveringId, setRedeliveringId] = useState<string | null>(null);
  const [redeliverErr, setRedeliverErr] = useState<string | null>(null);
  const {
    data: delivData,
    mutate: mutateDeliveries,
    isLoading: delivLoading,
  } = useSWR<DeliveriesResp>(
    `/api/webhooks/deliveries?limit=25&status=${statusFilter}`,
    fetcher,
    { refreshInterval: 5_000 },
  );

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [issued, setIssued] = useState<{
    name: string;
    secret: string;
    url: string;
  } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const endpoints = data?.endpoints ?? [];
  const deliveries = delivData?.deliveries ?? [];

  const endpointName = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of endpoints) m.set(e.id, e.name);
    return m;
  }, [endpoints]);

  const onRedeliver = useCallback(
    async (id: string) => {
      setRedeliverErr(null);
      setRedeliveringId(id);
      try {
        const res = await fetch(`/api/webhooks/deliveries/${id}/redeliver`, {
          method: "POST",
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          setRedeliverErr(j?.detail ?? j?.error ?? `redeliver failed (${res.status})`);
        }
        await mutateDeliveries();
      } catch (e) {
        setRedeliverErr(e instanceof Error ? e.message : "network error");
      } finally {
        setRedeliveringId(null);
      }
    },
    [mutateDeliveries],
  );

  const onCreate = useCallback(async () => {
    setCreateErr(null);
    if (!name.trim()) return setCreateErr("name is required");
    if (!url.trim()) return setCreateErr("url is required");
    setCreating(true);
    try {
      const res = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), url: url.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        setCreateErr(
          typeof json?.detail === "string"
            ? json.detail
            : json?.error ?? "failed to create",
        );
        return;
      }
      setIssued({ name: json.name, secret: json.secret, url: json.url });
      setName("");
      setUrl("");
      mutate();
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : "network error");
    } finally {
      setCreating(false);
    }
  }, [name, url, mutate]);

  const onDelete = useCallback(
    async (id: string) => {
      setPendingId(id);
      try {
        await fetch(`/api/webhooks/${id}`, { method: "DELETE" });
        mutate();
        mutateDeliveries();
      } finally {
        setPendingId(null);
      }
    },
    [mutate, mutateDeliveries],
  );

  const onToggle = useCallback(
    async (id: string, active: boolean) => {
      setPendingId(id);
      try {
        await fetch(`/api/webhooks/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ active }),
        });
        mutate();
      } finally {
        setPendingId(null);
      }
    },
    [mutate],
  );

  const onTest = useCallback(
    async (id: string) => {
      setPendingId(id);
      try {
        await fetch(`/api/webhooks/${id}/test`, { method: "POST" });
        mutate();
        mutateDeliveries();
      } finally {
        setPendingId(null);
      }
    },
    [mutate, mutateDeliveries],
  );

  return (
    <div className="flex flex-col min-h-screen">
      <PageHeader
        eyebrow="settings / webhooks"
        title="Webhook endpoints"
        description="POST a signed JSON envelope to your URL every time a run is recorded. Includes retries with exponential backoff and a 25 entry delivery log."
        actions={
          <Button
            variant="ghost"
            onClick={() => {
              mutate();
              mutateDeliveries();
            }}
            aria-label="refresh"
          >
            <ArrowClockwise weight="duotone" size={14} /> refresh
          </Button>
        }
      />

      <div className="p-6 grid gap-4 lg:grid-cols-3">
        {/* Create form */}
        <Card className="lg:col-span-1">
          <CardHeader
            title="Register endpoint"
            hint="every run.created event POSTs here"
          />
          <div className="p-4 flex flex-col gap-3">
            <label className="text-[11px] uppercase tracking-[0.14em] font-mono text-[var(--color-muted)]">
              Name
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="staging slack relay"
                maxLength={80}
                className="mt-1.5"
              />
            </label>
            <label className="text-[11px] uppercase tracking-[0.14em] font-mono text-[var(--color-muted)]">
              Destination URL
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/hooks/adherence"
                maxLength={500}
                inputMode="url"
                className="mt-1.5"
              />
            </label>
            {createErr ? <ErrorBox message={createErr} /> : null}
            <Button
              variant="accent"
              onClick={onCreate}
              disabled={creating}
              aria-label="create endpoint"
            >
              <Plus weight="bold" size={14} />
              {creating ? "creating" : "Create endpoint"}
            </Button>
            {issued ? (
              <div className="rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 p-3 text-[12px]">
                <div className="flex items-center gap-1.5 text-[var(--color-accent)] font-mono uppercase tracking-[0.14em] text-[10px] mb-1.5">
                  <ShieldCheck weight="duotone" size={12} /> signing secret
                </div>
                <div className="text-[var(--color-fg)]/90 mb-2">
                  Copy now. We only store a hash, so this value will never be shown again.
                </div>
                <div className="flex items-center gap-2 font-mono text-[11px] break-all">
                  <span className="flex-1">{issued.secret}</span>
                  <CopyBtn text={issued.secret} label="copy secret" />
                </div>
              </div>
            ) : null}
            <details className="text-[12px] text-[var(--color-muted)]">
              <summary className="cursor-pointer">Verify with curl</summary>
              <pre className="mt-2 p-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] font-mono text-[11px] overflow-x-auto">
{`# X-Adherence-Signature: t=<unix>,v1=<hex>
# v1 = HMAC_SHA256(secret_hash, t + "." + raw_body)
# Reject when |now - t| > 300s.`}
              </pre>
            </details>
          </div>
        </Card>

        {/* Endpoints list */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Endpoints"
            hint={`${endpoints.length} registered`}
          />
          {error ? (
            <div className="p-4">
              <ErrorBox message="failed to load endpoints" />
            </div>
          ) : isLoading ? (
            <div className="p-4 flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : endpoints.length === 0 ? (
            <Empty
              icon={<WebhookIcon weight="duotone" size={32} />}
              title="No endpoints yet"
              hint="Register one above to start receiving signed run.created events."
            />
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {endpoints.map((e) => (
                <li key={e.id} className="p-4 flex flex-col gap-2.5">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="min-w-0 flex items-center gap-2">
                      <Pulse
                        weight="duotone"
                        size={16}
                        className={
                          e.active
                            ? "text-[var(--color-success)]"
                            : "text-[var(--color-muted)]"
                        }
                      />
                      <span className="font-medium text-[13px] truncate">
                        {e.name}
                      </span>
                      <Badge tone={e.active ? "success" : "neutral"}>
                        {e.active ? "active" : "paused"}
                      </Badge>
                      {e.events.map((ev) => (
                        <MonoChip key={ev}>{ev}</MonoChip>
                      ))}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="ghost"
                        onClick={() => onTest(e.id)}
                        disabled={pendingId === e.id || !e.active}
                        aria-label="send test"
                        title={
                          e.active
                            ? "Send test.ping delivery"
                            : "Enable endpoint first"
                        }
                      >
                        <PaperPlaneTilt weight="duotone" size={14} /> test
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => onToggle(e.id, !e.active)}
                        disabled={pendingId === e.id}
                        aria-label={e.active ? "pause" : "resume"}
                      >
                        <Power weight="duotone" size={14} />
                        {e.active ? "pause" : "resume"}
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => onDelete(e.id)}
                        disabled={pendingId === e.id}
                        aria-label="delete"
                      >
                        <Trash weight="duotone" size={14} />
                      </Button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-[11px] font-mono text-[var(--color-muted)]">
                    <div className="md:col-span-2 flex items-center gap-2 min-w-0">
                      <span className="text-[var(--color-subtle)]">url</span>
                      <span className="truncate text-[var(--color-fg)]/85">
                        {e.url}
                      </span>
                      <CopyBtn text={e.url} label="copy" />
                    </div>
                    <div>
                      <span className="text-[var(--color-subtle)]">secret</span>{" "}
                      {e.secret_prefix}…
                    </div>
                    <div>
                      <span className="text-[var(--color-subtle)]">last</span>{" "}
                      {fmtTime(e.last_delivery_at)}
                    </div>
                    <div>
                      <span className="text-[var(--color-subtle)]">
                        success
                      </span>{" "}
                      <span className="text-[var(--color-success)]">
                        {e.success_count}
                      </span>
                    </div>
                    <div>
                      <span className="text-[var(--color-subtle)]">fail</span>{" "}
                      <span className="text-[var(--color-danger)]">
                        {e.failure_count}
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Delivery log */}
        <Card className="lg:col-span-3">
          <CardHeader
            title="Delivery log"
            hint="most recent 25 attempts // auto refresh every 5s"
            right={
              <MonoChip>
                {deliveries.filter((d) => d.delivered).length}/{deliveries.length} ok
              </MonoChip>
            }
          />
          <div className="px-4 pt-3 flex flex-wrap items-center gap-2">
            {([
              ["all", "all"],
              ["ok", "delivered"],
              ["failed", "failed"],
              ["pending", "retrying"],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setStatusFilter(key)}
                className={cn(
                  "font-mono text-[10px] uppercase tracking-[0.14em] px-2 py-1 rounded border",
                  statusFilter === key
                    ? "bg-[var(--color-fg)] text-[var(--color-bg)] border-[var(--color-fg)]"
                    : "border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)]",
                )}
              >
                {label}
              </button>
            ))}
            {redeliverErr ? (
              <span className="ml-auto font-mono text-[11px] text-[var(--color-danger)]">
                {redeliverErr}
              </span>
            ) : null}
          </div>
          {delivLoading && deliveries.length === 0 ? (
            <div className="p-4 flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : deliveries.length === 0 ? (
            <Empty
              icon={<Warning weight="duotone" size={32} />}
              title={statusFilter === "all" ? "No deliveries yet" : `No ${statusFilter} deliveries`}
              hint={
                statusFilter === "all"
                  ? "Create a run on /predict or send a test ping to populate this log."
                  : "Try a different filter or trigger a new event."
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-[12px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.14em] font-mono text-[var(--color-muted)] border-b border-[var(--color-border)]">
                    <th className="px-2 py-2 w-6"></th>
                    <th className="px-4 py-2">when</th>
                    <th className="px-4 py-2">endpoint</th>
                    <th className="px-4 py-2">event</th>
                    <th className="px-4 py-2">status</th>
                    <th className="px-4 py-2">attempts</th>
                    <th className="px-4 py-2">last error</th>
                    <th className="px-4 py-2 text-right">action</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((d) => {
                    const last = d.attempts[d.attempts.length - 1];
                    const isOpen = expanded === d.id;
                    const canRedeliver = d.event !== "test.ping";
                    return (
                      <Fragment key={d.id}>
                        <tr className="border-b border-[var(--color-border)]/60 hover:bg-[var(--color-bg-elev)]">
                          <td className="px-2 py-2">
                            <button
                              type="button"
                              onClick={() => setExpanded(isOpen ? null : d.id)}
                              aria-label={isOpen ? "collapse" : "expand"}
                              aria-expanded={isOpen}
                              className="text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                            >
                              <CaretRight
                                weight="duotone"
                                size={14}
                                className={cn(
                                  "transition-transform",
                                  isOpen && "rotate-90",
                                )}
                              />
                            </button>
                          </td>
                          <td className="px-4 py-2 font-mono whitespace-nowrap">
                            {fmtTime(d.created_at)}
                          </td>
                          <td className="px-4 py-2 truncate max-w-[180px]">
                            {endpointName.get(d.endpoint_id) ?? d.endpoint_id}
                          </td>
                          <td className="px-4 py-2 font-mono">{d.event}</td>
                          <td className="px-4 py-2">
                            {d.delivered ? (
                              <span className="inline-flex items-center gap-1 text-[var(--color-success)] font-mono">
                                <CheckCircle weight="duotone" size={14} />
                                {last?.status ?? "ok"}
                              </span>
                            ) : d.finished_at ? (
                              <span className="inline-flex items-center gap-1 text-[var(--color-danger)] font-mono">
                                <XCircle weight="duotone" size={14} />
                                {last?.status ?? "fail"}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[var(--color-muted)] font-mono">
                                <Pulse weight="duotone" size={14} />
                                retrying
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 font-mono">
                            {d.attempts.length}
                          </td>
                          <td className="px-4 py-2 font-mono text-[var(--color-muted)] truncate max-w-[240px]">
                            {last?.error ?? "-"}
                          </td>
                          <td className="px-4 py-2 text-right">
                            {canRedeliver ? (
                              <button
                                type="button"
                                onClick={() => onRedeliver(d.id)}
                                disabled={redeliveringId === d.id}
                                className={cn(
                                  "inline-flex items-center gap-1 font-mono text-[11px] px-2 py-1 rounded border border-[var(--color-border)]",
                                  "hover:bg-[var(--color-bg-elev)] disabled:opacity-50",
                                )}
                                title="Send this payload again as a new delivery"
                              >
                                <ArrowCounterClockwise
                                  weight="duotone"
                                  size={12}
                                  className={redeliveringId === d.id ? "animate-spin" : undefined}
                                />
                                redeliver
                              </button>
                            ) : (
                              <span className="font-mono text-[10px] text-[var(--color-muted)]">
                                test
                              </span>
                            )}
                          </td>
                        </tr>
                        {isOpen ? (
                          <tr className="border-b border-[var(--color-border)]/60 bg-[var(--color-bg-elev)]/40">
                            <td colSpan={8} className="px-4 py-3">
                              <div className="grid lg:grid-cols-2 gap-4">
                                <div>
                                  <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)] mb-2">
                                    attempts ({d.attempts.length})
                                  </div>
                                  <ol className="flex flex-col gap-1">
                                    {d.attempts.length === 0 ? (
                                      <li className="font-mono text-[11px] text-[var(--color-muted)]">no attempts yet</li>
                                    ) : (
                                      d.attempts.map((a) => (
                                        <li
                                          key={a.attempt}
                                          className="font-mono text-[11px] flex items-center gap-2"
                                        >
                                          <span className="text-[var(--color-muted)]">#{a.attempt}</span>
                                          <span className="text-[var(--color-muted)]">{fmtTime(a.at)}</span>
                                          <span className={a.ok ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}>
                                            {a.status ?? a.error ?? "err"}
                                          </span>
                                          <span className="text-[var(--color-muted)]">{a.duration_ms}ms</span>
                                          {a.error && a.status ? (
                                            <span className="text-[var(--color-muted)] truncate">{a.error}</span>
                                          ) : null}
                                        </li>
                                      ))
                                    )}
                                  </ol>
                                </div>
                                <div>
                                  <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)] mb-2">
                                    payload
                                  </div>
                                  <pre className="font-mono text-[11px] whitespace-pre-wrap break-words bg-[var(--color-bg)] border border-[var(--color-border)] rounded p-2 max-h-48 overflow-auto">
                                    {JSON.stringify(d.payload, null, 2)}
                                  </pre>
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

        <Card>
          <CardHeader
            title="Manage from the API"
            hint="Same endpoints, key authenticated. Issue a key with the 'webhooks' scope from /api-keys."
          />
          <div className="space-y-3 text-[12px]">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)] mb-1">
                list endpoints
              </div>
              <pre className="font-mono text-[11px] whitespace-pre-wrap break-words bg-[var(--color-bg)] border border-[var(--color-border)] rounded p-2 overflow-auto">{`curl http://localhost:3000/v1/webhooks \\
  -H "authorization: Bearer adh_..."`}</pre>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)] mb-1">
                register endpoint (secret returned once)
              </div>
              <pre className="font-mono text-[11px] whitespace-pre-wrap break-words bg-[var(--color-bg)] border border-[var(--color-border)] rounded p-2 overflow-auto">{`curl -X POST http://localhost:3000/v1/webhooks \\
  -H "authorization: Bearer adh_..." \\
  -H "content-type: application/json" \\
  -d '{"name":"prod","url":"https://example.com/hook","events":["run.created"]}'`}</pre>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)] mb-1">
                inspect deliveries
              </div>
              <pre className="font-mono text-[11px] whitespace-pre-wrap break-words bg-[var(--color-bg)] border border-[var(--color-border)] rounded p-2 overflow-auto">{`curl 'http://localhost:3000/v1/webhooks/deliveries?status=failed&limit=20' \\
  -H "authorization: Bearer adh_..."`}</pre>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)] mb-1">
                delete an endpoint
              </div>
              <pre className="font-mono text-[11px] whitespace-pre-wrap break-words bg-[var(--color-bg)] border border-[var(--color-border)] rounded p-2 overflow-auto">{`curl -X DELETE http://localhost:3000/v1/webhooks/<id> \\
  -H "authorization: Bearer adh_..."`}</pre>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
