"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  Buildings,
  CheckCircle,
  Globe,
  Warning,
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorBox,
  Skeleton,
  Stat,
} from "@/components/ui/primitives";

type Sub = {
  id: number;
  name: string;
  purpose: string;
  data_categories: string;
  region: string;
  url: string | null;
  status: "active" | "removed";
  created_at: string;
  updated_at: string;
  created_by: string | null;
};

type Change = {
  id: number;
  subprocessor_id: number;
  name: string;
  change_type: "added" | "updated" | "removed";
  summary: string;
  announced_at: string;
  effective_at: string;
  created_by: string | null;
};

type ListResp = { count: number; subprocessors: Sub[] };
type ChangeResp = { count: number; changes: Change[] };
type OutstandingResp = { tenant_id: string; count: number; changes: Change[] };

const fetcher = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(
      typeof body?.detail === "string"
        ? body.detail
        : `request failed (${r.status})`,
    );
  }
  return body as T;
};

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

function fmtTime(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z";
  } catch {
    return iso;
  }
}

function changeTone(t: Change["change_type"]): "accent" | "warn" | "danger" {
  if (t === "added") return "accent";
  if (t === "updated") return "warn";
  return "danger";
}

export default function SubprocessorsClient() {
  const subs = useSWR<ListResp>("/api/subprocessors", fetcher);
  const changes = useSWR<ChangeResp>("/api/subprocessors/changes?limit=100", fetcher);
  const outstanding = useSWR<OutstandingResp>(
    "/api/subprocessors/outstanding",
    fetcher,
    { shouldRetryOnError: false },
  );

  const active = useMemo(
    () => (subs.data?.subprocessors ?? []).filter((s) => s.status === "active"),
    [subs.data],
  );
  const removed = useMemo(
    () => (subs.data?.subprocessors ?? []).filter((s) => s.status === "removed"),
    [subs.data],
  );

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex items-center gap-2 text-sm text-zinc-500">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 hover:text-zinc-200"
        >
          <ArrowLeft weight="duotone" className="h-4 w-4" />
          settings
        </Link>
        <span aria-hidden>/</span>
        <span>sub-processors</span>
      </div>

      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Buildings weight="duotone" className="h-6 w-6 text-emerald-400" />
          Sub-processors
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-zinc-400">
          The third parties that process customer data on our behalf. We give
          at least 30 days notice before a new processor takes effect. Your
          workspace records each acknowledgment for GDPR Art. 28(2) evidence.
        </p>
      </header>

      <section className="mb-8 grid gap-3 sm:grid-cols-3">
        <Stat
          label="active processors"
          value={subs.isLoading ? "" : String(active.length)}
        />
        <Stat
          label="announced changes"
          value={changes.isLoading ? "" : String(changes.data?.count ?? 0)}
        />
        <Stat
          label="awaiting your ack"
          value={
            outstanding.isLoading
              ? ""
              : String(outstanding.data?.count ?? 0)
          }
        />
      </section>

      <OutstandingBanner
        data={outstanding.data}
        error={outstanding.error}
        isLoading={outstanding.isLoading}
        onChanged={() => {
          outstanding.mutate();
        }}
      />

      <Card className="mb-8">
        <CardHeader
          title="Active sub-processors"
          hint="Publicly visible at /v1/subprocessors. Region reflects the primary processing location for your data."
        />
        {subs.error ? (
          <ErrorBox message={(subs.error as Error).message} />
        ) : subs.isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : active.length === 0 ? (
          <Empty
            title="No sub-processors registered yet"
            hint="The operator publishes the first entry."
          />
        ) : (
          <div className="divide-y divide-zinc-800/60">
            {active.map((s) => (
              <SubRow key={s.id} sub={s} />
            ))}
          </div>
        )}
      </Card>

      <Card className="mb-8">
        <CardHeader
          title="Change log"
          hint="Append-only notification record. Your workspace acknowledges each change."
        />
        {changes.error ? (
          <ErrorBox message={(changes.error as Error).message} />
        ) : changes.isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : (changes.data?.changes ?? []).length === 0 ? (
          <Empty title="No changes announced" hint="The change log is empty." />
        ) : (
          <ul className="divide-y divide-zinc-800/60">
            {(changes.data?.changes ?? []).map((c) => (
              <li key={c.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-zinc-100">{c.name}</span>
                    <Badge tone={changeTone(c.change_type)}>{c.change_type}</Badge>
                    <span className="text-xs text-zinc-500">
                      effective {fmtDate(c.effective_at)}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-sm text-zinc-400">{c.summary}</p>
                </div>
                <span className="shrink-0 text-xs text-zinc-500">
                  announced {fmtTime(c.announced_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {removed.length > 0 && (
        <Card className="mb-8">
          <CardHeader
            title="Removed"
            hint="Preserved so historical acknowledgments still resolve."
          />
          <div className="divide-y divide-zinc-800/60">
            {removed.map((s) => (
              <SubRow key={s.id} sub={s} />
            ))}
          </div>
        </Card>
      )}
    </main>
  );
}

function OutstandingBanner({
  data,
  error,
  isLoading,
  onChanged,
}: {
  data: OutstandingResp | undefined;
  error: unknown;
  isLoading: boolean;
  onChanged: () => void;
}) {
  if (isLoading) {
    return <Skeleton className="mb-6 h-14" />;
  }
  if (error) {
    return null; // viewers without admin still see the page; just hide the banner.
  }
  const items = data?.changes ?? [];
  if (items.length === 0) {
    return (
      <div className="mb-6 flex items-center gap-2 rounded-lg border border-emerald-700/40 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-300">
        <CheckCircle weight="duotone" className="h-4 w-4" />
        Your workspace is current on every announced change.
      </div>
    );
  }
  return (
    <div className="mb-6 rounded-lg border border-amber-700/40 bg-amber-950/30 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-amber-200">
        <Warning weight="duotone" className="h-4 w-4" />
        {items.length} change{items.length === 1 ? "" : "s"} awaiting acknowledgment
      </div>
      <ul className="space-y-2">
        {items.map((c) => (
          <AckRow key={c.id} change={c} onChanged={onChanged} />
        ))}
      </ul>
    </div>
  );
}

function AckRow({
  change,
  onChanged,
}: {
  change: Change;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function ack() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/subprocessors/acknowledge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ change_id: change.id }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(
          typeof body?.detail === "string"
            ? body.detail
            : `request failed (${r.status})`,
        );
      }
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 rounded-md border border-amber-700/30 bg-zinc-900/40 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-zinc-100">{change.name}</span>
          <Badge tone={changeTone(change.change_type)}>{change.change_type}</Badge>
          <span className="text-xs text-zinc-500">
            effective {fmtDate(change.effective_at)}
          </span>
        </div>
        <p className="mt-1 text-sm text-zinc-300">{change.summary}</p>
        {err ? <p className="mt-1 text-xs text-rose-400">{err}</p> : null}
      </div>
      <Button
        onClick={ack}
        disabled={busy}
        aria-label={`Acknowledge change ${change.id}`}
      >
        <CheckCircle weight="duotone" className="h-4 w-4" />
        {busy ? "Acknowledging" : "Acknowledge"}
      </Button>
    </li>
  );
}

function SubRow({ sub }: { sub: Sub }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-zinc-100">{sub.name}</span>
          {sub.status === "removed" ? (
            <Badge tone="danger">removed</Badge>
          ) : (
            <Badge tone="accent">active</Badge>
          )}
          <span className="inline-flex items-center gap-1 text-xs text-zinc-500">
            <Globe weight="duotone" className="h-3.5 w-3.5" />
            {sub.region}
          </span>
        </div>
        <p className="mt-1 text-sm text-zinc-400">{sub.purpose}</p>
        <p className="mt-0.5 text-xs text-zinc-500">data: {sub.data_categories}</p>
      </div>
      {sub.url ? (
        <a
          className="shrink-0 text-xs text-sky-400 hover:underline"
          href={sub.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          website
        </a>
      ) : null}
    </div>
  );
}
