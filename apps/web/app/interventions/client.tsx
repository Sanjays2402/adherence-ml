"use client";

import useSWR, { mutate as globalMutate } from "swr";
import { useState } from "react";
import {
  MagnifyingGlass,
  ArrowsClockwise,
  Bell,
  Check,
  Moon,
  X,
  HandPalm,
  Spinner,
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
} from "@/components/ui/primitives";
import type { DeliveryOut } from "@/lib/types";
import { fmtTime, fmtPct, cn } from "@/lib/utils";

const fetcher = (url: string) => fetch(url).then(async (r) => {
  const j = await r.json();
  if (!r.ok) throw new Error(typeof j?.detail === "string" ? j.detail : r.statusText);
  return j;
});

const STATE_TONE: Record<string, "neutral" | "success" | "warn" | "danger" | "accent"> = {
  queued: "accent",
  sent: "neutral",
  snoozed: "warn",
  dismissed: "neutral",
  acted: "success",
  expired: "danger",
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

  async function ack(id: number, state: "acted" | "snoozed" | "dismissed" | "sent", snoozeMinutes?: number) {
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
      if (!res.ok) throw new Error(typeof j?.detail === "string" ? j.detail : `failed (${res.status})`);
      await mutate();
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(null);
    }
  }

  const list = data ?? [];

  return (
    <>
      <PageHeader
        title="Interventions"
        description="Queued and delivered actions per user. Ack updates the delivery state and feeds the cooldown engine."
        actions={
          <Button variant="ghost" onClick={() => mutate()} disabled={isValidating}>
            <ArrowsClockwise weight="duotone" size={14} />
            Refresh
          </Button>
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
              <div className="text-xs text-[var(--color-muted)]">User ID</div>
              <Input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder="user-id"
              />
            </label>
            <label className="space-y-1">
              <div className="text-xs text-[var(--color-muted)]">State</div>
              <select
                value={stateFilter}
                onChange={(e) => setStateFilter(e.target.value)}
                className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm"
              >
                {STATES.map((s) => (
                  <option key={s} value={s}>{s || "any"}</option>
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

        <Card>
          <CardHeader
            title={`Queue ${list.length ? `(${list.length})` : ""}`}
            hint={submittedUser ? `User ${submittedUser}` : undefined}
          />
          {isLoading && !data ? (
            <div className="p-4 space-y-2">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
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
                  : "Nothing in the queue for this user yet."
              }
            />
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
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
  onAck: (id: number, state: "acted" | "snoozed" | "dismissed" | "sent", snoozeMin?: number) => void;
}) {
  const tone = STATE_TONE[d.state] ?? "neutral";
  const final = ["acted", "dismissed", "expired"].includes(d.state);
  return (
    <div className="px-4 py-3 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-sm font-medium font-mono truncate">{d.action}</div>
          <Badge tone={tone}>{d.state}</Badge>
          <Badge tone="neutral">{d.channel}</Badge>
          <span className="text-xs text-[var(--color-muted)] tabular-nums">
            score {fmtPct(d.score, 0)}
          </span>
        </div>
        {d.reason ? (
          <p className="text-xs text-[var(--color-fg)]/80 mt-1">{d.reason}</p>
        ) : null}
        <div className="text-xs text-[var(--color-muted)] mt-1 flex flex-wrap gap-x-3 gap-y-1">
          <span>created {fmtTime(d.created_at)}</span>
          <span>updated {fmtTime(d.updated_at)}</span>
          {d.snooze_until ? <span>snooze until {fmtTime(d.snooze_until)}</span> : null}
          {d.acked_by ? <span>ack by {d.acked_by}</span> : null}
          {d.target_dose_ids.length ? (
            <span>doses {d.target_dose_ids.slice(0, 4).join(", ")}{d.target_dose_ids.length > 4 ? "…" : ""}</span>
          ) : null}
        </div>
        {error ? <div className="mt-2 text-xs text-[var(--color-danger)]">{error}</div> : null}
      </div>
      <div className="flex flex-col items-end gap-1.5 shrink-0">
        <div className="flex gap-1.5">
          <Button
            variant="ghost"
            onClick={() => onAck(d.id, "sent")}
            disabled={busy || final}
            title="Mark sent"
          >
            {busy ? <Spinner className="animate-spin" weight="duotone" size={14} /> : <Check weight="duotone" size={14} />}
            Sent
          </Button>
          <Button
            variant="ghost"
            onClick={() => onAck(d.id, "snoozed", 30)}
            disabled={busy || final}
            title="Snooze 30 min"
          >
            <Moon weight="duotone" size={14} />
            30m
          </Button>
        </div>
        <div className="flex gap-1.5">
          <Button
            variant="ghost"
            onClick={() => onAck(d.id, "dismissed")}
            disabled={busy || final}
            title="Dismiss"
          >
            <X weight="duotone" size={14} />
            Dismiss
          </Button>
          <Button
            onClick={() => onAck(d.id, "acted")}
            disabled={busy || final}
            title="Mark acted"
          >
            <HandPalm weight="duotone" size={14} />
            Acted
          </Button>
        </div>
      </div>
    </div>
  );
}
