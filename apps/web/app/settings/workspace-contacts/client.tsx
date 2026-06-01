"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  AddressBook,
  ArrowLeft,
  CheckCircle,
  Envelope,
  FloppyDisk,
  ShieldCheck,
  Trash,
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

type Contact = {
  role: string;
  email: string;
  label: string | null;
  updated_by: string | null;
  updated_at: string;
  source: "workspace" | "operator_default";
  description: string;
};

type ContactsResp = {
  tenant_id: string;
  roles: string[];
  contacts: Contact[];
};

const ROLE_LABEL: Record<string, string> = {
  security: "Security",
  privacy: "Privacy / DPO",
  billing: "Billing",
  abuse: "Abuse",
  technical: "Technical / on-call",
  breach_notification: "Breach notification",
};

const fetcher = async (url: string): Promise<ContactsResp> => {
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const detail =
      typeof body?.detail === "string" ? body.detail : `request failed (${r.status})`;
    throw new Error(detail);
  }
  return r.json();
};

function fmtTime(iso: string): string {
  if (!iso) return "never";
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
  }
  return "request failed";
}

function RoleRow({
  contact,
  busyRole,
  flash,
  onSave,
  onDelete,
}: {
  contact: Contact;
  busyRole: string | null;
  flash: { role: string; kind: "ok" | "err"; msg: string } | null;
  onSave: (role: string, email: string, label: string, dryRun: boolean) => Promise<void>;
  onDelete: (role: string, dryRun: boolean) => Promise<void>;
}) {
  const [email, setEmail] = useState(
    contact.source === "workspace" ? contact.email : "",
  );
  const [label, setLabel] = useState(contact.label ?? "");
  const busy = busyRole === contact.role;
  const isOverride = contact.source === "workspace";
  const ownFlash = flash && flash.role === contact.role ? flash : null;
  return (
    <Card>
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-zinc-100">
                {ROLE_LABEL[contact.role] ?? contact.role}
              </span>
              {isOverride ? (
                <Badge tone="success">workspace</Badge>
              ) : (
                <Badge tone="neutral">operator default</Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              {contact.description}
            </p>
          </div>
          <div className="mt-2 text-xs text-zinc-500 sm:mt-0 sm:text-right">
            <div>
              effective: <span className="text-zinc-300">{contact.email}</span>
            </div>
            <div>
              updated: <span className="text-zinc-400">{fmtTime(contact.updated_at)}</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_220px_auto]">
          <label className="block">
            <span className="sr-only">email address for {contact.role}</span>
            <Input
              type="email"
              placeholder="role@your-company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
          </label>
          <label className="block">
            <span className="sr-only">optional label for {contact.role}</span>
            <Input
              type="text"
              placeholder="label (optional)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={80}
              disabled={busy}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={busy || !email.trim()}
              onClick={() => onSave(contact.role, email.trim(), label.trim(), false)}
            >
              <FloppyDisk weight="duotone" className="size-4" />
              Save
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !email.trim()}
              onClick={() => onSave(contact.role, email.trim(), label.trim(), true)}
              title="Validate and report the planned diff without writing"
            >
              Dry run
            </Button>
            {isOverride ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => onDelete(contact.role, false)}
                title="Remove override and revert to operator default"
              >
                <Trash weight="duotone" className="size-4" />
                Revert
              </Button>
            ) : null}
          </div>
        </div>

        {ownFlash ? (
          <div
            className={
              ownFlash.kind === "ok"
                ? "flex items-start gap-2 rounded border border-emerald-900/40 bg-emerald-950/30 p-2 text-xs text-emerald-300"
                : "flex items-start gap-2 rounded border border-rose-900/40 bg-rose-950/30 p-2 text-xs text-rose-300"
            }
            role="status"
          >
            {ownFlash.kind === "ok" ? (
              <CheckCircle weight="duotone" className="mt-0.5 size-4 shrink-0" />
            ) : (
              <Warning weight="duotone" className="mt-0.5 size-4 shrink-0" />
            )}
            <span className="break-words">{ownFlash.msg}</span>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

export default function WorkspaceContactsClient() {
  const { data, error, isLoading, mutate } = useSWR<ContactsResp>(
    "/api/workspace/contacts",
    fetcher,
    { revalidateOnFocus: false },
  );

  const [busyRole, setBusyRole] = useState<string | null>(null);
  const [flash, setFlash] = useState<
    { role: string; kind: "ok" | "err"; msg: string } | null
  >(null);

  const handleSave = useCallback(
    async (role: string, email: string, label: string, dryRun: boolean) => {
      setBusyRole(role);
      setFlash(null);
      try {
        const qs = dryRun ? "?dry_run=true" : "";
        const r = await fetch(`/api/workspace/contacts/${role}${qs}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email,
            label: label || null,
          }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          setFlash({ role, kind: "err", msg: detailMessage(body) });
          return;
        }
        if (dryRun) {
          setFlash({
            role,
            kind: "ok",
            msg: `dry run ok: would set ${body.email}${
              body.label ? ` (${body.label})` : ""
            }`,
          });
          return;
        }
        setFlash({ role, kind: "ok", msg: `saved ${body.email}` });
        await mutate();
      } catch (e) {
        setFlash({
          role,
          kind: "err",
          msg: e instanceof Error ? e.message : "request failed",
        });
      } finally {
        setBusyRole(null);
      }
    },
    [mutate],
  );

  const handleDelete = useCallback(
    async (role: string, dryRun: boolean) => {
      setBusyRole(role);
      setFlash(null);
      try {
        const qs = dryRun ? "?dry_run=true" : "";
        const r = await fetch(`/api/workspace/contacts/${role}${qs}`, {
          method: "DELETE",
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          setFlash({ role, kind: "err", msg: detailMessage(body) });
          return;
        }
        setFlash({
          role,
          kind: "ok",
          msg: `reverted to operator default (${body.reverted_to ?? body.reverts_to})`,
        });
        await mutate();
      } catch (e) {
        setFlash({
          role,
          kind: "err",
          msg: e instanceof Error ? e.message : "request failed",
        });
      } finally {
        setBusyRole(null);
      }
    },
    [mutate],
  );

  const overrideCount = useMemo(
    () => data?.contacts.filter((c) => c.source === "workspace").length ?? 0,
    [data],
  );

  return (
    <main className="min-h-dvh bg-zinc-950 text-zinc-100">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
        <div className="mb-6 flex items-center justify-between gap-4">
          <Link
            href="/settings"
            className="inline-flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-200"
          >
            <ArrowLeft weight="duotone" className="size-4" />
            settings
          </Link>
          <Link
            href="/api/workspace/contacts"
            className="inline-flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-200"
          >
            <Envelope weight="duotone" className="size-4" />
            JSON
          </Link>
        </div>

        <header className="mb-6 flex items-start gap-3">
          <span className="rounded-lg border border-zinc-800 bg-zinc-900 p-2">
            <AddressBook weight="duotone" className="size-5 text-emerald-400" />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              Workspace contacts
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              Per role addresses we use for breach notification, invoice routing,
              vulnerability reports, and on-call. Roles without an override
              inherit the operator default.
            </p>
          </div>
        </header>

        {error ? (
          <ErrorBox message={(error as Error).message} />
        ) : isLoading || !data ? (
          <div className="space-y-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-zinc-400">
              <span className="inline-flex items-center gap-1">
                <ShieldCheck weight="duotone" className="size-4 text-emerald-400" />
                workspace: <span className="text-zinc-200">{data.tenant_id}</span>
              </span>
              <span>
                overrides: <span className="text-zinc-200">{overrideCount}</span>{" "}
                / {data.contacts.length}
              </span>
            </div>

            {data.contacts.length === 0 ? (
              <Empty
                title="no roles defined"
                hint="The operator has not registered any notification roles for this deployment."
              />
            ) : (
              <div className="space-y-3">
                {data.contacts.map((c) => (
                  <RoleRow
                    key={c.role}
                    contact={c}
                    busyRole={busyRole}
                    flash={flash}
                    onSave={handleSave}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            )}

            <Card className="mt-6">
              <CardHeader
                title="how this is used"
                hint="Each role resolves at send time. Updates take effect immediately."
              />
              <div className="px-4 pb-4 text-xs text-zinc-400 sm:px-5 sm:pb-5">
                <ul className="list-disc space-y-1 pl-4">
                  <li>
                    <span className="text-zinc-200">breach_notification</span> is
                    the Article 33 recipient for incidents tagged to this
                    workspace.
                  </li>
                  <li>
                    <span className="text-zinc-200">billing</span> receives
                    invoices, renewals, and dunning notices.
                  </li>
                  <li>
                    <span className="text-zinc-200">security</span> shows up in
                    the workspace security.txt and receives scanner findings.
                  </li>
                  <li>
                    Removing an override falls back to the operator default
                    published at <code>/.well-known/security.txt</code>.
                  </li>
                </ul>
              </div>
            </Card>
          </>
        )}
      </div>
    </main>
  );
}
