"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  Archive,
  ClockCountdown,
  DownloadSimple,
  HardDrives,
  Plus,
  ShieldCheck,
  Stack,
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

type Outcome = "not_tested" | "passed" | "partial" | "failed";
type Tier = "tier1" | "tier2" | "tier3";
type Strategy =
  | "backup_restore"
  | "pilot_light"
  | "warm_standby"
  | "multi_site";

type Entry = {
  id: number;
  tenant_id: string;
  service_name: string;
  tier: Tier;
  rto_minutes: number;
  rpo_minutes: number;
  strategy: Strategy;
  runbook_url: string | null;
  notes: string | null;
  last_tested_at: string | null;
  last_outcome: Outcome;
  last_test_notes: string | null;
  test_cadence_days: number;
  next_test_due_at: string;
  test_overdue: boolean;
  version: number;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
  archived_by: string | null;
  archived_at: string | null;
  active: boolean;
};

type ListResp = {
  tenant_id: string;
  active_count: number;
  archived_count: number;
  overdue_count: number;
  entries: Entry[];
};

const TIERS: Tier[] = ["tier1", "tier2", "tier3"];
const STRATEGIES: Strategy[] = [
  "backup_restore",
  "pilot_light",
  "warm_standby",
  "multi_site",
];
const OUTCOMES: Outcome[] = ["passed", "partial", "failed", "not_tested"];

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
  if (!iso) return "never";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z";
  } catch {
    return iso;
  }
}

function fmtMinutes(m: number): string {
  if (m <= 0) return "0m";
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r === 0 ? `${h}h` : `${h}h ${r}m`;
  }
  const d = Math.floor(m / (60 * 24));
  const r = Math.floor((m % (60 * 24)) / 60);
  return r === 0 ? `${d}d` : `${d}d ${r}h`;
}

function outcomeTone(o: Outcome): "success" | "warn" | "danger" | "neutral" {
  if (o === "passed") return "success";
  if (o === "partial") return "warn";
  if (o === "failed") return "danger";
  return "neutral";
}

function tierTone(t: Tier): "success" | "warn" | "danger" {
  if (t === "tier1") return "danger";
  if (t === "tier2") return "warn";
  return "success";
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

export default function BcdrClient() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data, error, isLoading, mutate } = useSWR<ListResp>(
    `/api/bcdr?include_archived=${includeArchived}`,
    fetcher,
  );

  const [serviceName, setServiceName] = useState("");
  const [tier, setTier] = useState<Tier>("tier1");
  const [rto, setRto] = useState("60");
  const [rpo, setRpo] = useState("15");
  const [strategy, setStrategy] = useState<Strategy>("warm_standby");
  const [runbookUrl, setRunbookUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [cadenceDays, setCadenceDays] = useState("365");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [archivingId, setArchivingId] = useState<number | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [testOutcome, setTestOutcome] = useState<
    Record<number, Outcome>
  >({});
  const [testNotes, setTestNotes] = useState<Record<number, string>>({});

  const reset = () => {
    setServiceName("");
    setTier("tier1");
    setRto("60");
    setRpo("15");
    setStrategy("warm_standby");
    setRunbookUrl("");
    setNotes("");
    setCadenceDays("365");
  };

  const onCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      if (serviceName.trim().length < 2) {
        setFormError("service name must be at least 2 characters");
        return;
      }
      const rtoN = Number(rto);
      const rpoN = Number(rpo);
      const cad = Number(cadenceDays);
      if (!Number.isInteger(rtoN) || rtoN < 0) {
        setFormError("rto must be a non-negative integer");
        return;
      }
      if (!Number.isInteger(rpoN) || rpoN < 0) {
        setFormError("rpo must be a non-negative integer");
        return;
      }
      if (!Number.isInteger(cad) || cad < 30 || cad > 365 * 2) {
        setFormError("test cadence must be between 30 and 730 days");
        return;
      }
      const url = runbookUrl.trim();
      if (url && !/^https?:\/\//i.test(url)) {
        setFormError("runbook url must start with http:// or https://");
        return;
      }
      setSubmitting(true);
      try {
        const r = await fetch("/api/bcdr", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            service_name: serviceName.trim(),
            tier,
            rto_minutes: rtoN,
            rpo_minutes: rpoN,
            strategy,
            runbook_url: url || null,
            notes: notes.trim() || null,
            test_cadence_days: cad,
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
    [serviceName, tier, rto, rpo, strategy, runbookUrl, notes, cadenceDays, mutate],
  );

  const onArchive = useCallback(
    async (id: number) => {
      setArchivingId(id);
      try {
        const r = await fetch(`/api/bcdr/${id}/archive`, { method: "POST" });
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
        setFormError(err instanceof Error ? err.message : "failed to archive");
      } finally {
        setArchivingId(null);
      }
    },
    [mutate],
  );

  const onRecordTest = useCallback(
    async (id: number) => {
      const outcome = testOutcome[id] ?? "passed";
      const note = (testNotes[id] ?? "").trim();
      setTestingId(id);
      try {
        const r = await fetch(`/api/bcdr/${id}/test`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            outcome,
            test_notes: note || null,
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
        setTestNotes((m) => ({ ...m, [id]: "" }));
        await mutate();
      } catch (err) {
        setFormError(
          err instanceof Error ? err.message : "failed to record test",
        );
      } finally {
        setTestingId(null);
      }
    },
    [testOutcome, testNotes, mutate],
  );

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
              <HardDrives weight="duotone" size={26} />
              business continuity and disaster recovery
            </h1>
            <p className="text-sm text-[var(--color-muted)] mt-1 max-w-2xl">
              Declare per-service RTO, RPO, DR strategy, runbook, and the date
              and outcome of the last DR test. Procurement, SOC 2 CC9.1, and
              ISO 27001 A.17 reviewers expect this evidence in writing.
            </p>
          </div>
          <a
            href="/api/bcdr/export.csv"
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-2 text-xs hover:bg-[var(--color-bg-elevated)]"
          >
            <DownloadSimple weight="duotone" size={14} />
            download csv
          </a>
        </div>
      </div>

      {data && data.overdue_count > 0 ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs flex items-start gap-2">
          <Warning weight="duotone" size={16} className="text-amber-400 mt-0.5" />
          <div>
            <div className="font-medium">
              {data.overdue_count} declaration{data.overdue_count === 1 ? "" : "s"} overdue for a DR test
            </div>
            <div className="text-[var(--color-muted)] mt-0.5">
              Record a fresh test outcome to reset the cadence and clear this
              warning.
            </div>
          </div>
        </div>
      ) : null}

      <Card>
        <CardHeader
          title="add a declaration"
          right={<Plus weight="duotone" size={18} />}
        />
        <form onSubmit={onCreate} className="px-5 pb-5 grid gap-4 sm:grid-cols-2">
          <Field label="service name" hint="What this declaration covers.">
            <Input
              value={serviceName}
              onChange={(e) => setServiceName(e.target.value)}
              placeholder="prediction-api"
              maxLength={128}
              required
            />
          </Field>
          <Field label="recovery tier">
            <Select
              value={tier}
              onChange={(e) => setTier(e.target.value as Tier)}
            >
              {TIERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="rto (minutes)" hint="Recovery time objective.">
            <Input
              type="number"
              min={0}
              value={rto}
              onChange={(e) => setRto(e.target.value)}
            />
          </Field>
          <Field label="rpo (minutes)" hint="Recovery point objective.">
            <Input
              type="number"
              min={0}
              value={rpo}
              onChange={(e) => setRpo(e.target.value)}
            />
          </Field>
          <Field label="dr strategy">
            <Select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as Strategy)}
            >
              {STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {s.replace("_", " ")}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="test cadence (days)"
            hint="30 to 730. Defaults to 365."
          >
            <Input
              type="number"
              min={30}
              max={730}
              value={cadenceDays}
              onChange={(e) => setCadenceDays(e.target.value)}
            />
          </Field>
          <Field
            label="runbook url"
            hint="Link to the failover or restore runbook."
          >
            <Input
              type="url"
              value={runbookUrl}
              onChange={(e) => setRunbookUrl(e.target.value)}
              placeholder="https://runbooks.example.com/dr/prediction-api"
              maxLength={512}
            />
          </Field>
          <Field label="notes" hint="Optional declaration context.">
            <TArea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Primary scoring endpoint. Active/active across us-east-2 and us-west-2."
              rows={2}
              maxLength={4096}
            />
          </Field>
          {formError ? (
            <div className="sm:col-span-2">
              <ErrorBox message={formError} />
            </div>
          ) : null}
          <div className="sm:col-span-2 flex items-center justify-end gap-3">
            <span className="text-[11px] text-[var(--color-muted)] inline-flex items-center gap-1">
              <ShieldCheck weight="duotone" size={12} />
              admin role and active MFA required
            </span>
            <Button type="submit" disabled={submitting}>
              {submitting ? "saving" : "add declaration"}
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader
          title="register"
          right={
            <label className="inline-flex items-center gap-2 text-xs text-[var(--color-muted)]">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              show archived
            </label>
          }
        />
        <div className="px-5 pb-5 space-y-3">
          {error ? <ErrorBox message={error.message} /> : null}
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : null}
          {!isLoading && data && data.entries.length === 0 ? (
            <Empty
              title="no declarations yet"
              hint="Add one declaration per critical service so buyers can verify RTO, RPO, and DR test history."
              icon={<Stack weight="duotone" size={28} />}
            />
          ) : null}
          {data?.entries.map((e) => (
            <div
              key={e.id}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4 space-y-3"
            >
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{e.service_name}</span>
                    <Badge tone={e.active ? "success" : "neutral"}>
                      {e.active ? "active" : "archived"}
                    </Badge>
                    <Badge tone={tierTone(e.tier)}>{e.tier}</Badge>
                    <Badge tone="neutral">v{e.version}</Badge>
                    <Badge tone={outcomeTone(e.last_outcome)}>
                      last: {e.last_outcome.replace("_", " ")}
                    </Badge>
                    {e.test_overdue && e.active ? (
                      <Badge tone="danger">test overdue</Badge>
                    ) : null}
                  </div>
                  <div className="text-xs text-[var(--color-muted)] mt-1 inline-flex items-center gap-1 flex-wrap">
                    <ClockCountdown weight="duotone" size={12} />
                    next test due {fmtTime(e.next_test_due_at)} {" · "}
                    last tested {fmtTime(e.last_tested_at)}
                    {e.updated_at
                      ? ` · updated by ${e.updated_by} on ${fmtTime(e.updated_at)}`
                      : ""}
                    {e.archived_at
                      ? ` · archived by ${e.archived_by} on ${fmtTime(e.archived_at)}`
                      : ""}
                  </div>
                </div>
                {e.active ? (
                  <Button
                    variant="ghost"
                    onClick={() => onArchive(e.id)}
                    disabled={archivingId === e.id}
                  >
                    <Archive weight="duotone" size={14} />
                    {archivingId === e.id ? "archiving" : "archive"}
                  </Button>
                ) : null}
              </div>

              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-xs">
                <div>
                  <dt className="font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                    rto
                  </dt>
                  <dd className="mt-0.5">{fmtMinutes(e.rto_minutes)}</dd>
                </div>
                <div>
                  <dt className="font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                    rpo
                  </dt>
                  <dd className="mt-0.5">{fmtMinutes(e.rpo_minutes)}</dd>
                </div>
                <div>
                  <dt className="font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                    strategy
                  </dt>
                  <dd className="mt-0.5">{e.strategy.replace("_", " ")}</dd>
                </div>
                <div>
                  <dt className="font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                    cadence
                  </dt>
                  <dd className="mt-0.5">{e.test_cadence_days}d</dd>
                </div>
              </dl>

              {e.runbook_url ? (
                <div className="text-xs">
                  <span className="font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                    runbook
                  </span>{" "}
                  <a
                    href={e.runbook_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent)] break-all"
                  >
                    {e.runbook_url}
                  </a>
                </div>
              ) : null}

              {e.notes ? (
                <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                  {e.notes}
                </p>
              ) : null}

              {e.last_test_notes ? (
                <div className="text-xs">
                  <span className="font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                    last test notes
                  </span>
                  <div className="mt-0.5 text-[var(--color-fg)]/90 whitespace-pre-wrap break-words">
                    {e.last_test_notes}
                  </div>
                </div>
              ) : null}

              {e.active ? (
                <div className="border-t border-[var(--color-border)] pt-3 grid gap-2 sm:grid-cols-[auto_1fr_auto] sm:items-end">
                  <Field label="record test">
                    <Select
                      value={testOutcome[e.id] ?? "passed"}
                      onChange={(ev) =>
                        setTestOutcome((m) => ({
                          ...m,
                          [e.id]: ev.target.value as Outcome,
                        }))
                      }
                    >
                      {OUTCOMES.map((o) => (
                        <option key={o} value={o}>
                          {o.replace("_", " ")}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="test notes">
                    <Input
                      value={testNotes[e.id] ?? ""}
                      onChange={(ev) =>
                        setTestNotes((m) => ({
                          ...m,
                          [e.id]: ev.target.value,
                        }))
                      }
                      placeholder="Failover drill, recovered in 14m, no data loss."
                      maxLength={4096}
                    />
                  </Field>
                  <Button
                    variant="ghost"
                    onClick={() => onRecordTest(e.id)}
                    disabled={testingId === e.id}
                  >
                    {testingId === e.id ? "recording" : "log test"}
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
