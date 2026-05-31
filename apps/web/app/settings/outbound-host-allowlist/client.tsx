"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ShieldCheck,
  ShieldWarning,
  ArrowLeft,
  Plus,
  Trash,
  Plugs,
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
  host: string;
  label: string | null;
  created_by: string | null;
  created_at: string;
};

type ListResp = {
  tenant_id: string;
  enforced: boolean;
  entries: Entry[];
};

const fetcher = async (url: string): Promise<ListResp> => {
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body?.detail || `request failed (${r.status})`);
  }
  return r.json();
};

function fmtTime(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z";
  } catch {
    return iso;
  }
}

export default function OutboundHostAllowlistClient() {
  const { data, error, isLoading, mutate } = useSWR<ListResp>(
    "/api/outbound-host-allowlist",
    fetcher,
  );
  const [host, setHost] = useState("");
  const [label, setLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const onAdd = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      setSubmitting(true);
      try {
        const r = await fetch("/api/outbound-host-allowlist", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            host: host.trim(),
            label: label.trim() || null,
          }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.detail || `request failed (${r.status})`);
        }
        setHost("");
        setLabel("");
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed to add");
      } finally {
        setSubmitting(false);
      }
    },
    [host, label, mutate],
  );

  const onRemove = useCallback(
    async (id: number) => {
      setDeletingId(id);
      try {
        const r = await fetch(`/api/outbound-host-allowlist/${id}`, {
          method: "DELETE",
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.detail || `request failed (${r.status})`);
        }
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed to remove");
      } finally {
        setDeletingId(null);
      }
    },
    [mutate],
  );

  const entries = data?.entries ?? [];
  const enforced = Boolean(data?.enforced);
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
            Outbound webhook host allowlist
          </h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Restrict outbound webhook destinations for workspace{" "}
            <span className="font-mono">{tenant}</span> to a list of approved
            hostnames. Empty list means the workspace gate is off (the
            deployment-wide policy still applies).
          </p>
        </div>
        <div className="shrink-0">
          {isLoading ? (
            <Skeleton className="h-6 w-28" />
          ) : enforced ? (
            <Badge tone="success">
              <ShieldCheck size={12} weight="duotone" aria-hidden />
              enforced
            </Badge>
          ) : (
            <Badge tone="warn">
              <ShieldWarning size={12} weight="duotone" aria-hidden />
              not enforced
            </Badge>
          )}
        </div>
      </header>

      <Card className="mb-6">
        <CardHeader
          title="Add host"
          hint={
            "Exact hostname (api.partner.com) or leading-dot wildcard for any subdomain (.partner.com)."
          }
          right={<Plus size={16} weight="duotone" aria-hidden />}
        />
        <form
          onSubmit={onAdd}
          className="grid gap-3 p-4 sm:grid-cols-[2fr_2fr_auto]"
        >
          <Input
            type="text"
            placeholder="api.partner.com"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            aria-label="Hostname"
            required
          />
          <Input
            type="text"
            placeholder="prod partner"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label="Label (optional)"
            maxLength={128}
          />
          <Button
            type="submit"
            disabled={submitting || host.trim().length === 0}
          >
            {submitting ? "adding" : "add"}
          </Button>
        </form>
        {formError ? (
          <div className="px-4 pb-4">
            <ErrorBox message={formError} />
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title="Allowed destinations"
          hint={
            enforced
              ? "Only outbound webhooks targeting these hosts are accepted, checked at create time and on every dispatch."
              : "No rules yet. Add one to lock outbound deliveries to known partners."
          }
          right={<Plugs size={16} weight="duotone" aria-hidden />}
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
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : entries.length === 0 ? (
            <div className="p-4">
              <Empty
                title="No hosts yet"
                hint="Add a hostname above to start enforcing the outbound allowlist."
              />
            </div>
          ) : (
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {entries.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="font-mono text-sm text-neutral-900 dark:text-neutral-50">
                      {e.host}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
                      {e.label ? `${e.label} \u00b7 ` : ""}
                      added by {e.created_by ?? "unknown"} at{" "}
                      {fmtTime(e.created_at)}
                    </div>
                  </div>
                  <div className="shrink-0">
                    <Button
                      variant="ghost"
                      onClick={() => onRemove(e.id)}
                      disabled={deletingId === e.id}
                      aria-label={`Remove ${e.host}`}
                    >
                      <Trash size={14} weight="duotone" aria-hidden />
                      {deletingId === e.id ? "removing" : "remove"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <p className="mt-6 text-xs text-neutral-500 dark:text-neutral-400">
        Blocked subscriptions return HTTP 400 with{" "}
        <span className="font-mono">code: outbound_blocked</span>. Dispatch-time
        refusals are written to the webhook delivery log with{" "}
        <span className="font-mono">state: blocked</span> so the audit trail
        captures every attempt.
      </p>
    </div>
  );
}
