"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  Plus,
  Trash,
  UsersThree,
  ShieldCheck,
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

type Mapping = {
  id: number;
  tenant_id: string;
  group_claim: string;
  role: "admin" | "service" | "viewer";
  priority: number;
  note: string | null;
  created_by: string | null;
  created_at: string | null;
};

type ListResp = {
  tenant_id: string;
  items: Mapping[];
  max_group_len: number;
  max_note_len: number;
  valid_roles: string[];
};

const fetcher = async (url: string): Promise<ListResp> => {
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body?.detail || `request failed (${r.status})`);
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

function roleTone(role: string): "success" | "warn" | "neutral" {
  if (role === "admin") return "warn";
  if (role === "service") return "success";
  return "neutral";
}

export default function SsoGroupRolesClient() {
  const { data, error, isLoading, mutate } = useSWR<ListResp>(
    "/api/sso-group-roles",
    fetcher,
  );
  const [groupClaim, setGroupClaim] = useState("");
  const [role, setRole] = useState<"admin" | "service" | "viewer">("viewer");
  const [priority, setPriority] = useState<number>(100);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const onAdd = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      setSubmitting(true);
      try {
        const r = await fetch("/api/sso-group-roles", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            group_claim: groupClaim.trim(),
            role,
            priority: Number.isFinite(priority) ? priority : 100,
            note: note.trim() || null,
          }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.detail || `request failed (${r.status})`);
        }
        setGroupClaim("");
        setNote("");
        setPriority(100);
        setRole("viewer");
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed to add");
      } finally {
        setSubmitting(false);
      }
    },
    [groupClaim, role, priority, note, mutate],
  );

  const onRemove = useCallback(
    async (id: number) => {
      setDeletingId(id);
      try {
        const r = await fetch(`/api/sso-group-roles/${id}`, {
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

  const items = data?.items ?? [];
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
            SSO group roles
          </h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Map identity provider groups to internal roles for workspace{" "}
            <span className="font-mono">{tenant}</span>. A group match always
            wins over the deployment wide email-domain map.
          </p>
        </div>
        <div className="shrink-0">
          {isLoading ? (
            <Skeleton className="h-6 w-28" />
          ) : items.length > 0 ? (
            <Badge tone="success">
              <ShieldCheck size={12} weight="duotone" aria-hidden />
              {items.length} active
            </Badge>
          ) : (
            <Badge tone="neutral">no mappings</Badge>
          )}
        </div>
      </header>

      <Card className="mb-6">
        <CardHeader
          title="Add mapping"
          hint="Group claim values are matched against the groups, roles, wids, or cognito:groups claim on the verified ID token."
          right={<Plus size={16} weight="duotone" aria-hidden />}
        />
        <form
          onSubmit={onAdd}
          className="grid gap-3 p-4 sm:grid-cols-[2fr_1fr_1fr_auto]"
        >
          <Input
            type="text"
            placeholder="okta:adherence-admins"
            value={groupClaim}
            onChange={(e) => setGroupClaim(e.target.value)}
            aria-label="Group claim"
            maxLength={255}
            required
          />
          <select
            value={role}
            onChange={(e) =>
              setRole(e.target.value as "admin" | "service" | "viewer")
            }
            aria-label="Role"
            className="h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          >
            <option value="viewer">viewer</option>
            <option value="service">service</option>
            <option value="admin">admin</option>
          </select>
          <Input
            type="number"
            min={0}
            max={10000}
            value={priority}
            onChange={(e) => setPriority(Number.parseInt(e.target.value, 10))}
            aria-label="Priority"
          />
          <Button
            type="submit"
            disabled={submitting || groupClaim.trim().length === 0}
          >
            {submitting ? "adding" : "add"}
          </Button>
          <Input
            type="text"
            placeholder="note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Note"
            maxLength={255}
            className="sm:col-span-4"
          />
        </form>
        {formError ? (
          <div className="px-4 pb-4">
            <ErrorBox message={formError} />
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title="Active mappings"
          hint="Highest priority wins when an identity belongs to several mapped groups."
          right={<UsersThree size={16} weight="duotone" aria-hidden />}
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
          ) : items.length === 0 ? (
            <div className="p-4">
              <Empty
                title="No mappings yet"
                hint="Add a group claim above to provision SSO access by IdP group."
              />
            </div>
          ) : (
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {items.map((m) => (
                <li
                  key={m.id}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm text-neutral-900 dark:text-neutral-50">
                        {m.group_claim}
                      </span>
                      <Badge tone={roleTone(m.role)}>{m.role}</Badge>
                      <span className="text-xs text-neutral-500 dark:text-neutral-400">
                        priority {m.priority}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
                      {m.note ? `${m.note} \u00b7 ` : ""}
                      added by {m.created_by ?? "unknown"} at{" "}
                      {fmtTime(m.created_at)}
                    </div>
                  </div>
                  <div className="shrink-0">
                    <Button
                      variant="ghost"
                      onClick={() => onRemove(m.id)}
                      disabled={deletingId === m.id}
                      aria-label={`Remove ${m.group_claim}`}
                    >
                      <Trash size={14} weight="duotone" aria-hidden />
                      {deletingId === m.id ? "removing" : "remove"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <p className="mt-6 text-xs text-neutral-500 dark:text-neutral-400">
        Mutations require admin role plus an MFA step-up. Each change is
        written to the admin audit log with actor, target, and tenant.
      </p>
    </div>
  );
}
