"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  CalendarBlank,
  Plus,
  Trash,
  Power,
  Lightning,
  CheckCircle,
  XCircle,
  ClockCounterClockwise,
  CaretRight,
  ArrowSquareOut,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Button,
  Input,
  Select,
  Empty,
  ErrorBox,
  Skeleton,
  Badge,
  MonoChip,
} from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

type Cadence = "daily" | "weekly";

type ScheduleRun = {
  at: number;
  ok: boolean;
  run_id: string | null;
  latency_ms: number | null;
  error: string | null;
};

type Schedule = {
  id: string;
  name: string;
  cadence: Cadence;
  hour_utc: number;
  weekday: number | null;
  payload: {
    user_id: string;
    doses: Array<{
      dose_id: string;
      scheduled_at: string;
      dose_class: string;
      dose_strength_mg: number;
    }>;
    top_k?: number;
  };
  active: boolean;
  created_at: number;
  next_run_at: number;
  last_run_at: number | null;
  success_count: number;
  failure_count: number;
  history: ScheduleRun[];
};

type ListResp = { schedules: Schedule[] };

const fetcher = (u: string) => fetch(u).then((r) => r.json());

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtAbs(ms: number | null): string {
  if (!ms) return "never";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function fmtRel(ms: number | null): string {
  if (!ms) return "never";
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const sign = diff >= 0 ? "in " : "";
  const suffix = diff >= 0 ? "" : " ago";
  if (abs < 60_000) return diff >= 0 ? "imminent" : "just now";
  if (abs < 3_600_000)
    return `${sign}${Math.round(abs / 60_000)}m${suffix}`;
  if (abs < 86_400_000)
    return `${sign}${Math.round(abs / 3_600_000)}h${suffix}`;
  return `${sign}${Math.round(abs / 86_400_000)}d${suffix}`;
}

const DOSE_CLASSES = ["statin", "antihypertensive", "antidiabetic", "anticoagulant"];

function defaultDose() {
  // 08:00 UTC tomorrow
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(8, 0, 0, 0);
  return {
    dose_id: "d1",
    scheduled_at: d.toISOString(),
    dose_class: "statin",
    dose_strength_mg: 20,
  };
}

export default function SchedulesClient() {
  const { data, error, isLoading, mutate } = useSWR<ListResp>(
    "/api/schedules",
    fetcher,
    { refreshInterval: 8000 },
  );
  const schedules = data?.schedules ?? [];

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("Morning statin check");
  const [cadence, setCadence] = useState<Cadence>("daily");
  const [hourUtc, setHourUtc] = useState(8);
  const [weekday, setWeekday] = useState(1);
  const [userId, setUserId] = useState("u_123");
  const [doseClass, setDoseClass] = useState("statin");
  const [doseMg, setDoseMg] = useState(20);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      setSubmitting(true);
      try {
        const dose = defaultDose();
        const body = {
          name: name.trim(),
          cadence,
          hour_utc: hourUtc,
          weekday: cadence === "weekly" ? weekday : null,
          payload: {
            user_id: userId.trim() || "u_123",
            doses: [
              {
                ...dose,
                dose_class: doseClass,
                dose_strength_mg: Number(doseMg) || 20,
              },
            ],
          },
        };
        const r = await fetch("/api/schedules", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `http_${r.status}`);
        }
        await mutate();
        setShowForm(false);
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed to create");
      } finally {
        setSubmitting(false);
      }
    },
    [name, cadence, hourUtc, weekday, userId, doseClass, doseMg, mutate],
  );

  const toggleActive = useCallback(
    async (sch: Schedule) => {
      await fetch(`/api/schedules/${sch.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: !sch.active }),
      });
      mutate();
    },
    [mutate],
  );

  const remove = useCallback(
    async (sch: Schedule) => {
      if (!confirm(`Delete schedule "${sch.name}"? This cannot be undone.`))
        return;
      await fetch(`/api/schedules/${sch.id}`, { method: "DELETE" });
      mutate();
    },
    [mutate],
  );

  const runNow = useCallback(
    async (sch: Schedule) => {
      await fetch(`/api/schedules/${sch.id}/run`, { method: "POST" });
      mutate();
    },
    [mutate],
  );

  const tickAll = useCallback(async () => {
    await fetch("/api/schedules/tick", { method: "POST" });
    mutate();
  }, [mutate]);

  const stats = useMemo(() => {
    const active = schedules.filter((s) => s.active).length;
    const due = schedules.filter((s) => s.active && s.next_run_at <= Date.now())
      .length;
    return { total: schedules.length, active, due };
  }, [schedules]);

  return (
    <div className="flex flex-col min-h-screen">
      <PageHeader
        eyebrow="automation"
        title="Schedules"
        description="Run a saved prediction on a recurring cadence. Results land in history with a scheduled tag and fan out through any webhook subscribed to run.created."
        actions={
          <>
            <Button
              variant="ghost"
              onClick={tickAll}
              title="Force-fire every due schedule now"
            >
              <Lightning weight="duotone" size={14} /> Tick now
            </Button>
            <Button onClick={() => setShowForm((v) => !v)}>
              <Plus weight="bold" size={14} />
              {showForm ? "Close" : "New schedule"}
            </Button>
          </>
        }
      />

      <div className="p-6 grid gap-4 grid-cols-1 sm:grid-cols-3">
        <Stat label="schedules" value={stats.total} />
        <Stat label="active" value={stats.active} />
        <Stat label="due now" value={stats.due} accent={stats.due > 0} />
      </div>

      {showForm ? (
        <div className="px-6 pb-2">
          <Card>
            <CardHeader title="New schedule" hint="UTC clock, fires through /v1/predict" />
            <form
              onSubmit={submit}
              className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3"
            >
              <label className="flex flex-col gap-1 text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
                Name
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={80}
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
                Cadence
                <Select
                  value={cadence}
                  onChange={(e) => setCadence(e.target.value as Cadence)}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
                Hour (UTC)
                <Select
                  value={String(hourUtc)}
                  onChange={(e) => setHourUtc(Number(e.target.value))}
                >
                  {Array.from({ length: 24 }, (_, i) => (
                    <option key={i} value={i}>
                      {String(i).padStart(2, "0")}:00 UTC
                    </option>
                  ))}
                </Select>
              </label>
              {cadence === "weekly" ? (
                <label className="flex flex-col gap-1 text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
                  Weekday
                  <Select
                    value={String(weekday)}
                    onChange={(e) => setWeekday(Number(e.target.value))}
                  >
                    {WEEKDAYS.map((w, i) => (
                      <option key={i} value={i}>
                        {w}
                      </option>
                    ))}
                  </Select>
                </label>
              ) : (
                <div />
              )}
              <label className="flex flex-col gap-1 text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
                Patient id
                <Input
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                  required
                  maxLength={120}
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
                Dose class
                <Select
                  value={doseClass}
                  onChange={(e) => setDoseClass(e.target.value)}
                >
                  {DOSE_CLASSES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
                Strength (mg)
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={doseMg}
                  onChange={(e) => setDoseMg(Number(e.target.value))}
                />
              </label>
              <div className="md:col-span-2 flex items-center justify-end gap-2 pt-1">
                {formError ? (
                  <span className="text-[12px] text-[var(--color-high)] mr-auto">
                    {formError}
                  </span>
                ) : null}
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => setShowForm(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Saving..." : "Create schedule"}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      ) : null}

      <div className="px-6 pb-10">
        {isLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : error ? (
          <ErrorBox message="Could not load schedules. Refresh the page." />
        ) : schedules.length === 0 ? (
          <Empty
            icon={<CalendarBlank weight="duotone" size={28} />}
            title="No schedules yet"
            hint="Create one to start streaming recurring predictions into your history."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {schedules.map((s) => (
              <ScheduleRow
                key={s.id}
                sch={s}
                onToggle={() => toggleActive(s)}
                onDelete={() => remove(s)}
                onRunNow={() => runNow(s)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <Card>
      <div className="p-4">
        <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--color-muted)]">
          {label}
        </div>
        <div
          className={cn(
            "mt-1 text-[22px] font-semibold tabular-nums",
            accent && "text-[var(--color-accent)]",
          )}
        >
          {value}
        </div>
      </div>
    </Card>
  );
}

function ScheduleRow({
  sch,
  onToggle,
  onDelete,
  onRunNow,
}: {
  sch: Schedule;
  onToggle: () => void;
  onDelete: () => void;
  onRunNow: () => void;
}) {
  const [open, setOpen] = useState(false);
  const cadenceLabel =
    sch.cadence === "daily"
      ? `Daily at ${String(sch.hour_utc).padStart(2, "0")}:00 UTC`
      : `Weekly on ${WEEKDAYS[sch.weekday ?? 0]} at ${String(sch.hour_utc).padStart(2, "0")}:00 UTC`;
  return (
    <Card>
      <div className="p-4 flex flex-col gap-3 md:flex-row md:items-center md:gap-4">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 min-w-0 text-left focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] rounded"
          aria-expanded={open}
        >
          <CaretRight
            weight="bold"
            size={12}
            className={cn(
              "transition-transform text-[var(--color-muted)]",
              open && "rotate-90",
            )}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium truncate">{sch.name}</span>
              {sch.active ? (
                <Badge tone="success">active</Badge>
              ) : (
                <Badge tone="warn">paused</Badge>
              )}
            </div>
            <div className="text-[11px] text-[var(--color-muted)] mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
              <span>{cadenceLabel}</span>
              <span>patient {sch.payload.user_id}</span>
              <span>
                {sch.success_count} ok / {sch.failure_count} fail
              </span>
            </div>
          </div>
        </button>
        <div className="md:ml-auto flex flex-wrap items-center gap-2 text-[11px]">
          <MonoChip>
            <span className="text-[var(--color-subtle)]">next</span>
            <span className="text-[var(--color-fg)]/85">
              {sch.active ? fmtRel(sch.next_run_at) : "paused"}
            </span>
          </MonoChip>
          <MonoChip>
            <span className="text-[var(--color-subtle)]">last</span>
            <span className="text-[var(--color-fg)]/85">{fmtRel(sch.last_run_at)}</span>
          </MonoChip>
          <Button variant="ghost" onClick={onRunNow} title="Fire this schedule once, right now">
            <Lightning weight="duotone" size={12} /> Run now
          </Button>
          <Button variant="ghost" onClick={onToggle}>
            <Power weight="duotone" size={12} />
            {sch.active ? "Pause" : "Resume"}
          </Button>
          <Button variant="ghost" onClick={onDelete}>
            <Trash weight="duotone" size={12} /> Delete
          </Button>
        </div>
      </div>
      {open ? (
        <div className="border-t border-[var(--color-border)] px-4 py-3 grid gap-3 md:grid-cols-2">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--color-muted)] mb-2">
              Saved payload
            </div>
            <pre className="text-[11px] font-mono leading-relaxed bg-[var(--color-bg)] border border-[var(--color-border)] rounded p-3 overflow-auto max-h-60">
              {JSON.stringify(sch.payload, null, 2)}
            </pre>
            <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--color-muted)] mt-3 mb-2">
              Created
            </div>
            <div className="text-[12px] font-mono text-[var(--color-muted)]">
              {fmtAbs(sch.created_at)}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--color-muted)] mb-2">
              Recent runs
            </div>
            {sch.history.length === 0 ? (
              <div className="text-[12px] text-[var(--color-muted)] italic">
                No runs yet. Hit Run now or wait for the next tick.
              </div>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {sch.history.slice(0, 8).map((r, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-2 text-[12px] py-1.5 px-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
                  >
                    {r.ok ? (
                      <CheckCircle
                        weight="duotone"
                        size={14}
                        className="text-[var(--color-low)]"
                      />
                    ) : (
                      <XCircle
                        weight="duotone"
                        size={14}
                        className="text-[var(--color-high)]"
                      />
                    )}
                    <span className="font-mono text-[11px] text-[var(--color-muted)]">
                      {fmtAbs(r.at)}
                    </span>
                    {r.latency_ms != null ? (
                      <span className="font-mono text-[11px] text-[var(--color-muted)]">
                        {r.latency_ms}ms
                      </span>
                    ) : null}
                    {r.run_id ? (
                      <Link
                        href={`/history/${r.run_id}`}
                        className="ml-auto inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline"
                      >
                        view <ArrowSquareOut weight="duotone" size={12} />
                      </Link>
                    ) : r.error ? (
                      <span className="ml-auto truncate text-[var(--color-high)]" title={r.error}>
                        {r.error}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--color-muted)] mt-3 mb-1">
              Cron hook
            </div>
            <div className="text-[11px] font-mono text-[var(--color-muted)] break-all">
              POST /api/schedules/tick (set ADHERENCE_CRON_SECRET in prod)
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
