"use client";

/**
 * Owner-only admin console. One page that aggregates members, pending
 * invites, active sessions, API keys, the most recent audit entries,
 * usage, and the workspace security policy/SSO snapshot. Calls a single
 * server endpoint (/api/admin/overview) that enforces owner-role.
 *
 * Designed for SOC2/procurement review: a buyer can ask "show me who can
 * touch this workspace right now and what they've been doing" and the
 * owner has a single screen to answer.
 */

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ShieldStar,
  UsersThree,
  Key,
  ClockCounterClockwise,
  ChartLineUp,
  PaperPlaneTilt,
  Crown,
  PencilLine,
  Eye,
  Globe,
  Lock,
  CheckCircle,
  WarningCircle,
  Lightning,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Empty,
  Skeleton,
  ErrorBox,
  MonoChip,
  Badge,
  Select,
} from "@/components/ui/primitives";

type Role = "owner" | "editor" | "viewer";

interface Workspace {
  id: string;
  name: string;
  created_at: number;
}
interface Member {
  user_id: string;
  email: string;
  role: Role;
  joined_at: number;
}
interface Invite {
  id: string;
  email: string;
  role: Role;
  created_at: number;
  expires_at: number;
}
interface SessionInfo {
  sid: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
}
interface MemberSessions {
  user_id: string;
  email: string;
  role: Role;
  sessions: SessionInfo[];
}
interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  expires_at: number | null;
  daily_quota: number | null;
}
interface AuditItem {
  id: string;
  ts: number;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  target: string | null;
  outcome: "success" | "failure" | "denied";
  ip: string | null;
}
interface Overview {
  workspace: Workspace;
  role: Role;
  members: Member[];
  invites: Invite[];
  sessions: MemberSessions[];
  api_keys: ApiKey[];
  audit: { items: AuditItem[]; chain_valid: boolean; tip_hash: string | null };
  usage: {
    quota: number;
    used_today: number;
    remaining_today: number;
    pct_today: number;
    used_30d: number;
  };
  policy: Record<string, unknown> | null;
  sso: Record<string, unknown> | null;
}

interface WorkspaceListItem {
  id: string;
  name: string;
  role: Role;
}

const fetcher = async (url: string) => {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = typeof body?.detail === "string" ? body.detail : `HTTP ${r.status}`;
    const err = new Error(detail);
    (err as Error & { status?: number }).status = r.status;
    throw err;
  }
  return body;
};

function fmtTs(ts: number | null | undefined): string {
  if (!ts) return "never";
  const d = new Date(ts);
  return d.toLocaleString();
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function RoleBadge({ role }: { role: Role }) {
  const Icon = role === "owner" ? Crown : role === "editor" ? PencilLine : Eye;
  return (
    <Badge>
      <Icon weight="duotone" size={12} />
      <span>{role}</span>
    </Badge>
  );
}

function OutcomeBadge({ outcome }: { outcome: AuditItem["outcome"] }) {
  if (outcome === "success") {
    return (
      <Badge tone="success">
        <CheckCircle weight="duotone" size={12} /> ok
      </Badge>
    );
  }
  if (outcome === "denied") {
    return (
      <Badge tone="warn">
        <Lock weight="duotone" size={12} /> deny
      </Badge>
    );
  }
  return (
    <Badge tone="danger">
      <WarningCircle weight="duotone" size={12} /> fail
    </Badge>
  );
}

export default function AdminClient() {
  const { data: wsList, error: wsErr, isLoading: wsLoading } = useSWR<{
    items: WorkspaceListItem[];
  }>("/api/workspaces", fetcher);

  const ownedWorkspaces = useMemo(
    () => wsList?.items.filter((w) => w.role === "owner") ?? [],
    [wsList],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedId && ownedWorkspaces.length > 0) {
      setSelectedId(ownedWorkspaces[0]!.id);
    }
  }, [ownedWorkspaces, selectedId]);

  const {
    data,
    error,
    isLoading,
  } = useSWR<Overview>(
    selectedId ? `/api/admin/overview?workspace_id=${encodeURIComponent(selectedId)}` : null,
    fetcher,
    { refreshInterval: 30_000 },
  );

  const header = (
    <PageHeader
      eyebrow="admin"
      title="Admin console"
      description="Members, sessions, keys, audit, and usage for the workspaces you own."
      actions={
        ownedWorkspaces.length > 1 ? (
          <Select
            value={selectedId ?? ""}
            onChange={(e) => setSelectedId(e.target.value)}
            aria-label="Select workspace"
          >
            {ownedWorkspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        ) : null
      }
    />
  );

  if (wsLoading) {
    return (
      <main className="mx-auto max-w-6xl">
        {header}
        <div className="grid gap-4 p-6">
          <Skeleton className="h-32" />
          <Skeleton className="h-64" />
        </div>
      </main>
    );
  }

  if (wsErr) {
    return (
      <main className="mx-auto max-w-6xl">
        {header}
        <div className="p-6">
          <ErrorBox message={`Failed to load workspaces: ${(wsErr as Error).message}`} />
        </div>
      </main>
    );
  }

  if (ownedWorkspaces.length === 0) {
    return (
      <main className="mx-auto max-w-6xl">
        {header}
        <div className="p-6">
          <Card>
            <Empty
              icon={<ShieldStar weight="duotone" size={28} />}
              title="No workspaces you own"
              hint="The admin console is reserved for the workspace owner. Create a workspace from workspace settings or ask an existing owner to transfer ownership."
            />
            <div className="px-6 pb-6 text-center">
              <Link
                href="/workspace"
                className="text-xs underline text-[var(--color-muted)] hover:text-[var(--color-fg)]"
              >
                go to workspace settings
              </Link>
            </div>
          </Card>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl">
      {header}
      <div className="p-4 sm:p-6">
        {isLoading && !data ? (
          <div className="grid gap-4">
            <Skeleton className="h-32" />
            <Skeleton className="h-64" />
            <Skeleton className="h-48" />
          </div>
        ) : error ? (
          <ErrorBox message={`Failed to load overview: ${(error as Error).message}`} />
        ) : data ? (
          <div className="grid gap-6">
            <UsageStrip data={data} />
            <PolicyStrip data={data} />
            <MembersCard data={data} />
            <SessionsCard data={data} />
            <KeysCard data={data} />
            <AuditCard data={data} />
          </div>
        ) : null}
      </div>
    </main>
  );
}

function StatTile({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.16em] text-[var(--color-muted)]">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-xl font-mono font-medium tabular-nums">{value}</div>
      {hint ? (
        <div className="mt-0.5 text-xs text-[var(--color-muted)] tabular-nums">{hint}</div>
      ) : null}
    </div>
  );
}

function UsageStrip({ data }: { data: Overview }) {
  const activeSessions = data.sessions.reduce(
    (n, m) => n + m.sessions.length,
    0,
  );
  const activeKeys = data.api_keys.filter((k) => !k.revoked_at).length;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatTile
        icon={<UsersThree weight="duotone" size={12} />}
        label="Members"
        value={data.members.length}
        hint={
          data.invites.length > 0
            ? `${data.invites.length} pending invite${data.invites.length === 1 ? "" : "s"}`
            : "no pending invites"
        }
      />
      <StatTile
        icon={<Lightning weight="duotone" size={12} />}
        label="Active sessions"
        value={activeSessions}
        hint="across all members"
      />
      <StatTile
        icon={<Key weight="duotone" size={12} />}
        label="API keys"
        value={activeKeys}
        hint={`${data.api_keys.length - activeKeys} revoked`}
      />
      <StatTile
        icon={<ChartLineUp weight="duotone" size={12} />}
        label="Today's usage"
        value={`${data.usage.used_today}/${data.usage.quota}`}
        hint={`${Math.round(data.usage.pct_today * 100)}% of quota`}
      />
    </div>
  );
}

function PolicyStrip({ data }: { data: Overview }) {
  const policy = (data.policy ?? {}) as Record<string, unknown>;
  const sso = data.sso as Record<string, unknown> | null;
  const enforceSso = Boolean(policy.enforce_sso);
  const sessionTtl = typeof policy.session_minutes === "number"
    ? `${policy.session_minutes} min`
    : "default";
  const retention = typeof policy.retention_days === "number"
    ? `${policy.retention_days} days`
    : "indefinite";
  const residency = typeof policy.data_residency === "string"
    ? (policy.data_residency as string)
    : "default";
  const allowlist = Array.isArray(policy.ip_allowlist) ? (policy.ip_allowlist as unknown[]) : [];

  return (
    <Card>
      <CardHeader
        title="Workspace policy"
        right={
          <Link
            href="/workspace/security"
            className="text-xs underline text-[var(--color-muted)] hover:text-[var(--color-fg)]"
          >
            edit
          </Link>
        }
      />
      <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3">
        <PolicyTile label="SSO" value={sso ? "configured" : "not set"} ok={Boolean(sso)} />
        <PolicyTile label="Enforce SSO" value={enforceSso ? "on" : "off"} ok={enforceSso} />
        <PolicyTile label="Session TTL" value={sessionTtl} ok />
        <PolicyTile label="Retention" value={retention} ok />
        <PolicyTile
          label="Data residency"
          value={residency}
          ok={residency !== "default"}
        />
        <PolicyTile
          label="IP allowlist"
          value={allowlist.length > 0 ? `${allowlist.length} entr${allowlist.length === 1 ? "y" : "ies"}` : "off"}
          ok={allowlist.length > 0}
        />
      </div>
    </Card>
  );
}

function PolicyTile({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] px-3 py-2">
      <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
        {label}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-sm font-mono">
        {ok ? (
          <CheckCircle weight="duotone" size={14} className="text-[var(--color-success)]" />
        ) : (
          <WarningCircle weight="duotone" size={14} className="text-[var(--color-warn)]" />
        )}
        <span>{value}</span>
      </div>
    </div>
  );
}

function MembersCard({ data }: { data: Overview }) {
  return (
    <Card>
      <CardHeader
        title="Members"
        right={
          <Link
            href="/workspace"
            className="text-xs underline text-[var(--color-muted)] hover:text-[var(--color-fg)]"
          >
            manage
          </Link>
        }
      />
      {data.members.length === 0 ? (
        <Empty
          icon={<UsersThree weight="duotone" size={24} />}
          title="No members"
          hint="Invite teammates from workspace settings."
        />
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {data.members.map((m) => (
            <li
              key={m.user_id}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm"
            >
              <div className="flex items-center gap-2 min-w-0">
                <RoleBadge role={m.role} />
                <span className="truncate font-mono">{m.email}</span>
              </div>
              <div className="text-xs text-[var(--color-muted)] tabular-nums">
                joined {fmtTs(m.joined_at)}
              </div>
            </li>
          ))}
        </ul>
      )}
      {data.invites.length > 0 ? (
        <div className="border-t border-[var(--color-border)] p-4">
          <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)] mb-2 flex items-center gap-1.5">
            <PaperPlaneTilt weight="duotone" size={12} />
            Pending invites
          </div>
          <ul className="divide-y divide-[var(--color-border)]">
            {data.invites.map((inv) => (
              <li
                key={inv.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <RoleBadge role={inv.role} />
                  <span className="truncate font-mono">{inv.email}</span>
                </div>
                <div className="text-xs text-[var(--color-muted)] tabular-nums">
                  expires {fmtTs(inv.expires_at)}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

function SessionsCard({ data }: { data: Overview }) {
  const withSessions = data.sessions.filter((m) => m.sessions.length > 0);
  return (
    <Card>
      <CardHeader
        title="Active sessions"
        right={
          <Link
            href="/settings/sessions"
            className="text-xs underline text-[var(--color-muted)] hover:text-[var(--color-fg)]"
          >
            your sessions
          </Link>
        }
      />
      {withSessions.length === 0 ? (
        <Empty
          icon={<Lightning weight="duotone" size={24} />}
          title="No active sessions"
          hint="Nobody is signed in right now."
        />
      ) : (
        <div className="space-y-4 p-4">
          {withSessions.map((m) => (
            <div key={m.user_id}>
              <div className="flex items-center gap-2 text-sm mb-1.5">
                <RoleBadge role={m.role} />
                <span className="truncate font-mono">{m.email}</span>
                <span className="text-xs text-[var(--color-muted)]">
                  {m.sessions.length} active
                </span>
              </div>
              <ul className="space-y-1">
                {m.sessions.map((s) => (
                  <li
                    key={s.sid}
                    className="rounded-md border border-[var(--color-border)] px-3 py-2 text-xs flex flex-wrap items-center justify-between gap-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Globe weight="duotone" size={12} />
                      <MonoChip>{s.ip ?? "no ip"}</MonoChip>
                      <span className="truncate text-[var(--color-muted)] max-w-[20rem]">
                        {s.user_agent ?? "no UA"}
                      </span>
                    </div>
                    <div className="tabular-nums text-[var(--color-muted)]">
                      last seen {relTime(s.last_seen_at)}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function KeysCard({ data }: { data: Overview }) {
  return (
    <Card>
      <CardHeader
        title="API keys"
        right={
          <Link
            href="/api-keys"
            className="text-xs underline text-[var(--color-muted)] hover:text-[var(--color-fg)]"
          >
            manage
          </Link>
        }
      />
      {data.api_keys.length === 0 ? (
        <Empty
          icon={<Key weight="duotone" size={24} />}
          title="No API keys"
          hint="Issue one from the API keys page to start calling /v1/predict."
        />
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {data.api_keys.map((k) => (
            <li
              key={k.id}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm"
            >
              <div className="flex items-center gap-2 min-w-0">
                <MonoChip>{k.prefix}</MonoChip>
                <span className="truncate font-mono">{k.name}</span>
                {k.revoked_at ? (
                  <Badge tone="danger">revoked</Badge>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {k.scopes.map((s) => (
                      <Badge key={s}>{s}</Badge>
                    ))}
                  </div>
                )}
              </div>
              <div className="text-xs text-[var(--color-muted)] tabular-nums">
                last used {k.last_used_at ? relTime(k.last_used_at) : "never"}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AuditCard({ data }: { data: Overview }) {
  return (
    <Card>
      <CardHeader
        title="Recent audit"
        right={
          <div className="flex items-center gap-3">
            {data.audit.chain_valid ? (
              <Badge tone="success">
                <CheckCircle weight="duotone" size={12} /> chain ok
              </Badge>
            ) : (
              <Badge tone="danger">
                <WarningCircle weight="duotone" size={12} /> chain broken
              </Badge>
            )}
            <Link
              href="/audit"
              className="text-xs underline text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            >
              full log
            </Link>
          </div>
        }
      />
      {data.audit.items.length === 0 ? (
        <Empty
          icon={<ClockCounterClockwise weight="duotone" size={24} />}
          title="No audit entries"
          hint="Mutating actions will appear here as they happen."
        />
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {data.audit.items.slice(0, 25).map((e) => (
            <li
              key={e.id}
              className="grid grid-cols-[auto_1fr_auto] items-center gap-2 px-4 py-2 text-sm"
            >
              <OutcomeBadge outcome={e.outcome} />
              <div className="min-w-0">
                <div className="truncate font-mono">{e.action}</div>
                <div className="truncate text-xs text-[var(--color-muted)]">
                  {e.actor_email ?? "system"}
                  {e.target ? ` / ${e.target}` : ""}
                  {e.ip ? ` / ${e.ip}` : ""}
                </div>
              </div>
              <div className="text-xs text-[var(--color-muted)] tabular-nums whitespace-nowrap">
                {relTime(e.ts)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
