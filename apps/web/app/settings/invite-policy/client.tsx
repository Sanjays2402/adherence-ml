"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ShieldCheck,
  ShieldWarning,
  ArrowLeft,
  Plus,
  Trash,
  EnvelopeOpen,
  CheckCircle,
  XCircle,
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

type Rule = {
  id: number;
  tenant_id: string;
  kind: "allow" | "block";
  domain: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
};

type PolicyResp = {
  tenant_id: string;
  allowlist_enforced: boolean;
  blocklist_enforced: boolean;
  allow_domains: string[];
  block_domains: string[];
  rules: Rule[];
};

type EvalResp = {
  email: string;
  domain: string;
  allowed: boolean;
  code: string | null;
  message: string | null;
};

const fetcher = async (url: string): Promise<PolicyResp> => {
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(
      typeof body?.detail === "string" ? body.detail : `request failed (${r.status})`,
    );
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

function detailMessage(body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.detail === "string") return b.detail;
    if (b.detail && typeof b.detail === "object") {
      const d = b.detail as Record<string, unknown>;
      if (typeof d.message === "string") return d.message;
    }
    if (typeof b.message === "string") return b.message;
  }
  return "request failed";
}

export default function InvitePolicyClient() {
  const { data, error, isLoading, mutate } = useSWR<PolicyResp>(
    "/api/invite-policy",
    fetcher,
  );

  const [kind, setKind] = useState<"allow" | "block">("allow");
  const [domain, setDomain] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const [testEmail, setTestEmail] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<EvalResp | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const allowRules = useMemo(
    () => (data?.rules ?? []).filter((r) => r.kind === "allow"),
    [data],
  );
  const blockRules = useMemo(
    () => (data?.rules ?? []).filter((r) => r.kind === "block"),
    [data],
  );

  const onAdd = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      setSubmitting(true);
      try {
        const r = await fetch("/api/invite-policy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind,
            domain: domain.trim().toLowerCase(),
            note: note.trim() || null,
          }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(detailMessage(body));
        }
        setDomain("");
        setNote("");
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed to add");
      } finally {
        setSubmitting(false);
      }
    },
    [kind, domain, note, mutate],
  );

  const onRemove = useCallback(
    async (id: number) => {
      setDeletingId(id);
      try {
        const r = await fetch(`/api/invite-policy/${id}`, { method: "DELETE" });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(detailMessage(body));
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

  const onTest = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setTestError(null);
      setTestResult(null);
      setTesting(true);
      try {
        const r = await fetch("/api/invite-policy/evaluate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: testEmail.trim() }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(detailMessage(body));
        }
        setTestResult(body as EvalResp);
      } catch (err) {
        setTestError(err instanceof Error ? err.message : "test failed");
      } finally {
        setTesting(false);
      }
    },
    [testEmail],
  );

  const tenant = data?.tenant_id ?? "default";
  const allowEnforced = Boolean(data?.allowlist_enforced);
  const blockEnforced = Boolean(data?.blocklist_enforced);

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
            Invitation email domain policy
          </h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Restrict workspace{" "}
            <span className="font-mono">{tenant}</span> invitations to approved
            email domains and block known personal mail providers. Empty policy
            means no restriction. A matching block rule always wins over an
            allow rule. Acceptance is re-checked, so removing a domain after
            sending an invite still stops the join.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {isLoading ? (
            <Skeleton className="h-6 w-28" />
          ) : (
            <>
              {allowEnforced ? (
                <Badge tone="success">
                  <ShieldCheck size={12} weight="duotone" aria-hidden />
                  allowlist on
                </Badge>
              ) : (
                <Badge tone="warn">
                  <ShieldWarning size={12} weight="duotone" aria-hidden />
                  allowlist off
                </Badge>
              )}
              {blockEnforced ? (
                <Badge tone="success">
                  <ShieldCheck size={12} weight="duotone" aria-hidden />
                  blocklist on
                </Badge>
              ) : (
                <Badge tone="warn">
                  <ShieldWarning size={12} weight="duotone" aria-hidden />
                  blocklist off
                </Badge>
              )}
            </>
          )}
        </div>
      </header>

      <Card className="mb-6">
        <CardHeader
          title="Add rule"
          hint="Domain matches the apex and every subdomain. Examples: acme.com, contractor.acme.com, gmail.com"
          right={<Plus size={16} weight="duotone" aria-hidden />}
        />
        <form
          onSubmit={onAdd}
          className="grid gap-3 p-4 sm:grid-cols-[120px_2fr_2fr_auto]"
        >
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "allow" | "block")}
            aria-label="Rule kind"
            className="h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          >
            <option value="allow">allow</option>
            <option value="block">block</option>
          </select>
          <Input
            type="text"
            placeholder="acme.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            aria-label="Domain"
            required
            maxLength={253}
          />
          <Input
            type="text"
            placeholder="HR approved corporate domain"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Note (optional)"
            maxLength={256}
          />
          <Button type="submit" disabled={submitting || domain.trim().length === 0}>
            {submitting ? "adding" : "add"}
          </Button>
        </form>
        {formError ? (
          <div className="px-4 pb-4">
            <ErrorBox message={formError} />
          </div>
        ) : null}
      </Card>

      <Card className="mb-6">
        <CardHeader
          title="Test an email"
          hint="Dry-run an address against the current policy without sending an invite."
          right={<EnvelopeOpen size={16} weight="duotone" aria-hidden />}
        />
        <form
          onSubmit={onTest}
          className="grid gap-3 p-4 sm:grid-cols-[1fr_auto]"
        >
          <Input
            type="email"
            placeholder="someone@example.com"
            value={testEmail}
            onChange={(e) => setTestEmail(e.target.value)}
            aria-label="Email to test"
            required
          />
          <Button type="submit" disabled={testing || testEmail.trim().length < 3}>
            {testing ? "checking" : "check"}
          </Button>
        </form>
        {testError ? (
          <div className="px-4 pb-4">
            <ErrorBox message={testError} />
          </div>
        ) : null}
        {testResult ? (
          <div className="border-t border-neutral-200 px-4 py-3 text-sm dark:border-neutral-800">
            {testResult.allowed ? (
              <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                <CheckCircle size={16} weight="duotone" aria-hidden />
                <span>
                  Allowed: <span className="font-mono">{testResult.email}</span>{" "}
                  would be accepted by the current policy.
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-red-700 dark:text-red-400">
                <XCircle size={16} weight="duotone" aria-hidden />
                <span>
                  Blocked: <span className="font-mono">{testResult.email}</span>{" "}
                  ({testResult.code}) {testResult.message}
                </span>
              </div>
            )}
          </div>
        ) : null}
      </Card>

      {error ? (
        <Card className="mb-6">
          <div className="p-4">
            <ErrorBox
              message={
                error instanceof Error ? error.message : "failed to load"
              }
            />
          </div>
        </Card>
      ) : null}

      <RuleList
        title="Allowed domains"
        hint={
          allowEnforced
            ? "Only invitations to these domains can be created."
            : "No allow rules yet. Without any, every domain is permitted (unless explicitly blocked)."
        }
        loading={isLoading}
        rules={allowRules}
        deletingId={deletingId}
        onRemove={onRemove}
      />

      <div className="h-4" />

      <RuleList
        title="Blocked domains"
        hint={
          blockEnforced
            ? "Invitations to these domains are always rejected."
            : "No block rules yet. Add gmail.com, outlook.com, or any other domain you do not want in this workspace."
        }
        loading={isLoading}
        rules={blockRules}
        deletingId={deletingId}
        onRemove={onRemove}
      />

      <p className="mt-6 text-xs text-neutral-500 dark:text-neutral-400">
        Blocked invitations return HTTP 400 with one of{" "}
        <span className="font-mono">code: not_in_allowlist</span> or{" "}
        <span className="font-mono">code: in_blocklist</span>. Every add and
        remove writes to the admin audit log.
      </p>
    </div>
  );
}

function RuleList({
  title,
  hint,
  loading,
  rules,
  deletingId,
  onRemove,
}: {
  title: string;
  hint: string;
  loading: boolean;
  rules: Rule[];
  deletingId: number | null;
  onRemove: (id: number) => void;
}) {
  return (
    <Card>
      <CardHeader title={title} hint={hint} />
      <div className="border-t border-neutral-200 dark:border-neutral-800">
        {loading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : rules.length === 0 ? (
          <div className="p-4">
            <Empty title="No rules yet" hint="Add one above." />
          </div>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {rules.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="font-mono text-sm text-neutral-900 dark:text-neutral-50 break-all">
                    {r.domain}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
                    {r.note ? `${r.note} \u00b7 ` : ""}
                    added by {r.created_by ?? "unknown"} at{" "}
                    {fmtTime(r.created_at)}
                  </div>
                </div>
                <div className="shrink-0">
                  <Button
                    variant="ghost"
                    onClick={() => onRemove(r.id)}
                    disabled={deletingId === r.id}
                    aria-label={`Remove ${r.domain}`}
                  >
                    <Trash size={14} weight="duotone" aria-hidden />
                    {deletingId === r.id ? "removing" : "remove"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
