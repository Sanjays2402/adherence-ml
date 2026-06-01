"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  Plus,
  Key,
  ShieldCheck,
  ShieldWarning,
  ArrowsClockwise,
  ClipboardText,
  Archive,
  Vault,
  DownloadSimple,
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

type Entry = {
  id: number;
  tenant_id: string;
  name: string;
  kind: string;
  system_of_record: string;
  credential_kind: string;
  owner_email: string;
  scopes: string[];
  vault_managed: boolean;
  rotation_cadence_days: number;
  review_cadence_days: number;
  last_rotated_at: string | null;
  last_reviewed_at: string | null;
  last_used_at: string | null;
  next_rotation_due_at: string;
  next_review_due_at: string;
  rotation_overdue: boolean;
  review_overdue: boolean;
  dormant_days: number | null;
  status: string;
  notes: string | null;
  version: number;
  archived_at: string | null;
};

type Summary = {
  active_count?: number;
  archived_count?: number;
  rotation_overdue_count?: number;
  review_overdue_count?: number;
  vault_managed_count?: number;
};

type ListResp = Summary & {
  tenant_id: string;
  entries: Entry[];
};

const KINDS = [
  "ci",
  "etl",
  "integration",
  "webhook",
  "monitor",
  "daemon",
  "backup",
  "other",
];
const CREDENTIAL_KINDS = [
  "api_key",
  "oauth_client",
  "oidc_sa",
  "ssh_key",
  "certificate",
  "shared_secret",
];

const fetcher = async (url: string): Promise<ListResp> => {
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body?.detail || `request failed (${r.status})`);
  }
  return r.json();
};

function fmtDate(iso: string | null): string {
  if (!iso) return "never";
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

export default function ServiceAccountsClient() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const url = `/api/service-accounts?include_archived=${includeArchived}`;
  const { data, error, isLoading, mutate } = useSWR<ListResp>(url, fetcher);

  const [showForm, setShowForm] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    kind: "ci",
    system_of_record: "",
    credential_kind: "api_key",
    owner_email: "",
    scopes: "",
    vault_managed: false,
    rotation_cadence_days: 90,
    review_cadence_days: 180,
  });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const onCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      setSubmitting(true);
      try {
        const scopes = form.scopes
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const r = await fetch("/api/service-accounts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: form.name.trim(),
            kind: form.kind,
            system_of_record: form.system_of_record.trim(),
            credential_kind: form.credential_kind,
            owner_email: form.owner_email.trim(),
            scopes,
            vault_managed: form.vault_managed,
            rotation_cadence_days: Number(form.rotation_cadence_days),
            review_cadence_days: Number(form.review_cadence_days),
          }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.detail || `request failed (${r.status})`);
        }
        setForm({
          name: "",
          kind: "ci",
          system_of_record: "",
          credential_kind: "api_key",
          owner_email: "",
          scopes: "",
          vault_managed: false,
          rotation_cadence_days: 90,
          review_cadence_days: 180,
        });
        setShowForm(false);
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed to create");
      } finally {
        setSubmitting(false);
      }
    },
    [form, mutate],
  );

  const doAction = useCallback(
    async (id: number, path: string, confirmMsg?: string) => {
      if (confirmMsg && !window.confirm(confirmMsg)) return;
      setBusyId(id);
      setOpError(null);
      try {
        const r = await fetch(`/api/service-accounts/${id}/${path}`, {
          method: "POST",
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.detail || `request failed (${r.status})`);
        }
        await mutate();
      } catch (err) {
        setOpError(err instanceof Error ? err.message : `failed to ${path}`);
      } finally {
        setBusyId(null);
      }
    },
    [mutate],
  );

  const entries = data?.entries ?? [];
  const tenant = data?.tenant_id ?? "default";

  const sorted = useMemo(
    () =>
      [...entries].sort((a, b) => {
        const aBad = (a.rotation_overdue ? 2 : 0) + (a.review_overdue ? 1 : 0);
        const bBad = (b.rotation_overdue ? 2 : 0) + (b.review_overdue ? 1 : 0);
        if (aBad !== bBad) return bBad - aBad;
        return a.name.localeCompare(b.name);
      }),
    [entries],
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
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
            Service accounts
          </h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Workspace <span className="font-mono">{tenant}</span> register of
            non-human identities. CI runners, ETL jobs, integrations,
            monitoring, daemons. Owner, scopes, rotation, last used.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href="/api/service-accounts/export.csv"
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            <DownloadSimple size={14} weight="duotone" aria-hidden />
            export csv
          </a>
          <Button onClick={() => setShowForm((v) => !v)}>
            <Plus size={14} weight="duotone" aria-hidden />
            {showForm ? "cancel" : "new entry"}
          </Button>
        </div>
      </header>

      {data ? (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="active" value={data.active_count ?? 0} />
          <StatTile
            label="rotation overdue"
            value={data.rotation_overdue_count ?? 0}
            tone={(data.rotation_overdue_count ?? 0) > 0 ? "warn" : "ok"}
          />
          <StatTile
            label="review overdue"
            value={data.review_overdue_count ?? 0}
            tone={(data.review_overdue_count ?? 0) > 0 ? "warn" : "ok"}
          />
          <StatTile
            label="vault managed"
            value={data.vault_managed_count ?? 0}
          />
        </div>
      ) : null}

      {showForm ? (
        <Card className="mb-6">
          <CardHeader
            title="Register a service account"
            hint="Names a non-human identity, its owner, system of record, credential kind, scopes, and cadence."
            right={<Key size={16} weight="duotone" aria-hidden />}
          />
          <form onSubmit={onCreate} className="grid gap-3 p-4 sm:grid-cols-2">
            <Input
              type="text"
              placeholder="ci-github-actions"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              aria-label="Name"
              required
            />
            <Input
              type="email"
              placeholder="owner@acme.example"
              value={form.owner_email}
              onChange={(e) =>
                setForm({ ...form, owner_email: e.target.value })
              }
              aria-label="Owner email"
              required
            />
            <Select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
              aria-label="Kind"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
            <Select
              value={form.credential_kind}
              onChange={(e) =>
                setForm({ ...form, credential_kind: e.target.value })
              }
              aria-label="Credential kind"
            >
              {CREDENTIAL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
            <Input
              type="text"
              placeholder="github.com/acme/adherence"
              value={form.system_of_record}
              onChange={(e) =>
                setForm({ ...form, system_of_record: e.target.value })
              }
              aria-label="System of record"
              required
            />
            <Input
              type="text"
              placeholder="scopes (comma separated)"
              value={form.scopes}
              onChange={(e) => setForm({ ...form, scopes: e.target.value })}
              aria-label="Scopes"
            />
            <Input
              type="number"
              min={7}
              max={730}
              value={form.rotation_cadence_days}
              onChange={(e) =>
                setForm({
                  ...form,
                  rotation_cadence_days: Number(e.target.value),
                })
              }
              aria-label="Rotation cadence (days)"
            />
            <Input
              type="number"
              min={30}
              max={730}
              value={form.review_cadence_days}
              onChange={(e) =>
                setForm({
                  ...form,
                  review_cadence_days: Number(e.target.value),
                })
              }
              aria-label="Review cadence (days)"
            />
            <label className="col-span-full inline-flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
              <input
                type="checkbox"
                checked={form.vault_managed}
                onChange={(e) =>
                  setForm({ ...form, vault_managed: e.target.checked })
                }
              />
              secret stored in a vault
            </label>
            <div className="col-span-full flex items-center justify-end gap-2">
              <Button
                type="submit"
                disabled={submitting || !form.name || !form.owner_email}
              >
                {submitting ? "creating" : "create"}
              </Button>
            </div>
            {formError ? <ErrorBox message={formError} /> : null}
          </form>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Register"
          hint={
            includeArchived
              ? "Showing archived entries as well."
              : "Active and suspended entries. Sorted by overdue first."
          }
          right={
            <label className="inline-flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
              />
              show archived
            </label>
          }
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
              <Skeleton className="h-16 w-full" />
            </div>
          ) : sorted.length === 0 ? (
            <div className="p-4">
              <Empty
                title="No service accounts yet"
                hint="Register one to document a CI runner, ETL pipeline, or integration."
              />
            </div>
          ) : (
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {sorted.map((e) => (
                <li key={e.id} className="p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-medium text-neutral-900 dark:text-neutral-50">
                          {e.name}
                        </span>
                        <Badge tone="neutral">{e.kind}</Badge>
                        <Badge tone="neutral">{e.credential_kind}</Badge>
                        {e.vault_managed ? (
                          <Badge tone="success">
                            <Vault size={11} weight="duotone" aria-hidden />
                            vault
                          </Badge>
                        ) : null}
                        {e.status !== "active" ? (
                          <Badge tone="warn">{e.status}</Badge>
                        ) : null}
                        {e.rotation_overdue ? (
                          <Badge tone="warn">
                            <ShieldWarning size={11} weight="duotone" aria-hidden />
                            rotation overdue
                          </Badge>
                        ) : null}
                        {e.review_overdue ? (
                          <Badge tone="warn">
                            <ShieldWarning size={11} weight="duotone" aria-hidden />
                            review overdue
                          </Badge>
                        ) : null}
                        {!e.rotation_overdue &&
                        !e.review_overdue &&
                        e.status === "active" ? (
                          <Badge tone="success">
                            <ShieldCheck size={11} weight="duotone" aria-hidden />
                            healthy
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 truncate text-xs text-neutral-500 dark:text-neutral-400">
                        owner {e.owner_email} {"\u00b7"} system{" "}
                        {e.system_of_record}
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-600 sm:grid-cols-4 dark:text-neutral-400">
                        <span>rotated {fmtDate(e.last_rotated_at)}</span>
                        <span>reviewed {fmtDate(e.last_reviewed_at)}</span>
                        <span>used {fmtDate(e.last_used_at)}</span>
                        <span>
                          dormant{" "}
                          {e.dormant_days == null ? "n/a" : `${e.dormant_days}d`}
                        </span>
                      </div>
                      {e.scopes.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {e.scopes.map((s) => (
                            <span
                              key={s}
                              className="rounded border border-neutral-200 px-1.5 py-0.5 font-mono text-[10px] text-neutral-600 dark:border-neutral-800 dark:text-neutral-400"
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    {e.archived_at == null ? (
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <Button
                          variant="ghost"
                          onClick={() => doAction(e.id, "rotate")}
                          disabled={busyId === e.id}
                          aria-label={`Record rotation for ${e.name}`}
                        >
                          <ArrowsClockwise
                            size={13}
                            weight="duotone"
                            aria-hidden
                          />
                          rotated
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => doAction(e.id, "review")}
                          disabled={busyId === e.id}
                          aria-label={`Record review for ${e.name}`}
                        >
                          <ClipboardText
                            size={13}
                            weight="duotone"
                            aria-hidden
                          />
                          reviewed
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            doAction(
                              e.id,
                              "archive",
                              `Archive ${e.name}? This removes it from the active register.`,
                            )
                          }
                          disabled={busyId === e.id}
                          aria-label={`Archive ${e.name}`}
                        >
                          <Archive size={13} weight="duotone" aria-hidden />
                          archive
                        </Button>
                      </div>
                    ) : (
                      <Badge tone="neutral">archived</Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {opError ? (
        <div className="mt-4">
          <ErrorBox message={opError} />
        </div>
      ) : null}

      <p className="mt-6 text-xs text-neutral-500 dark:text-neutral-400">
        Mutations require admin role with an active MFA challenge. Every change
        is written to the admin audit log with actor, action, target, IP, and
        before/after diff.
      </p>
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "warn";
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {label}
      </div>
      <div
        className={
          "mt-0.5 text-xl font-semibold tabular-nums " +
          (tone === "warn"
            ? "text-amber-600 dark:text-amber-400"
            : "text-neutral-900 dark:text-neutral-50")
        }
      >
        {value}
      </div>
    </div>
  );
}
