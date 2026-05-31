"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  Key,
  Plus,
  Trash,
  Copy,
  CheckCircle,
  Shield,
  ArrowLeft,
  Warning,
  PlugsConnected,
  ArrowsClockwise,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Empty,
  Button,
  Input,
  Select,
  Skeleton,
  ErrorBox,
  MonoChip,
  Badge,
} from "@/components/ui/primitives";

type Role = "owner" | "editor" | "viewer";
type Workspace = { id: string; name: string; role: Role };
type ScimToken = {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  created_by: string;
  last_used_at: number | null;
  last_used_ip: string | null;
  use_count: number;
  revoked_at: number | null;
  expires_at: number | null;
  rotated_at: number | null;
  rotated_from_id: string | null;
  rotated_to_id: string | null;
};

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (r.status === 401) throw new Error("Sign in to manage SCIM tokens.");
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.detail ?? `request failed (${r.status})`);
  }
  return r.json();
};

function fmt(ms: number | null): string {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}

export default function ScimClient() {
  const list = useSWR<{ items: Workspace[] }>("/api/workspaces", fetcher, {
    revalidateOnFocus: false,
  });
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (list.data?.items?.length && !selected) {
      // prefer first workspace where the viewer is owner
      const owned = list.data.items.find((w) => w.role === "owner");
      setSelected(owned?.id ?? list.data.items[0].id);
    }
  }, [list.data, selected]);

  const role = useMemo(() => {
    return list.data?.items.find((w) => w.id === selected)?.role ?? null;
  }, [list.data, selected]);
  const isOwner = role === "owner";

  const tokens = useSWR<{ items: ScimToken[] }>(
    selected && isOwner ? `/api/workspaces/${selected}/scim-tokens` : null,
    fetcher,
    { revalidateOnFocus: false },
  );

  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ id: string; plaintext: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!selected || !newName.trim()) return;
      setCreating(true);
      setErr(null);
      try {
        const r = await fetch(`/api/workspaces/${selected}/scim-tokens`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: newName.trim() }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.detail ?? `create failed (${r.status})`);
        setRevealed({ id: j.token.id, plaintext: j.plaintext });
        setNewName("");
        tokens.mutate();
      } catch (e2) {
        setErr((e2 as Error).message);
      } finally {
        setCreating(false);
      }
    },
    [selected, newName, tokens],
  );

  const revoke = useCallback(
    async (tokenId: string, name: string) => {
      if (!selected) return;
      if (!confirm(`Revoke SCIM token "${name}"? Your IdP will stop syncing.`)) return;
      try {
        const r = await fetch(
          `/api/workspaces/${selected}/scim-tokens?token=${encodeURIComponent(tokenId)}`,
          { method: "DELETE" },
        );
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.detail ?? `revoke failed (${r.status})`);
        }
        tokens.mutate();
      } catch (e2) {
        setErr((e2 as Error).message);
      }
    },
    [selected, tokens],
  );

  const rotate = useCallback(
    async (tokenId: string, name: string) => {
      if (!selected) return;
      const hoursStr = prompt(
        `Rotate SCIM token "${name}".\n\nThe old token stays valid alongside the new one for the grace window so your IdP can swap credentials without a failed-call gap.\n\nGrace window in hours (1 to 168):`,
        "24",
      );
      if (hoursStr === null) return;
      const hours = Number(hoursStr);
      if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
        setErr("Grace window must be between 1 and 168 hours.");
        return;
      }
      try {
        const r = await fetch(
          `/api/workspaces/${selected}/scim-tokens/${encodeURIComponent(tokenId)}/rotate`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ grace_seconds: Math.round(hours * 3600) }),
          },
        );
        const j = await r.json();
        if (!r.ok) throw new Error(j.detail ?? `rotate failed (${r.status})`);
        setRevealed({ id: j.new.id, plaintext: j.plaintext });
        tokens.mutate();
      } catch (e2) {
        setErr((e2 as Error).message);
      }
    },
    [selected, tokens],
  );

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* swallow */
    }
  }, []);

  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://your-host";
  const tenantUrl = `${origin}/scim/v2`;

  return (
    <div>
      <PageHeader
        eyebrow="security // SCIM 2.0 provisioning"
        title="Identity provider provisioning"
        description="Point Okta, Azure AD, Google Workspace, OneLogin, or JumpCloud at this workspace. SCIM 2.0 bearer tokens are scoped to one workspace and never cross tenants."
        actions={
          <Link
            href="/workspace"
            className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-surface-2)]"
          >
            <ArrowLeft weight="duotone" size={13} /> Workspace
          </Link>
        }
      />

      <div className="mx-auto grid w-full max-w-[820px] gap-4 p-4 md:p-6">
        <Card>
          <CardHeader title="workspace" hint="Only the owner can manage SCIM tokens." />
          <div className="p-4">
            {list.isLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : list.error ? (
              <ErrorBox message={(list.error as Error).message} />
            ) : (list.data?.items?.length ?? 0) === 0 ? (
              <Empty
                title="No workspaces yet"
                hint="Create one from the workspace page first."
              />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={selected ?? ""}
                  onChange={(e) => setSelected(e.target.value)}
                  aria-label="Workspace"
                >
                  {list.data!.items.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.role})
                    </option>
                  ))}
                </Select>
                {role ? (
                  <Badge tone={isOwner ? "accent" : "neutral"}>{role}</Badge>
                ) : null}
              </div>
            )}
          </div>
        </Card>

        {!isOwner && selected ? (
          <Card>
            <div className="flex items-start gap-2 p-4 text-[13px] text-[var(--color-fg-muted)]">
              <Warning weight="duotone" size={16} className="mt-0.5 text-amber-500" />
              <div>
                You need the <b>owner</b> role on this workspace to mint or revoke SCIM
                tokens. Ask the workspace owner to grant you ownership.
              </div>
            </div>
          </Card>
        ) : null}

        {isOwner && selected ? (
          <>
            <Card>
              <CardHeader
                title="Endpoint configuration"
                hint="Paste these into your identity provider's SCIM app."
              />
              <div className="grid gap-3 p-4 text-[13px]">
                <div className="grid gap-1">
                  <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-muted)]">
                    Tenant URL
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 grow break-all rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[12px] normal-case tracking-normal text-[var(--color-fg)]">
                      {tenantUrl}
                    </code>
                    <button
                      type="button"
                      onClick={() => copy(tenantUrl)}
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px] hover:bg-[var(--color-surface-2)]"
                      aria-label="Copy tenant URL"
                    >
                      <Copy weight="duotone" size={12} />
                      Copy
                    </button>
                  </div>
                </div>
                <div className="grid gap-1">
                  <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-muted)]">
                    Authentication
                  </div>
                  <div className="text-[var(--color-fg-muted)]">
                    HTTP header bearer token (use a token created below).
                  </div>
                </div>
                <div className="grid gap-1">
                  <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-muted)]">
                    Supported operations
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone="neutral">Users.list</Badge>
                    <Badge tone="neutral">Users.create</Badge>
                    <Badge tone="neutral">Users.read</Badge>
                    <Badge tone="neutral">Users.update (PUT/PATCH)</Badge>
                    <Badge tone="neutral">Users.delete</Badge>
                    <Badge tone="neutral">filter: userName eq</Badge>
                  </div>
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Create a token"
                hint="Tokens are returned in plaintext exactly once. Store them in your IdP."
              />
              <form onSubmit={create} className="grid gap-3 p-4">
                <div className="grid gap-1">
                  <label className="text-[11px] uppercase tracking-wide text-[var(--color-fg-muted)]">
                    Label
                  </label>
                  <Input
                    placeholder="Okta production"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    maxLength={80}
                    required
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div className="text-[12px] text-[var(--color-fg-muted)]">
                    Each token grants Users API access to this workspace only.
                  </div>
                  <Button type="submit" disabled={creating || !newName.trim()}>
                    {creating ? (
                      "Minting..."
                    ) : (
                      <>
                        <Plus weight="duotone" size={13} /> Mint token
                      </>
                    )}
                  </Button>
                </div>
                {err ? <ErrorBox message={err} /> : null}
              </form>
            </Card>

            {revealed ? (
              <Card>
                <CardHeader
                  title="New token (visible once)"
                  hint="Copy it now. We do not store the plaintext."
                />
                <div className="grid gap-3 p-4">
                  <div className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-[12px] text-emerald-700 dark:text-emerald-400">
                    <CheckCircle weight="duotone" size={16} className="mt-0.5" />
                    <div>
                      Configure your IdP with this bearer token, then close this
                      panel. You will not be able to view it again.
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 grow break-all rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[12px] normal-case tracking-normal text-[var(--color-fg)]">
                      {revealed.plaintext}
                    </code>
                    <button
                      type="button"
                      onClick={() => copy(revealed.plaintext)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px] hover:bg-[var(--color-surface-2)]"
                    >
                      <Copy weight="duotone" size={12} />
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <div>
                    <button
                      type="button"
                      onClick={() => setRevealed(null)}
                      className="text-[12px] text-[var(--color-fg-muted)] underline-offset-2 hover:underline"
                    >
                      Close
                    </button>
                  </div>
                </div>
              </Card>
            ) : null}

            <Card>
              <CardHeader
                title="Active tokens"
                hint="Last-used time and IP help spot abandoned integrations."
              />
              <div className="p-4">
                {tokens.isLoading ? (
                  <div className="grid gap-2">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : tokens.error ? (
                  <ErrorBox message={(tokens.error as Error).message} />
                ) : (tokens.data?.items?.length ?? 0) === 0 ? (
                  <Empty
                    title="No SCIM tokens yet"
                    hint="Mint a token above, then paste it into your IdP."
                  />
                ) : (
                  <ul className="grid gap-2">
                    {tokens.data!.items.map((t) => {
                      const revoked = t.revoked_at !== null;
                      const inGrace =
                        !revoked &&
                        t.expires_at !== null &&
                        t.expires_at > Date.now();
                      const graceMs = inGrace && t.expires_at ? t.expires_at - Date.now() : 0;
                      const graceLabel = graceMs
                        ? graceMs >= 3_600_000
                          ? `${Math.ceil(graceMs / 3_600_000)}h left`
                          : `${Math.ceil(graceMs / 60_000)}m left`
                        : "";
                      const isSuccessor = t.rotated_from_id !== null;
                      return (
                        <li
                          key={t.id}
                          className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 md:flex-row md:items-center md:justify-between"
                        >
                          <div className="min-w-0 grow">
                            <div className="flex items-center gap-2">
                              <Key weight="duotone" size={14} />
                              <span className="truncate font-medium">{t.name}</span>
                              {revoked ? (
                                <Badge tone="neutral">revoked</Badge>
                              ) : inGrace ? (
                                <Badge tone="warn">rotating - {graceLabel}</Badge>
                              ) : t.last_used_at ? (
                                <Badge tone="accent">active</Badge>
                              ) : (
                                <Badge tone="neutral">unused</Badge>
                              )}
                              {isSuccessor ? (
                                <Badge tone="neutral">rotated</Badge>
                              ) : null}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-fg-muted)]">
                              <MonoChip>{t.prefix}...</MonoChip>
                              <span>created {fmt(t.created_at)}</span>
                              <span>last used {fmt(t.last_used_at)}</span>
                              <span>{t.use_count} calls</span>
                              {t.last_used_ip ? (
                                <span>from {t.last_used_ip}</span>
                              ) : null}
                              {inGrace && t.expires_at ? (
                                <span>
                                  expires {new Date(t.expires_at).toLocaleString()}
                                </span>
                              ) : null}
                            </div>
                          </div>
                          {!revoked ? (
                            <div className="flex shrink-0 items-center gap-2">
                              {!inGrace && t.rotated_to_id === null ? (
                                <button
                                  type="button"
                                  onClick={() => rotate(t.id, t.name)}
                                  className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-surface-2)]"
                                  aria-label={`Rotate ${t.name}`}
                                >
                                  <ArrowsClockwise weight="duotone" size={13} />
                                  Rotate
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => revoke(t.id, t.name)}
                                className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/5 px-2.5 py-1.5 text-[12px] text-red-600 hover:bg-red-500/10 dark:text-red-400"
                                aria-label={`Revoke ${t.name}`}
                              >
                                <Trash weight="duotone" size={13} />
                                Revoke
                              </button>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Role mapping"
                hint="How your IdP groups map to workspace roles."
              />
              <div className="grid gap-2 p-4 text-[13px]">
                <div className="flex items-center gap-2">
                  <Shield weight="duotone" size={14} />
                  <MonoChip>owners</MonoChip>
                  <span className="text-[var(--color-fg-muted)]">full admin</span>
                </div>
                <div className="flex items-center gap-2">
                  <Shield weight="duotone" size={14} />
                  <MonoChip>editors</MonoChip>
                  <span className="text-[var(--color-fg-muted)]">
                    create and update records (also accepted: admin, member)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Shield weight="duotone" size={14} />
                  <MonoChip>viewers</MonoChip>
                  <span className="text-[var(--color-fg-muted)]">read-only</span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[12px] text-[var(--color-fg-muted)]">
                  <PlugsConnected weight="duotone" size={13} />
                  Provisioning the last remaining owner cannot demote or remove
                  them; that prevents your IdP from locking the workspace.
                </div>
              </div>
            </Card>
          </>
        ) : null}
      </div>
    </div>
  );
}
