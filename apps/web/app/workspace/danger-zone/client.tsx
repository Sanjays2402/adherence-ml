"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  Warning,
  ShieldWarning,
  Trash,
  ArrowLeft,
  Eye,
  Users,
  EnvelopeSimple,
  Globe,
  Key,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Button,
  Input,
  Skeleton,
  ErrorBox,
  MonoChip,
  Badge,
  SectionLabel,
} from "@/components/ui/primitives";

type Role = "owner" | "editor" | "viewer";
type Workspace = {
  id: string;
  name: string;
  created_at: number;
  role: Role;
};
type Member = { user_id: string; email: string; role: Role };

type DryRunBundle = {
  dry_run: true;
  summary: string;
  resource: string;
  id: string;
  before?: {
    workspace_name: string;
    members: Member[];
    invites_open: number;
    invites_total: number;
    verified_domains: number;
    sso_configured: boolean;
    security_policy_set: boolean;
  };
  cascade?: Array<{ resource: string; id: string; label?: string }>;
  metadata?: { confirm_phrase?: string };
};

const swrFetcher = async (url: string) => {
  const r = await fetch(url);
  if (r.status === 401) throw new Error("Sign in to manage this workspace.");
  if (!r.ok) {
    let detail = `Request failed (${r.status})`;
    try {
      const j = await r.json();
      if (j?.detail) detail = String(j.detail);
    } catch {}
    throw new Error(detail);
  }
  return r.json();
};

export default function DangerZoneClient({
  workspaceId: initialWorkspaceId,
}: {
  workspaceId: string | null;
}) {
  const { data: list, error: listError } = useSWR<{
    items: Workspace[];
  }>("/api/workspaces", swrFetcher);

  const ownedWorkspaces = useMemo(
    () => (list?.items ?? []).filter((w) => w.role === "owner"),
    [list],
  );

  const [selected, setSelected] = useState<string | null>(initialWorkspaceId);
  useEffect(() => {
    if (selected) return;
    if (ownedWorkspaces.length > 0) setSelected(ownedWorkspaces[0].id);
  }, [selected, ownedWorkspaces]);

  const current = useMemo(
    () => ownedWorkspaces.find((w) => w.id === selected) ?? null,
    [ownedWorkspaces, selected],
  );

  const [preview, setPreview] = useState<DryRunBundle | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState<null | {
    workspace_name: string;
    members_removed: number;
    invites_removed: number;
    verified_domains_removed: number;
    scim_tokens_removed: number;
  }>(null);

  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    setConfirm("");
    setSubmitError(null);
    setDone(null);
  }, [selected]);

  const runPreview = useCallback(async () => {
    if (!selected) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const r = await fetch(
        `/api/workspaces/${encodeURIComponent(selected)}/delete?dry_run=true`,
        { method: "POST" },
      );
      const j = await r.json();
      if (!r.ok)
        throw new Error(j?.detail ?? `Preview failed (${r.status})`);
      setPreview(j as DryRunBundle);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  }, [selected]);

  const expectedConfirm = preview?.metadata?.confirm_phrase ?? null;
  const phraseMatches =
    expectedConfirm !== null && confirm === expectedConfirm;

  const runDelete = useCallback(async () => {
    if (!selected || !expectedConfirm || !phraseMatches) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await fetch(
        `/api/workspaces/${encodeURIComponent(selected)}/delete`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: confirm }),
        },
      );
      const j = await r.json();
      if (!r.ok) {
        if (j?.code === "mfa_step_up_required" || j?.error === "mfa_step_up_required") {
          throw new Error(
            "A fresh second factor is required. Open /settings/security and complete a step-up TOTP, then retry.",
          );
        }
        throw new Error(j?.detail ?? `Deletion failed (${r.status})`);
      }
      setDone({
        workspace_name: j.workspace_name,
        members_removed: j.members_removed,
        invites_removed: j.invites_removed,
        verified_domains_removed: j.verified_domains_removed,
        scim_tokens_removed: j.scim_tokens_removed,
      });
      setSelected(null);
      setConfirm("");
      setPreview(null);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [selected, confirm, expectedConfirm, phraseMatches]);

  return (
    <div className="min-h-screen pb-24">
      <PageHeader
        title="danger zone"
        description="Owner only. Permanently delete a workspace and every workspace-scoped record this build owns."
        actions={
          <Link
            href="/workspace"
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-surface-2)]"
          >
            <ArrowLeft weight="duotone" size={13} /> back to workspace
          </Link>
        }
      />

      <div className="mx-auto w-full max-w-3xl px-4 sm:px-6 lg:px-8 space-y-4">
        {done ? (
          <Card>
            <CardHeader
              title="workspace deleted"
              hint={`scim ${done.scim_tokens_removed}`}
            />
            <div className="px-4 py-4 text-[13px] space-y-2">
              <div>
                <strong className="font-mono">{done.workspace_name}</strong>{" "}
                is gone. Members lost access immediately.
              </div>
              <ul className="text-[12px] text-[var(--color-muted)] space-y-1">
                <li>
                  <MonoChip>members removed</MonoChip> {done.members_removed}
                </li>
                <li>
                  <MonoChip>invites removed</MonoChip> {done.invites_removed}
                </li>
                <li>
                  <MonoChip>verified domains removed</MonoChip>{" "}
                  {done.verified_domains_removed}
                </li>
                <li>
                  <MonoChip>scim tokens revoked</MonoChip>{" "}
                  {done.scim_tokens_removed}
                </li>
              </ul>
              <div className="pt-2">
                <Link
                  href="/workspace"
                  className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-surface-2)]"
                >
                  back to workspaces
                </Link>
              </div>
            </div>
          </Card>
        ) : null}

        <Card>
          <CardHeader
            title="select an owned workspace"
            hint={`${ownedWorkspaces.length} owned`}
          />
          <div className="px-4 py-4 space-y-3">
            {listError ? (
              <ErrorBox message={(listError as Error).message} />
            ) : null}
            {!list ? (
              <Skeleton className="h-9 w-full" />
            ) : ownedWorkspaces.length === 0 ? (
              <div className="text-[13px] text-[var(--color-muted)]">
                You do not own any workspace. Only an owner can delete a
                workspace. Transfer ownership to yourself first, or ask the
                current owner to perform the deletion.
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {ownedWorkspaces.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => setSelected(w.id)}
                    className={
                      "rounded-md border px-2.5 py-1.5 text-[12px] font-mono " +
                      (selected === w.id
                        ? "border-[var(--color-border-strong)] bg-[var(--color-surface-2)]"
                        : "border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]")
                    }
                  >
                    {w.name}{" "}
                    <span className="text-[var(--color-muted)]">
                      · {w.id.slice(0, 12)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </Card>

        {selected && current ? (
          <Card>
            <CardHeader
              title={`permanently delete '${current.name}'`}
              hint="GDPR Art. 17"
            />
            <div className="px-4 py-4 space-y-4 text-[13px]">
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[12px]">
                <Warning
                  weight="duotone"
                  size={16}
                  className="mt-0.5 shrink-0 text-amber-500"
                />
                <div>
                  This removes every member, invite, verified domain, SSO
                  configuration, security policy, and SCIM token attached to
                  this workspace. The action is irreversible. Run the preview
                  first to see exactly what will be touched.
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  onClick={runPreview}
                  disabled={previewing}
                  aria-label="Preview deletion (dry run)"
                >
                  <Eye weight="duotone" size={13} />{" "}
                  {previewing ? "previewing..." : "preview (dry run)"}
                </Button>
                {preview ? (
                  <Badge tone="neutral">
                    <MonoChip>dry_run</MonoChip> ok
                  </Badge>
                ) : null}
              </div>

              {previewError ? <ErrorBox message={previewError} /> : null}

              {preview && preview.before ? (
                <div className="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                  <SectionLabel>what will be removed</SectionLabel>
                  <div className="grid grid-cols-2 gap-2 text-[12px]">
                    <StatRow
                      icon={<Users weight="duotone" size={13} />}
                      label="members"
                      value={preview.before.members.length}
                    />
                    <StatRow
                      icon={<EnvelopeSimple weight="duotone" size={13} />}
                      label="open invites"
                      value={preview.before.invites_open}
                    />
                    <StatRow
                      icon={<EnvelopeSimple weight="duotone" size={13} />}
                      label="total invite records"
                      value={preview.before.invites_total}
                    />
                    <StatRow
                      icon={<Globe weight="duotone" size={13} />}
                      label="verified domains"
                      value={preview.before.verified_domains}
                    />
                    <StatRow
                      icon={<Key weight="duotone" size={13} />}
                      label="sso configured"
                      value={preview.before.sso_configured ? "yes" : "no"}
                    />
                    <StatRow
                      icon={<ShieldWarning weight="duotone" size={13} />}
                      label="security policy set"
                      value={
                        preview.before.security_policy_set ? "yes" : "no"
                      }
                    />
                  </div>
                  {preview.summary ? (
                    <p className="text-[12px] text-[var(--color-muted)]">
                      {preview.summary}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {preview && expectedConfirm ? (
                <div className="space-y-2">
                  <SectionLabel>type to confirm</SectionLabel>
                  <p className="text-[12px] text-[var(--color-muted)]">
                    Copy this phrase exactly:{" "}
                    <MonoChip>{expectedConfirm}</MonoChip>
                  </p>
                  <Input
                    aria-label="Confirmation phrase"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder={expectedConfirm}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      variant="danger"
                      onClick={runDelete}
                      disabled={!phraseMatches || submitting}
                      aria-label="Permanently delete this workspace"
                    >
                      <Trash weight="duotone" size={13} />{" "}
                      {submitting ? "deleting..." : "delete forever"}
                    </Button>
                    {!phraseMatches && confirm.length > 0 ? (
                      <span className="text-[11px] text-[var(--color-muted)]">
                        phrase does not match
                      </span>
                    ) : null}
                  </div>
                  {submitError ? <ErrorBox message={submitError} /> : null}
                </div>
              ) : null}
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function StatRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
}) {
  return (
    <div className="flex items-center justify-between rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5">
      <span className="inline-flex items-center gap-1.5 text-[var(--color-muted)]">
        {icon} {label}
      </span>
      <span className="font-mono">{String(value)}</span>
    </div>
  );
}
