"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  ArrowLeft,
  Books,
  Check,
  Copy,
  MagnifyingGlass,
} from "@phosphor-icons/react";

import {
  Badge,
  Card,
  CardHeader,
  Empty,
  ErrorBox,
  Input,
  PageHeader,
  Skeleton,
  Stat,
} from "@/components/ui/primitives";
import type { CatalogEvent, EventStability } from "@/lib/webhook-catalog";

type CatalogResp = {
  version: string;
  count: number;
  stable: number;
  beta: number;
  stable_event_types: string[];
  events: CatalogEvent[];
};

async function fetcher(url: string): Promise<CatalogResp> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`catalog request failed (${r.status})`);
  return (await r.json()) as CatalogResp;
}

function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          window.setTimeout(() => setDone(false), 1500);
        } catch {
          /* noop */
        }
      }}
      className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-bg)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
      aria-label={label}
    >
      {done ? (
        <Check weight="bold" size={12} />
      ) : (
        <Copy weight="duotone" size={12} />
      )}
      {done ? "copied" : label}
    </button>
  );
}

function StabilityBadge({ stability }: { stability: EventStability }) {
  if (stability === "stable") return <Badge tone="success">stable</Badge>;
  return <Badge tone="warn">beta</Badge>;
}

export default function CatalogClient() {
  const { data, error, isLoading } = useSWR<CatalogResp>(
    "/api/webhooks/event-catalog",
    fetcher,
    { refreshInterval: 0 },
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "stable" | "beta">("all");

  const filtered = useMemo(() => {
    if (!data) return [] as CatalogEvent[];
    const q = query.trim().toLowerCase();
    return data.events.filter((ev) => {
      if (filter !== "all" && ev.stability !== filter) return false;
      if (!q) return true;
      return (
        ev.event_type.toLowerCase().includes(q) ||
        ev.description.toLowerCase().includes(q)
      );
    });
  }, [data, query, filter]);

  return (
    <div className="flex flex-col min-h-screen">
      <PageHeader
        eyebrow="webhooks"
        title="Event catalog"
        description="Every event type this API can emit. Subscribe to any of these from the webhooks console. Beta events may change payload shape between minor versions; stable events follow semantic versioning."
        actions={
          <Link
            href="/workspace/webhooks"
            className="inline-flex items-center gap-1 text-[12px] font-mono px-3 py-1.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)]"
          >
            <ArrowLeft weight="duotone" size={14} /> back to webhooks
          </Link>
        }
      />

      <div className="px-6 py-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="catalog version" value={data?.version ?? "—"} />
        <Stat label="events" value={data ? String(data.count) : "—"} />
        <Stat label="stable" value={data ? String(data.stable) : "—"} />
        <Stat label="beta" value={data ? String(data.beta) : "—"} />
      </div>

      <div className="px-6 pb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 w-full sm:max-w-sm">
          <MagnifyingGlass
            weight="duotone"
            size={16}
            className="text-[var(--color-muted)]"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search events"
            aria-label="search events"
          />
        </div>
        <div className="flex gap-1" role="tablist" aria-label="stability filter">
          {(["all", "stable", "beta"] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={
                "text-[11px] font-mono uppercase tracking-wider px-3 py-1.5 rounded border focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] " +
                (filter === f
                  ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                  : "border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)]")
              }
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 pb-12 flex flex-col gap-4">
        {error ? (
          <ErrorBox message={(error as Error).message} />
        ) : isLoading || !data ? (
          <div className="grid gap-3">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
        ) : filtered.length === 0 ? (
          <Empty
            icon={<Books weight="duotone" size={28} />}
            title="no matching events"
            hint="Adjust the search or stability filter."
          />
        ) : (
          filtered.map((ev) => (
            <Card key={ev.event_type}>
              <CardHeader
                title={ev.event_type}
                hint={`v${ev.version} · since ${ev.since}`}
                right={
                  <div className="flex items-center gap-2">
                    <StabilityBadge stability={ev.stability} />
                    <CopyButton text={ev.event_type} label="copy name" />
                  </div>
                }
              />
              <div className="px-4 pb-4 flex flex-col gap-4">
                <p className="text-[13px] text-[var(--color-muted)] leading-relaxed max-w-3xl">
                  {ev.description}
                </p>

                <div className="grid gap-4 lg:grid-cols-2">
                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-[var(--color-muted)] mb-2">
                      payload schema
                    </div>
                    <div className="rounded border border-[var(--color-border)] overflow-hidden">
                      <table className="w-full text-[12px]">
                        <thead className="bg-[var(--color-bg)] text-[var(--color-muted)]">
                          <tr>
                            <th className="px-3 py-2 text-left font-mono uppercase tracking-wider">
                              field
                            </th>
                            <th className="px-3 py-2 text-left font-mono uppercase tracking-wider">
                              type
                            </th>
                            <th className="px-3 py-2 text-left font-mono uppercase tracking-wider">
                              description
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {ev.payload_fields.map((f) => (
                            <tr
                              key={f.name}
                              className="border-t border-[var(--color-border)] align-top"
                            >
                              <td className="px-3 py-2 font-mono">{f.name}</td>
                              <td className="px-3 py-2 text-[var(--color-muted)]">
                                {f.type}
                              </td>
                              <td className="px-3 py-2">{f.description}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-mono uppercase tracking-[0.16em] text-[var(--color-muted)]">
                        example payload
                      </span>
                      <CopyButton
                        text={JSON.stringify(ev.payload_example, null, 2)}
                        label="copy json"
                      />
                    </div>
                    <pre className="text-[12px] font-mono p-3 rounded border border-[var(--color-border)] bg-[var(--color-bg)] overflow-auto max-h-72">
                      {JSON.stringify(ev.payload_example, null, 2)}
                    </pre>
                  </div>
                </div>
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
