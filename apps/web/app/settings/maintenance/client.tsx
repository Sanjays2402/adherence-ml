"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  Calendar,
  DownloadSimple,
  Plus,
  Prohibit,
  Wrench,
  Warning,
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorBox,
  Input,
  Select,
  Skeleton,
} from "@/components/ui/primitives";

type Window = {
  id: number;
  tenant_id: string;
  title: string;
  description: string;
  category: string;
  impact: "none" | "degraded" | "partial_outage" | "full_outage";
  starts_at: string;
  ends_at: string;
  duration_seconds: number;
  status: "scheduled" | "active" | "completed" | "cancelled";
  version: number;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
  archived_by: string | null;
  archived_at: string | null;
  archive_reason: string | null;
  active: boolean;
};

type ListResp = {
  tenant_id: string;
  active_count: number;
  archived_count: number;
  in_flight_count: number;
  upcoming_count: number;
  entries: Window[];
};

const CATEGORIES = [
  "maintenance",
  "upgrade",
  "security_patch",
  "capacity",
  "incident_followup",
] as const;
const IMPACTS = ["none", "degraded", "partial_outage", "full_outage"] as const;

const fetcher = async (url: string): Promise<ListResp> => {
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(
      typeof body?.detail === "string"
        ? body.detail
        : `request failed (${r.status})`,
    );
  }
  return r.json();
};

function fmtTime(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z";
  } catch {
    return iso;
  }
}

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins && days === 0) parts.push(`${mins}m`);
  if (parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function nowLocalIso(plusMinutes = 0): string {
  const d = new Date(Date.now() + plusMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function impactTone(
  impact: Window["impact"],
): "success" | "warn" | "danger" | "neutral" {
  if (impact === "none") return "success";
  if (impact === "degraded") return "warn";
  return "danger";
}

function statusTone(
  status: Window["status"],
): "success" | "warn" | "danger" | "neutral" {
  if (status === "active") return "danger";
  if (status === "scheduled") return "warn";
  if (status === "completed") return "success";
  return "neutral";
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-xs">
      <span className="font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="text-[11px] text-[var(--color-muted)]">{hint}</span>
      ) : null}
    </label>
  );
}

function TArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = "", ...rest } = props;
  return (
    <textarea
      {...rest}
      className={
        "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] " +
        "px-3 py-2 text-sm font-sans leading-relaxed " +
        "placeholder:text-[var(--color-muted)] focus:outline-none " +
        "focus:ring-1 focus:ring-[var(--color-accent)] " +
        className
      }
    />
  );
}

export default function MaintenanceClient() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data, error, isLoading, mutate } = useSWR<ListResp>(
    `/api/maintenance?include_archived=${includeArchived}`,
    fetcher,
    { refreshInterval: 30_000 },
  );

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] =
    useState<(typeof CATEGORIES)[number]>("maintenance");
  const [impact, setImpact] =
    useState<(typeof IMPACTS)[number]>("degraded");
  const [startsAt, setStartsAt] = useState<string>(nowLocalIso(60));
  const [endsAt, setEndsAt] = useState<string>(nowLocalIso(120));
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<number | null>(null);

  const reset = () => {
    setTitle("");
    setDescription("");
    setCategory("maintenance");
    setImpact("degraded");
    setStartsAt(nowLocalIso(60));
    setEndsAt(nowLocalIso(120));
  };

  const onCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      if (title.trim().length < 3) {
        setFormError("title must be at least 3 characters");
        return;
      }
      if (description.trim().length < 10) {
        setFormError("description must be at least 10 characters");
        return;
      }
      const startMs = Date.parse(startsAt);
      const endMs = Date.parse(endsAt);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        setFormError("start and end must be valid timestamps");
        return;
      }
      if (endMs <= startMs) {
        setFormError("end must be strictly after start");
        return;
      }
      setSubmitting(true);
      try {
        const r = await fetch("/api/maintenance", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            description: description.trim(),
            category,
            impact,
            starts_at: new Date(startMs).toISOString(),
            ends_at: new Date(endMs).toISOString(),
          }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            typeof body?.detail === "string"
              ? body.detail
              : `request failed (${r.status})`,
          );
        }
        reset();
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed to create");
      } finally {
        setSubmitting(false);
      }
    },
    [title, description, category, impact, startsAt, endsAt, mutate],
  );

  const onArchive = useCallback(
    async (id: number) => {
      const reason =
        typeof window !== "undefined"
          ? window.prompt("Reason for cancelling this window (optional)", "")
          : "";
      setArchivingId(id);
      try {
        const r = await fetch(`/api/maintenance/${id}/archive`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: reason || null }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            typeof body?.detail === "string"
              ? body.detail
              : `request failed (${r.status})`,
          );
        }
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed to cancel");
      } finally {
        setArchivingId(null);
      }
    },
    [mutate],
  );

  const sortedEntries = useMemo(() => data?.entries ?? [], [data]);

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 sm:py-12 space-y-8">
      <div className="flex flex-col gap-2">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] w-fit"
        >
          <ArrowLeft weight="duotone" size={14} />
          settings
        </Link>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight inline-flex items-center gap-2">
              <Wrench weight="duotone" size={26} />
              maintenance windows
            </h1>
            <p className="text-sm text-[var(--color-muted)] mt-1 max-w-2xl">
              Per-workspace schedule of planned changes. Every create, edit,
              and cancel is admin-MFA gated and written to the audit log.
              The currently in-flight set is exposed at{" "}
              <code className="text-[11px]">GET /v1/maintenance/active</code>{" "}
              for status banners.
            </p>
          </div>
          <a
            href="/api/maintenance/export.csv"
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-2 text-xs hover:bg-[var(--color-bg-elevated)]"
          >
            <DownloadSimple weight="duotone" size={14} />
            download csv
          </a>
        </div>
      </div>

      {data && data.in_flight_count > 0 ? (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs flex items-start gap-2">
          <Warning weight="duotone" size={16} className="text-rose-400 mt-0.5" />
          <div>
            <div className="font-medium">
              {data.in_flight_count} window
              {data.in_flight_count === 1 ? "" : "s"} in flight right now
            </div>
            <div className="text-[var(--color-muted)] mt-0.5">
              Customers can see this on the status banner. Cancel a window
              early if the change completed ahead of plan.
            </div>
          </div>
        </div>
      ) : null}

      <Card>
        <CardHeader
          title="schedule a window"
          right={<Plus weight="duotone" size={18} />}
        />
        <form
          onSubmit={onCreate}
          className="px-5 pb-5 grid gap-4 sm:grid-cols-2"
        >
          <div className="sm:col-span-2">
            <Field label="title" hint="3 to 128 characters">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Quarterly Postgres minor upgrade"
                maxLength={128}
                required
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="description" hint="10 to 4096 characters">
              <TArea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is changing and what customers should expect."
                rows={3}
                maxLength={4096}
                required
              />
            </Field>
          </div>
          <Field label="category">
            <Select
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as (typeof CATEGORIES)[number])
              }
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="impact">
            <Select
              value={impact}
              onChange={(e) =>
                setImpact(e.target.value as (typeof IMPACTS)[number])
              }
            >
              {IMPACTS.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="starts at" hint="local time, stored as UTC">
            <Input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              required
            />
          </Field>
          <Field label="ends at" hint="must be after start, max 30 days">
            <Input
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              required
            />
          </Field>
          {formError ? (
            <div className="sm:col-span-2">
              <ErrorBox message={formError} />
            </div>
          ) : null}
          <div className="sm:col-span-2 flex justify-end">
            <Button type="submit" disabled={submitting}>
              {submitting ? "scheduling..." : "schedule window"}
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <div className="px-5 pt-5 pb-3 flex items-center justify-between gap-3">
          <div className="inline-flex items-center gap-2 text-sm font-medium">
            <Calendar weight="duotone" size={16} />
            register
            {data ? (
              <span className="text-[11px] text-[var(--color-muted)] font-normal">
                {data.active_count} active · {data.in_flight_count} in flight ·{" "}
                {data.upcoming_count} upcoming · {data.archived_count} cancelled
              </span>
            ) : null}
          </div>
          <label className="inline-flex items-center gap-2 text-[11px] text-[var(--color-muted)] cursor-pointer">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            show cancelled
          </label>
        </div>

        {isLoading ? (
          <div className="px-5 pb-5 space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : error ? (
          <div className="px-5 pb-5">
            <ErrorBox
              message={
                error instanceof Error ? error.message : "failed to load"
              }
            />
          </div>
        ) : sortedEntries.length === 0 ? (
          <div className="px-5 pb-5">
            <Empty
              icon={<Calendar weight="duotone" size={28} />}
              title="no maintenance windows scheduled"
              hint="Schedule a window above so customers can see planned changes ahead of time."
            />
          </div>
        ) : (
          <ul className="border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]">
            {sortedEntries.map((w) => (
              <li
                key={w.id}
                className="px-5 py-4 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium truncate">
                      {w.title}
                    </span>
                    <Badge tone={statusTone(w.status)}>{w.status}</Badge>
                    <Badge tone={impactTone(w.impact)}>{w.impact}</Badge>
                    <Badge tone="neutral">{w.category}</Badge>
                  </div>
                  <div className="mt-1 text-[12px] text-[var(--color-muted)]">
                    {fmtTime(w.starts_at)} to {fmtTime(w.ends_at)} ·{" "}
                    {fmtDuration(w.duration_seconds)} · v{w.version}
                  </div>
                  <div className="mt-1 text-[12px] whitespace-pre-wrap">
                    {w.description}
                  </div>
                  {w.archive_reason ? (
                    <div className="mt-1 text-[11px] text-[var(--color-muted)]">
                      cancellation note: {w.archive_reason}
                    </div>
                  ) : null}
                </div>
                {w.active ? (
                  <Button
                    onClick={() => onArchive(w.id)}
                    disabled={archivingId === w.id}
                    variant="ghost"
                  >
                    <Prohibit weight="duotone" size={14} />
                    {archivingId === w.id ? "cancelling..." : "cancel"}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
