"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  ShieldWarning,
  Siren,
  ClockCountdown,
  CheckCircle,
  WarningOctagon,
  Megaphone,
  UsersThree,
  Stethoscope,
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
  Stat,
} from "@/components/ui/primitives";

type Update = {
  id: number;
  incident_id: number;
  author: string;
  note: string;
  created_at: string;
};

type Incident = {
  id: number;
  tenant_id: string;
  title: string;
  summary: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "open" | "contained" | "resolved";
  personal_data_breach: boolean;
  affected_user_count: number | null;
  external_ref: string | null;
  opened_by: string;
  discovered_at: string;
  opened_at: string;
  contained_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  notified_authority_at: string | null;
  notified_subjects_at: string | null;
  notification_deadline_at: string | null;
  updates: Update[];
};

type ListResp = {
  tenant_id: string;
  summary: { open: number; breaches_open: number; past_deadline: number };
  entries: Incident[];
};

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

function severityTone(s: Incident["severity"]) {
  switch (s) {
    case "critical":
      return "danger" as const;
    case "high":
      return "warn" as const;
    case "medium":
      return "neutral" as const;
    default:
      return "neutral" as const;
  }
}

function statusTone(s: Incident["status"]) {
  switch (s) {
    case "resolved":
      return "success" as const;
    case "contained":
      return "neutral" as const;
    default:
      return "warn" as const;
  }
}

function countdown(deadline: string | null, notified: string | null): string {
  if (!deadline) return "n/a";
  if (notified) return "notified";
  const ms = new Date(deadline).getTime() - Date.now();
  if (Number.isNaN(ms)) return "n/a";
  if (ms <= 0) {
    const overdue = -ms;
    const h = Math.floor(overdue / 3_600_000);
    return `overdue by ${h}h`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m left`;
}

export default function IncidentsClient() {
  const { data, error, isLoading, mutate } = useSWR<ListResp>(
    "/api/incidents",
    fetcher,
  );
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [severity, setSeverity] =
    useState<Incident["severity"]>("medium");
  const [pdb, setPdb] = useState(false);
  const [affected, setAffected] = useState("");
  const [ref, setRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState<Record<number, string>>({});

  const onOpen = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      if (title.trim().length < 4) {
        setFormError("title must be at least 4 characters");
        return;
      }
      if (summary.trim().length < 10) {
        setFormError("summary must be at least 10 characters");
        return;
      }
      setSubmitting(true);
      try {
        const payload: Record<string, unknown> = {
          title: title.trim(),
          summary: summary.trim(),
          severity,
          personal_data_breach: pdb,
        };
        if (affected.trim()) {
          const n = Number.parseInt(affected, 10);
          if (!Number.isFinite(n) || n < 0) {
            throw new Error("affected user count must be 0 or higher");
          }
          payload.affected_user_count = n;
        }
        if (ref.trim()) payload.external_ref = ref.trim();
        const r = await fetch("/api/incidents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            typeof body?.detail === "string"
              ? body.detail
              : `failed (${r.status})`,
          );
        }
        setTitle("");
        setSummary("");
        setSeverity("medium");
        setPdb(false);
        setAffected("");
        setRef("");
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed");
      } finally {
        setSubmitting(false);
      }
    },
    [title, summary, severity, pdb, affected, ref, mutate],
  );

  const onMilestone = useCallback(
    async (id: number, milestone: string) => {
      setBusyId(id);
      try {
        const r = await fetch(`/api/incidents/${id}/milestone`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ milestone }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            typeof body?.detail === "string"
              ? body.detail
              : `failed (${r.status})`,
          );
        }
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed");
      } finally {
        setBusyId(null);
      }
    },
    [mutate],
  );

  const onAppend = useCallback(
    async (id: number) => {
      const note = (noteDraft[id] ?? "").trim();
      if (note.length < 1) {
        setFormError("note is required");
        return;
      }
      setBusyId(id);
      try {
        const r = await fetch(`/api/incidents/${id}/updates`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            typeof body?.detail === "string"
              ? body.detail
              : `failed (${r.status})`,
          );
        }
        setNoteDraft((prev) => ({ ...prev, [id]: "" }));
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed");
      } finally {
        setBusyId(null);
      }
    },
    [noteDraft, mutate],
  );

  const banner = useMemo(() => {
    if (!data) return null;
    const { past_deadline, breaches_open, open } = data.summary;
    if (past_deadline > 0) {
      return {
        tone: "danger" as const,
        icon: <WarningOctagon weight="duotone" className="h-4 w-4" />,
        text: `${past_deadline} incident${past_deadline === 1 ? "" : "s"} past the 72h notification deadline. Notify the supervisory authority now.`,
      };
    }
    if (breaches_open > 0) {
      return {
        tone: "warn" as const,
        icon: <ShieldWarning weight="duotone" className="h-4 w-4" />,
        text: `${breaches_open} personal data breach${breaches_open === 1 ? "" : "es"} open. GDPR Art. 33 deadline is counting down.`,
      };
    }
    if (open > 0) {
      return {
        tone: "neutral" as const,
        icon: <Siren weight="duotone" className="h-4 w-4" />,
        text: `${open} incident${open === 1 ? "" : "s"} open.`,
      };
    }
    return null;
  }, [data]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      <Link
        href="/settings"
        className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200"
      >
        <ArrowLeft weight="duotone" className="h-3 w-3" /> settings
      </Link>
      <div className="mt-3 flex items-start gap-3">
        <Siren weight="duotone" className="mt-1 h-6 w-6 text-zinc-300" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
            security incidents
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">
            Per-workspace register for security incidents. Captures GDPR
            Art. 33 evidence (72-hour authority notification) and SOC2
            CC7.4 lifecycle proof. All mutations require admin role plus
            an active MFA step-up and are written to the admin audit log.
          </p>
        </div>
      </div>

      {banner ? (
        <div
          role="status"
          className={`mt-6 flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
            banner.tone === "danger"
              ? "border-red-900/60 bg-red-950/40 text-red-200"
              : banner.tone === "warn"
                ? "border-amber-900/60 bg-amber-950/40 text-amber-200"
                : "border-zinc-800 bg-zinc-900/40 text-zinc-300"
          }`}
        >
          {banner.icon}
          <span>{banner.text}</span>
        </div>
      ) : null}

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat
          label="open"
          value={data ? String(data.summary.open) : "0"}
          sub="not yet resolved"
        />
        <Stat
          label="breaches open"
          value={data ? String(data.summary.breaches_open) : "0"}
          sub="GDPR Art. 33 scope"
        />
        <Stat
          label="past deadline"
          value={data ? String(data.summary.past_deadline) : "0"}
          sub="authority not notified"
        />
      </div>

      <Card className="mt-6">
        <CardHeader
          title="open an incident"
          hint="Severity high or critical, or any personal data breach, starts the 72h notification clock."
        />
        <form onSubmit={onOpen} className="grid gap-3 px-4 pb-4 sm:px-5">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              placeholder="title (e.g. unauthorized access to staging predictions API)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              aria-label="incident title"
            />
            <Select
              value={severity}
              onChange={(e) =>
                setSeverity(e.target.value as Incident["severity"])
              }
              aria-label="severity"
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high (starts 72h clock)</option>
              <option value="critical">critical (starts 72h clock)</option>
            </Select>
          </div>
          <textarea
            placeholder="summary of what happened, scope, and current containment status"
            className="min-h-[88px] w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-600"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            maxLength={8192}
            aria-label="incident summary"
          />
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={pdb}
                onChange={(e) => setPdb(e.target.checked)}
                className="h-4 w-4 accent-zinc-300"
              />
              personal data breach
            </label>
            <Input
              placeholder="affected user count (optional)"
              value={affected}
              onChange={(e) => setAffected(e.target.value)}
              inputMode="numeric"
              aria-label="affected user count"
            />
            <Input
              placeholder="external ref (ticket, CVE, etc.)"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              maxLength={256}
              aria-label="external ref"
            />
          </div>
          {formError ? <ErrorBox message={formError} /> : null}
          <div className="flex justify-end">
            <Button type="submit" disabled={submitting} aria-busy={submitting}>
              {submitting ? "opening..." : "open incident"}
            </Button>
          </div>
        </form>
      </Card>

      <div className="mt-6 space-y-4">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : error ? (
          <ErrorBox message={(error as Error).message} />
        ) : !data || data.entries.length === 0 ? (
          <Empty
            title="no incidents on file"
            hint="When a security event affects this workspace, open an incident here so the response timeline is preserved."
          />
        ) : (
          data.entries.map((it) => (
            <Card key={it.id}>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-900 px-4 py-3 sm:px-5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={severityTone(it.severity)}>
                      {it.severity}
                    </Badge>
                    <Badge tone={statusTone(it.status)}>{it.status}</Badge>
                    {it.personal_data_breach ? (
                      <Badge tone="warn">personal data breach</Badge>
                    ) : null}
                    <span className="text-xs text-zinc-500">#{it.id}</span>
                  </div>
                  <h3 className="mt-2 break-words text-base font-medium text-zinc-100">
                    {it.title}
                  </h3>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-400">
                    {it.summary}
                  </p>
                </div>
                <div className="shrink-0 text-right text-xs text-zinc-500">
                  <div className="flex items-center justify-end gap-1">
                    <ClockCountdown
                      weight="duotone"
                      className="h-3.5 w-3.5"
                    />
                    {countdown(
                      it.notification_deadline_at,
                      it.notified_authority_at,
                    )}
                  </div>
                  <div className="mt-1">
                    discovered {fmtTime(it.discovered_at)}
                  </div>
                </div>
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 px-4 py-3 text-xs text-zinc-400 sm:grid-cols-4 sm:px-5">
                <div>
                  <dt className="text-zinc-500">contained</dt>
                  <dd>{fmtTime(it.contained_at) || "pending"}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">notified authority</dt>
                  <dd>{fmtTime(it.notified_authority_at) || "pending"}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">notified subjects</dt>
                  <dd>{fmtTime(it.notified_subjects_at) || "n/a"}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">resolved</dt>
                  <dd>{fmtTime(it.resolved_at) || "pending"}</dd>
                </div>
                {it.affected_user_count !== null ? (
                  <div>
                    <dt className="text-zinc-500">affected users</dt>
                    <dd>{it.affected_user_count}</dd>
                  </div>
                ) : null}
                {it.external_ref ? (
                  <div className="col-span-2 truncate">
                    <dt className="text-zinc-500">external ref</dt>
                    <dd className="truncate">{it.external_ref}</dd>
                  </div>
                ) : null}
              </dl>

              {it.status !== "resolved" ? (
                <div className="flex flex-wrap gap-2 border-t border-zinc-900 px-4 py-3 sm:px-5">
                  <Button
                    variant="ghost"
                    onClick={() => onMilestone(it.id, "contained")}
                    disabled={busyId === it.id || it.contained_at !== null}
                  >
                    <CheckCircle
                      weight="duotone"
                      className="mr-1 h-4 w-4"
                    />
                    mark contained
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => onMilestone(it.id, "notified_authority")}
                    disabled={
                      busyId === it.id || it.notified_authority_at !== null
                    }
                  >
                    <Megaphone weight="duotone" className="mr-1 h-4 w-4" />
                    notified authority
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => onMilestone(it.id, "notified_subjects")}
                    disabled={
                      busyId === it.id || it.notified_subjects_at !== null
                    }
                  >
                    <UsersThree weight="duotone" className="mr-1 h-4 w-4" />
                    notified subjects
                  </Button>
                  <Button
                    onClick={() => onMilestone(it.id, "resolved")}
                    disabled={busyId === it.id}
                  >
                    <Stethoscope weight="duotone" className="mr-1 h-4 w-4" />
                    mark resolved
                  </Button>
                </div>
              ) : null}

              <div className="border-t border-zinc-900 px-4 py-3 sm:px-5">
                <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                  timeline
                </div>
                {it.updates.length === 0 ? (
                  <p className="mt-1 text-sm text-zinc-500">
                    no operator updates yet.
                  </p>
                ) : (
                  <ol className="mt-2 space-y-2">
                    {it.updates.map((u) => (
                      <li
                        key={u.id}
                        className="rounded-md border border-zinc-900 bg-zinc-950/40 px-3 py-2 text-sm text-zinc-200"
                      >
                        <div className="text-xs text-zinc-500">
                          {fmtTime(u.created_at)} {"\u00b7"} {u.author}
                        </div>
                        <div className="mt-1 whitespace-pre-wrap break-words">
                          {u.note}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <Input
                    placeholder="add sitrep update"
                    value={noteDraft[it.id] ?? ""}
                    onChange={(e) =>
                      setNoteDraft((prev) => ({
                        ...prev,
                        [it.id]: e.target.value,
                      }))
                    }
                    maxLength={8192}
                    aria-label="incident update"
                  />
                  <Button
                    onClick={() => onAppend(it.id)}
                    disabled={
                      busyId === it.id ||
                      (noteDraft[it.id] ?? "").trim().length === 0
                    }
                  >
                    append
                  </Button>
                </div>
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
