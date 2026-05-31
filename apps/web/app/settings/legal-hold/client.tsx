"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  Gavel,
  LockKey,
  LockKeyOpen,
  ShieldCheck,
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
  Skeleton,
} from "@/components/ui/primitives";

type Entry = {
  id: number;
  tenant_id: string;
  label: string | null;
  reason: string;
  ticket_ref: string | null;
  placed_by: string;
  placed_at: string;
  released_by: string | null;
  released_at: string | null;
  release_reason: string | null;
  active: boolean;
};

type ListResp = {
  tenant_id: string;
  on_hold: boolean;
  active_count: number;
  entries: Entry[];
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

export default function LegalHoldClient() {
  const { data, error, isLoading, mutate } = useSWR<ListResp>(
    "/api/legal-holds",
    fetcher,
  );
  const [reason, setReason] = useState("");
  const [label, setLabel] = useState("");
  const [ticket, setTicket] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [releasingId, setReleasingId] = useState<number | null>(null);
  const [releaseReason, setReleaseReason] = useState<Record<number, string>>(
    {},
  );

  const onPlace = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      if (reason.trim().length < 10) {
        setFormError("reason must be at least 10 characters");
        return;
      }
      setSubmitting(true);
      try {
        const r = await fetch("/api/legal-holds", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reason: reason.trim(),
            label: label.trim() || null,
            ticket_ref: ticket.trim() || null,
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
        setReason("");
        setLabel("");
        setTicket("");
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed to place");
      } finally {
        setSubmitting(false);
      }
    },
    [reason, label, ticket, mutate],
  );

  const onRelease = useCallback(
    async (id: number) => {
      setReleasingId(id);
      setFormError(null);
      try {
        const r = await fetch(`/api/legal-holds/${id}/release`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            release_reason: (releaseReason[id] || "").trim() || null,
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
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed to release");
      } finally {
        setReleasingId(null);
      }
    },
    [releaseReason, mutate],
  );

  const entries = data?.entries ?? [];
  const onHold = Boolean(data?.on_hold);
  const tenant = data?.tenant_id ?? "default";

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="mb-6">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          <ArrowLeft size={14} weight="duotone" aria-hidden />
          back to settings
        </Link>
      </div>

      <header className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
            Legal hold
          </h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Freeze deletions on workspace{" "}
            <span className="font-mono">{tenant}</span> while a
            litigation, audit, or regulator preservation order is open.
            GDPR erasure and retention sweeps return{" "}
            <span className="font-mono">423 Locked</span> until released.
          </p>
        </div>
        <div className="shrink-0">
          {isLoading ? (
            <Skeleton className="h-6 w-28" />
          ) : onHold ? (
            <Badge tone="warn">
              <LockKey size={12} weight="duotone" aria-hidden />
              on hold
            </Badge>
          ) : (
            <Badge tone="success">
              <ShieldCheck size={12} weight="duotone" aria-hidden />
              no active hold
            </Badge>
          )}
        </div>
      </header>

      {onHold ? (
        <Card className="mb-6 border-amber-400/40 bg-amber-50/40 dark:border-amber-500/30 dark:bg-amber-950/20">
          <div className="flex items-start gap-3 p-4">
            <Warning
              size={18}
              weight="duotone"
              className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
              aria-hidden
            />
            <div className="text-sm text-neutral-800 dark:text-neutral-200">
              <div className="font-medium">
                Deletions are paused for this workspace.
              </div>
              <div className="mt-1 text-neutral-600 dark:text-neutral-400">
                {data?.active_count ?? 0} active hold(s). User data
                exports and dry-run previews remain available; only
                hard-deletes are blocked.
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      <Card className="mb-6">
        <CardHeader
          title="Place hold"
          hint={
            "Requires admin role and a verified MFA challenge. Reason is recorded immutably."
          }
          right={<Gavel size={16} weight="duotone" aria-hidden />}
        />
        <form onSubmit={onPlace} className="grid gap-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              type="text"
              placeholder="SUP-4218"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              aria-label="Label (optional)"
              maxLength={128}
            />
            <Input
              type="text"
              placeholder="JIRA-LEGAL-77"
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              aria-label="Ticket ref (optional)"
              maxLength={128}
            />
          </div>
          <textarea
            placeholder="Counsel directive, ticket summary, scope of the preservation order. Min 10 chars."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-label="Reason"
            required
            minLength={10}
            maxLength={4096}
            rows={4}
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] font-mono outline-none placeholder:text-[var(--color-subtle)] focus:border-[var(--color-accent)]/70 focus:shadow-[0_0_0_3px_var(--color-accent-soft)] transition-shadow"
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {reason.length}/4096 characters
            </p>
            <Button
              type="submit"
              disabled={submitting || reason.trim().length < 10}
            >
              {submitting ? "placing" : "place hold"}
            </Button>
          </div>
        </form>
        {formError ? (
          <div className="px-4 pb-4">
            <ErrorBox message={formError} />
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title="Hold history"
          hint={
            "All holds, active and released. Active holds appear first and gate every delete endpoint for this workspace."
          }
          right={<LockKeyOpen size={16} weight="duotone" aria-hidden />}
        />
        <div className="border-t border-neutral-200 dark:border-neutral-800">
          {error ? (
            <div className="p-4">
              <ErrorBox
                message={
                  error instanceof Error ? error.message : "failed to load"
                }
              />
            </div>
          ) : isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : entries.length === 0 ? (
            <div className="p-4">
              <Empty
                title="No holds on record"
                hint="Place a hold above to freeze GDPR erasure and retention sweeps for this workspace."
              />
            </div>
          ) : (
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {entries.map((e) => (
                <li key={e.id} className="space-y-3 p-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm text-neutral-900 dark:text-neutral-50">
                          #{e.id}
                          {e.label ? ` \u00b7 ${e.label}` : ""}
                        </span>
                        {e.active ? (
                          <Badge tone="warn">
                            <LockKey
                              size={12}
                              weight="duotone"
                              aria-hidden
                            />
                            active
                          </Badge>
                        ) : (
                          <Badge tone="success">
                            <LockKeyOpen
                              size={12}
                              weight="duotone"
                              aria-hidden
                            />
                            released
                          </Badge>
                        )}
                        {e.ticket_ref ? (
                          <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">
                            {e.ticket_ref}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                        placed by {e.placed_by} at {fmtTime(e.placed_at)}
                        {e.released_at
                          ? ` \u00b7 released by ${e.released_by ?? "unknown"} at ${fmtTime(e.released_at)}`
                          : ""}
                      </div>
                    </div>
                  </div>
                  <div className="rounded border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-300">
                    {e.reason}
                  </div>
                  {e.release_reason ? (
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">
                      release note: {e.release_reason}
                    </div>
                  ) : null}
                  {e.active ? (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Input
                        type="text"
                        placeholder="release reason (optional)"
                        value={releaseReason[e.id] ?? ""}
                        onChange={(ev) =>
                          setReleaseReason((m) => ({
                            ...m,
                            [e.id]: ev.target.value,
                          }))
                        }
                        aria-label={`Release reason for hold ${e.id}`}
                        maxLength={4096}
                      />
                      <Button
                        variant="ghost"
                        onClick={() => onRelease(e.id)}
                        disabled={releasingId === e.id}
                        aria-label={`Release hold ${e.id}`}
                      >
                        <LockKeyOpen
                          size={14}
                          weight="duotone"
                          aria-hidden
                        />
                        {releasingId === e.id ? "releasing" : "release"}
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <p className="mt-6 text-xs text-neutral-500 dark:text-neutral-400">
        Blocked deletes return HTTP 423 with{" "}
        <span className="font-mono">code: legal_hold_active</span> and the
        active hold id. Cross-tenant isolation is verified in{" "}
        <span className="font-mono">tests/unit/test_legal_hold.py</span>.
      </p>
    </div>
  );
}
