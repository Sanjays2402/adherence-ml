"use client";

import useSWR from "swr";
import { useEffect, useState } from "react";
import {
  MagnifyingGlass,
  ArrowsClockwise,
  Bell,
  Check,
  Moon,
  X,
  HandPalm,
  Spinner,
  Clock,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Button,
  Input,
  ErrorBox,
  Empty,
  Badge,
  Skeleton,
  MonoChip,
  LiveDot,
} from "@/components/ui/primitives";
import type { DeliveryOut } from "@/lib/types";
import { fmtTime, fmtPct, fmtRelative, cn } from "@/lib/utils";

const fetcher = (url: string) =>
  fetch(url).then(async (r) => {
    const j = await r.json();
    if (!r.ok)
      throw new Error(typeof j?.detail === "string" ? j.detail : r.statusText);
    return j;
  });

const STATE_TONE: Record<
  string,
  "neutral" | "success" | "warn" | "danger" | "accent"
> = {
  queued: "accent",
  sent: "neutral",
  snoozed: "warn",
  dismissed: "neutral",
  acted: "success",
  expired: "danger",
};

const STATE_RAIL: Record<string, string> = {
  queued: "rail-neutral",
  sent: "rail-neutral",
  snoozed: "rail-mid",
  dismissed: "rail-neutral",
  acted: "rail-low",
  expired: "rail-high",
};

const STATES = ["", "queued", "sent", "snoozed", "dismissed", "acted", "expired"];

export default function InterventionsClient() {
  const [user, setUser] = useState("demo-user-001");
  const [submittedUser, setSubmittedUser] = useState("demo-user-001");
  const [stateFilter, setStateFilter] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<number, string>>({});

  const qs = new URLSearchParams({ limit: "100" });
  if (stateFilter) qs.set("state", stateFilter);
  const key = submittedUser
    ? `/api/interventions/deliveries/${encodeURIComponent(submittedUser)}?${qs.toString()}`
    : null;
  const { data, error, isLoading, mutate, isValidating } = useSWR<DeliveryOut[]>(
    key,
    fetcher,
    { refreshInterval: 15_000 },
  );

  async function ack(
    id: number,
    state: "acted" | "snoozed" | "dismissed" | "sent",
    snoozeMinutes?: number,
  ) {
    setBusy(id);
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      const body: Record<string, unknown> = { state };
      if (snoozeMinutes) body.snooze_minutes = snoozeMinutes;
      const res = await fetch(`/api/proxy/v1/interventions/${id}/ack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok)
        throw new Error(
          typeof j?.detail === "string" ? j.detail : `failed (${res.status})`,
        );
      await mutate();
    } catch (err) {
      setErrors((e) => ({
        ...e,
        [id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusy(null);
    }
  }

  const list = data ?? [];
  const counts = list.reduce<Record<string, number>>((acc, d) => {
    acc[d.state] = (acc[d.state] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <PageHeader
        eyebrow="interventions // queue"
        title="Intervention queue"
        description="Per-user delivery roster with state machine and cooldown timers. Ack writes feed back into the suppression engine."
        actions={
          <div className="flex items-center gap-2">
            <MonoChip>
              <LiveDot />
              15s poll
            </MonoChip>
            <Button
              variant="ghost"
              onClick={() => mutate()}
              disabled={isValidating}
            >
              <ArrowsClockwise weight="duotone" size={14} />
              Refresh
            </Button>
          </div>
        }
      />

      <div className="p-6 space-y-4">
        <Card>
          <form
            className="flex flex-wrap items-end gap-2 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              setSubmittedUser(user.trim());
            }}
          >
            <label className="flex-1 min-w-[200px] space-y-1">
              <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                user id
              </div>
              <Input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder="user-id"
              />
            </label>
            <label className="space-y-1">
              <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                state
              </div>
              <select
                value={stateFilter}
                onChange={(e) => setStateFilter(e.target.value)}
                className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] font-mono"
              >
                {STATES.map((s) => (
                  <option key={s} value={s}>
                    {s || "any"}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit">
              <MagnifyingGlass weight="duotone" size={14} />
              Load
            </Button>
          </form>
        </Card>

        {error ? <ErrorBox message={error.message} /> : null}

        {/* State summary strip */}
        {list.length > 0 ? (
          <div className="grid grid-cols-3 md:grid-cols-6 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
            {["queued", "sent", "snoozed", "acted", "dismissed", "expired"].map(
              (s) => (
                <div
                  key={s}
                  className="px-3 py-2 border-r border-[var(--color-border)] last:border-r-0"
                >
                  <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                    {s}
                  </div>
                  <div className="text-base font-mono tabular-nums">
                    {counts[s] ?? 0}
                  </div>
                </div>
              ),
            )}
          </div>
        ) : null}

        <Card>
          <CardHeader
            title={`Queue ${list.length ? `// ${list.length}` : ""}`}
            hint={submittedUser ? `user ${submittedUser}` : undefined}
          />
          {isLoading && !data ? (
            <div className="p-4 space-y-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : !submittedUser ? (
            <Empty title="Enter a user" hint="Deliveries are scoped per user." />
          ) : list.length === 0 ? (
            <Empty
              icon={<Bell weight="duotone" size={20} />}
              title="No deliveries"
              hint={
                stateFilter
                  ? `No deliveries in state "${stateFilter}".`
                  : "Nothing in the queue for this user."
              }
            />
          ) : (
            <div>
              <div className="hidden md:grid grid-cols-[24px_1.4fr_70px_70px_70px_120px_140px_200px] gap-3 px-3 py-2 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--color-muted)] border-b border-[var(--color-border)]">
                <div />
                <div>action</div>
                <div className="text-right">score</div>
                <div>state</div>
                <div>channel</div>
                <div>cooldown</div>
                <div>created</div>
                <div className="text-right">act</div>
              </div>
              <div>
                {list.map((d) => (
                  <DeliveryRow
                    key={d.id}
                    d={d}
                    busy={busy === d.id}
                    error={errors[d.id]}
                    onAck={ack}
                  />
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function DeliveryRow({
  d,
  busy,
  error,
  onAck,
}: {
  d: DeliveryOut;
  busy: boolean;
  error?: string;
  onAck: (
    id: number,
    state: "acted" | "snoozed" | "dismissed" | "sent",
    snoozeMin?: number,
  ) => void;
}) {
  const tone = STATE_TONE[d.state] ?? "neutral";
  const rail = STATE_RAIL[d.state] ?? "rail-neutral";
  const final = ["acted", "dismissed", "expired"].includes(d.state);

  return (
    <div
      className={cn(
        "border-b border-[var(--color-border)] last:border-b-0",
        rail,
      )}
    >
      <div className="md:grid md:grid-cols-[24px_1.4fr_70px_70px_70px_120px_140px_200px] md:gap-3 px-3 py-2 items-center text-[13px]">
        <div className="hidden md:block text-[10px] font-mono text-[var(--color-subtle)] tabular-nums">
          #{d.id}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-mono truncate">{d.action}</div>
          {d.reason ? (
            <div className="text-[11px] text-[var(--color-muted)] truncate">
              {d.reason}
            </div>
          ) : null}
          {d.target_dose_ids.length ? (
            <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[var(--color-subtle)] mt-0.5">
              {d.target_dose_ids.length} dose{d.target_dose_ids.length === 1 ? "" : "s"}
              <span className="ml-1 text-[var(--color-subtle)]">
                {d.target_dose_ids.slice(0, 2).join(" ")}
                {d.target_dose_ids.length > 2 ? " …" : ""}
              </span>
            </div>
          ) : null}
        </div>
        <div className="text-right font-mono tabular-nums">
          {fmtPct(d.score, 0)}
        </div>
        <div>
          <Badge tone={tone}>{d.state}</Badge>
        </div>
        <div>
          <MonoChip>{d.channel}</MonoChip>
        </div>
        <div>
          <CooldownChip until={d.snooze_until} state={d.state} />
        </div>
        <div className="text-[11px] font-mono text-[var(--color-muted)] tabular-nums">
          <div>{fmtRelative(d.created_at)}</div>
          <div className="text-[var(--color-subtle)]">{fmtTime(d.created_at)}</div>
        </div>
        <div className="flex justify-end gap-1 flex-wrap">
          <Button
            variant="ghost"
            onClick={() => onAck(d.id, "sent")}
            disabled={busy || final}
            title="Mark sent"
            className="px-2 py-1"
          >
            {busy ? (
              <Spinner className="animate-spin" weight="duotone" size={12} />
            ) : (
              <Check weight="duotone" size={12} />
            )}
            sent
          </Button>
          <Button
            variant="ghost"
            onClick={() => onAck(d.id, "snoozed", 30)}
            disabled={busy || final}
            title="Snooze 30 min"
            className="px-2 py-1"
          >
            <Moon weight="duotone" size={12} />
            30m
          </Button>
          <Button
            variant="ghost"
            onClick={() => onAck(d.id, "dismissed")}
            disabled={busy || final}
            title="Dismiss"
            className="px-2 py-1"
          >
            <X weight="duotone" size={12} />
            drop
          </Button>
          <Button
            variant="accent"
            onClick={() => onAck(d.id, "acted")}
            disabled={busy || final}
            title="Mark acted"
            className="px-2 py-1"
          >
            <HandPalm weight="duotone" size={12} />
            act
          </Button>
        </div>
      </div>
      {error ? (
        <div className="px-3 pb-2 text-[11px] font-mono text-[var(--color-danger)]">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/* Live countdown chip. Updates once per second while a snooze is active. */
function CooldownChip({
  until,
  state,
}: {
  until: string | null;
  state: string;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!until) return;
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [until]);

  if (!until) {
    return <MonoChip>{state === "queued" ? "ready" : "—"}</MonoChip>;
  }
  const ms = new Date(until).getTime() - Date.now();
  if (ms <= 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-[var(--color-low)]/40 bg-[var(--color-low)]/10 px-1.5 py-[1px] text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--color-low)] tabular-nums">
        <Clock weight="duotone" size={10} />
        ready
      </span>
    );
  }
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const label = m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
  return (
    <span className="inline-flex items-center gap-1 rounded border border-[var(--color-mid)]/40 bg-[var(--color-mid)]/10 px-1.5 py-[1px] text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--color-mid)] tabular-nums">
      <Clock weight="duotone" size={10} />
      {label}
    </span>
  );
}
