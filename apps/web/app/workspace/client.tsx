"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  UsersThree,
  PaperPlaneTilt,
  Copy,
  Trash,
  Plus,
  Crown,
  PencilLine,
  Eye,
  ArrowSquareOut,
  Check,
  Warning,
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

type Workspace = { id: string; name: string; created_at: number; created_by: string; role: Role };
type Member = { user_id: string; email: string; role: Role; joined_at: number };
type Invite = {
  id: string;
  email: string;
  role: Role;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  revoked_at: number | null;
};
type Detail = { workspace: Omit<Workspace, "role">; role: Role; members: Member[]; invites: Invite[] };

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (r.status === 401) throw new Error("Sign in to manage your workspace.");
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.detail ?? `request failed (${r.status})`);
  }
  return r.json();
};

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

function fmtUntil(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "expired";
  const days = Math.floor(diff / 86_400_000);
  if (days >= 1) return `${days}d left`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours >= 1) return `${hours}h left`;
  const mins = Math.max(1, Math.floor(diff / 60_000));
  return `${mins}m left`;
}

function RoleIcon({ role }: { role: Role }) {
  if (role === "owner") return <Crown weight="duotone" size={12} />;
  if (role === "editor") return <PencilLine weight="duotone" size={12} />;
  return <Eye weight="duotone" size={12} />;
}

export default function WorkspaceClient() {
  const list = useSWR<{ items: Workspace[] }>("/api/workspaces", fetcher, {
    revalidateOnFocus: false,
  });

  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (list.data?.items?.length && !selected) {
      setSelected(list.data.items[0].id);
    }
  }, [list.data, selected]);

  const detail = useSWR<Detail>(
    selected ? `/api/workspaces/${selected}` : null,
    fetcher,
    { revalidateOnFocus: false },
  );

  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const createWs = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!newName.trim()) return;
      setCreating(true);
      try {
        const r = await fetch("/api/workspaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: newName.trim() }),
        });
        if (r.ok) {
          const j = await r.json();
          setNewName("");
          await list.mutate();
          setSelected(j.workspace.id);
        }
      } finally {
        setCreating(false);
      }
    },
    [newName, list],
  );

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("editor");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  const [lastLink, setLastLink] = useState<{ email: string; url: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const sendInvite = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!selected || !inviteEmail.trim()) return;
      setInviteBusy(true);
      setInviteErr(null);
      try {
        const r = await fetch(`/api/workspaces/${selected}/invites`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
        });
        const j = await r.json();
        if (!r.ok) {
          setInviteErr(j.detail ?? "failed");
        } else {
          setInviteEmail("");
          setLastLink({ email: j.invite.email, url: j.accept_url });
          await detail.mutate();
        }
      } finally {
        setInviteBusy(false);
      }
    },
    [selected, inviteEmail, inviteRole, detail],
  );

  const revoke = useCallback(
    async (inviteId: string) => {
      if (!selected) return;
      const r = await fetch(
        `/api/workspaces/${selected}/invites?invite_id=${encodeURIComponent(inviteId)}`,
        { method: "DELETE" },
      );
      if (r.ok) {
        await detail.mutate();
        setToast("Invite revoked.");
      }
    },
    [selected, detail],
  );

  const removeMember = useCallback(
    async (userId: string) => {
      if (!selected) return;
      const r = await fetch(
        `/api/workspaces/${selected}?user_id=${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      );
      if (r.ok) {
        await detail.mutate();
        setToast("Member removed.");
      }
    },
    [selected, detail],
  );

  const changeRole = useCallback(
    async (userId: string, role: Role) => {
      if (!selected) return;
      const r = await fetch(
        `/api/workspaces/${selected}/members/${encodeURIComponent(userId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role }),
        },
      );
      if (r.ok) {
        await Promise.all([detail.mutate(), list.mutate()]);
        setToast(`Role updated to ${role}.`);
      } else {
        const j = await r.json().catch(() => ({}));
        setToast(
          j.detail === "last_owner"
            ? "Cannot demote the last owner."
            : `Role update failed (${r.status}).`,
        );
      }
    },
    [selected, detail, list],
  );

  const renameSelected = useCallback(
    async (newName: string) => {
      if (!selected) return false;
      const r = await fetch(`/api/workspaces/${selected}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      if (r.ok) {
        await Promise.all([detail.mutate(), list.mutate()]);
        setToast("Workspace renamed.");
        return true;
      }
      const j = await r.json().catch(() => ({}));
      setToast(j.detail ?? `Rename failed (${r.status}).`);
      return false;
    },
    [selected, detail, list],
  );

  const deleteSelected = useCallback(async () => {
    if (!selected) return;
    const confirmText = window.prompt(
      'This permanently deletes the workspace, its memberships, and pending invites. Type "delete" to confirm.',
    );
    if (confirmText !== "delete") return;
    const r = await fetch(`/api/workspaces/${selected}`, { method: "DELETE" });
    if (r.ok) {
      setSelected(null);
      await list.mutate();
      setToast("Workspace deleted.");
    } else {
      const j = await r.json().catch(() => ({}));
      setToast(j.detail ?? `Delete failed (${r.status}).`);
    }
  }, [selected, list]);

  const copyLink = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setToast("Invite link copied.");
    } catch {
      setToast("Copy failed.");
    }
  }, []);

  const pendingInvites = useMemo(
    () => (detail.data?.invites ?? []).filter((i) => !i.accepted_at && !i.revoked_at),
    [detail.data],
  );

  if (list.error) {
    return (
      <div className="p-6">
        <ErrorBox message={String(list.error.message ?? list.error)} />
        <div className="mt-3">
          <Link
            href="/login"
            className="text-[13px] text-[var(--color-accent)] hover:underline inline-flex items-center gap-1"
          >
            Sign in <ArrowSquareOut weight="duotone" size={12} />
          </Link>
        </div>
      </div>
    );
  }

  const workspaces = list.data?.items ?? [];

  return (
    <div className="flex flex-col">
      <PageHeader
        eyebrow="team"
        title="Workspace"
        description="Invite teammates, assign roles, and share access to runs and history."
        actions={
          <form onSubmit={createWs} className="flex items-center gap-2">
            <Input
              placeholder="New workspace name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="min-w-[200px]"
            />
            <Button type="submit" disabled={!newName.trim() || creating}>
              <Plus weight="duotone" size={14} /> Create
            </Button>
          </form>
        }
      />

      <div className="grid gap-4 p-4 md:p-6 md:grid-cols-[260px_1fr]">
        {/* Workspace list */}
        <Card className="h-fit">
          <CardHeader title="your workspaces" hint={`${workspaces.length} total`} />
          {!list.data ? (
            <div className="p-3 flex flex-col gap-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : workspaces.length === 0 ? (
            <Empty
              icon={<UsersThree weight="duotone" size={28} />}
              title="No workspaces yet"
              hint="Create one to start inviting teammates."
            />
          ) : (
            <ul className="p-1.5">
              {workspaces.map((w) => (
                <li key={w.id}>
                  <button
                    onClick={() => setSelected(w.id)}
                    className={
                      "w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-md text-left text-[13px] transition-colors " +
                      (selected === w.id
                        ? "bg-[var(--color-accent-soft)] text-[var(--color-fg)]"
                        : "text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-border)]/30")
                    }
                  >
                    <span className="truncate">{w.name}</span>
                    <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-[var(--color-subtle)]">
                      <RoleIcon role={w.role} />
                      {w.role}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Detail */}
        <div className="flex flex-col gap-4 min-w-0">
          {!selected ? (
            <Card>
              <Empty
                icon={<UsersThree weight="duotone" size={28} />}
                title="Pick a workspace"
                hint="Select one on the left to manage members and invites."
              />
            </Card>
          ) : detail.error ? (
            <ErrorBox message={String(detail.error.message ?? detail.error)} />
          ) : !detail.data ? (
            <>
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-48 w-full" />
            </>
          ) : (() => {
              const d = detail.data!;
              return (<>
              {/* Invite form */}
              <Card>
                <CardHeader
                  title="invite a teammate"
                  hint="They sign in with magic link then accept the invite. Link expires in 7 days."
                />
                <form
                  onSubmit={sendInvite}
                  className="p-4 flex flex-col gap-3 md:flex-row md:items-end"
                >
                  <label className="flex flex-col gap-1 flex-1">
                    <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                      Email
                    </span>
                    <Input
                      type="email"
                      placeholder="teammate@company.com"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      required
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                      Role
                    </span>
                    <Select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as Role)}
                      disabled={d.role !== "owner" && d.role !== "editor"}
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                      <option value="owner">Owner</option>
                    </Select>
                  </label>
                  <Button
                    type="submit"
                    variant="accent"
                    disabled={
                      inviteBusy ||
                      !inviteEmail.trim() ||
                      (d.role !== "owner" && d.role !== "editor")
                    }
                  >
                    <PaperPlaneTilt weight="duotone" size={14} /> Send invite
                  </Button>
                </form>
                {inviteErr ? (
                  <div className="px-4 pb-3 text-[12px] text-[var(--color-danger)]">
                    {inviteErr}
                  </div>
                ) : null}
                {lastLink ? (
                  <div className="border-t border-[var(--color-border)] px-4 py-3 flex flex-col gap-2">
                    <div className="text-[12px] text-[var(--color-muted)]">
                      Share this link with{" "}
                      <span className="font-mono text-[var(--color-fg)]">{lastLink.email}</span>:
                    </div>
                    <div className="flex items-center gap-2">
                      <Input readOnly value={lastLink.url} className="font-mono text-[11px]" />
                      <Button variant="ghost" onClick={() => copyLink(lastLink.url)}>
                        <Copy weight="duotone" size={14} /> Copy
                      </Button>
                    </div>
                  </div>
                ) : null}
              </Card>

              {/* Workspace settings */}
              <WorkspaceSettingsCard
                key={d.workspace.id}
                workspace={d.workspace}
                role={d.role}
                onRename={renameSelected}
                onDelete={deleteSelected}
              />

              {/* Members */}
              <Card>
                <CardHeader
                  title="members"
                  hint={`${d.members.length} active`}
                  right={
                    <Badge>
                      <RoleIcon role={d.role} />
                      <span className="ml-1">you are {d.role}</span>
                    </Badge>
                  }
                />
                <ul className="divide-y divide-[var(--color-border)]">
                  {d.members.map((m) => (
                    <li
                      key={m.user_id}
                      className="px-4 py-3 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0 flex flex-col">
                        <span className="text-[13px] font-mono truncate">{m.email}</span>
                        <span className="text-[11px] text-[var(--color-muted)]">
                          Joined {fmtTime(m.joined_at)}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        {d.role === "owner" ? (
                          <Select
                            value={m.role}
                            onChange={(e) =>
                              changeRole(m.user_id, e.target.value as Role)
                            }
                            aria-label={`Change role for ${m.email}`}
                            className="text-[11px] py-1 px-2"
                          >
                            <option value="viewer">viewer</option>
                            <option value="editor">editor</option>
                            <option value="owner">owner</option>
                          </Select>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
                            <RoleIcon role={m.role} />
                            {m.role}
                          </span>
                        )}
                        {d.role === "owner" ? (
                          <Button
                            variant="danger"
                            onClick={() => removeMember(m.user_id)}
                            aria-label={`Remove ${m.email}`}
                          >
                            <Trash weight="duotone" size={13} />
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>

              {/* Pending invites */}
              <Card>
                <CardHeader
                  title="pending invites"
                  hint={`${pendingInvites.length} waiting`}
                />
                {pendingInvites.length === 0 ? (
                  <Empty
                    icon={<PaperPlaneTilt weight="duotone" size={24} />}
                    title="No pending invites"
                    hint="Send one above to add a teammate."
                  />
                ) : (
                  <ul className="divide-y divide-[var(--color-border)]">
                    {pendingInvites.map((i) => (
                      <li
                        key={i.id}
                        className="px-4 py-3 flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0 flex flex-col">
                          <span className="text-[13px] font-mono truncate">{i.email}</span>
                          <span className="text-[11px] text-[var(--color-muted)] inline-flex items-center gap-2">
                            <RoleIcon role={i.role} /> {i.role}
                            <MonoChip>{fmtUntil(i.expires_at)}</MonoChip>
                          </span>
                        </div>
                        {d.role === "owner" ? (
                          <Button variant="ghost" onClick={() => revoke(i.id)}>
                            <Trash weight="duotone" size={13} /> Revoke
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </>);
            })()}
        </div>
      </div>

      {toast ? (
        <div className="fixed bottom-4 right-4 z-50 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-[12px] shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function WorkspaceSettingsCard({
  workspace,
  role,
  onRename,
  onDelete,
}: {
  workspace: { id: string; name: string; created_at: number; created_by: string };
  role: Role;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => Promise<void>;
}) {
  const [name, setName] = useState(workspace.name);
  const [saving, setSaving] = useState(false);
  const isOwner = role === "owner";
  const dirty = name.trim() !== workspace.name && name.trim().length > 0;

  return (
    <Card>
      <CardHeader
        title="workspace settings"
        hint="Rename or permanently delete this workspace."
      />
      <div className="p-4 flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label
            htmlFor={`ws-name-${workspace.id}`}
            className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]"
          >
            Name
          </label>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <Input
              id={`ws-name-${workspace.id}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              disabled={!isOwner || saving}
              className="md:flex-1"
            />
            <Button
              variant="primary"
              disabled={!isOwner || !dirty || saving}
              onClick={async () => {
                setSaving(true);
                const ok = await onRename(name.trim());
                setSaving(false);
                if (!ok) setName(workspace.name);
              }}
            >
              <Check weight="duotone" size={13} /> Save
            </Button>
          </div>
          {!isOwner ? (
            <span className="text-[11px] text-[var(--color-muted)]">
              Only owners can rename the workspace.
            </span>
          ) : null}
        </div>

        {isOwner ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="flex items-start gap-2">
              <Warning weight="duotone" size={16} className="text-red-500 mt-0.5" />
              <div className="flex flex-col">
                <span className="text-[12px] font-medium">Delete workspace</span>
                <span className="text-[11px] text-[var(--color-muted)]">
                  Removes the workspace, all memberships, and pending invites. This cannot be undone.
                </span>
              </div>
            </div>
            <Button variant="danger" onClick={onDelete}>
              <Trash weight="duotone" size={13} /> Delete
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
