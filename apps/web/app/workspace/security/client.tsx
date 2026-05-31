"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ShieldCheck,
  Clock,
  Lock,
  FloppyDisk,
  Warning,
  CheckCircle,
  ArrowSquareOut,
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
} from "@/components/ui/primitives";

type Role = "owner" | "editor" | "viewer";
type WorkspaceListItem = { id: string; name: string; role: Role };

interface PublicPolicy {
  session_max_age_minutes: number | null;
  require_mfa: boolean;
  updated_at: number;
}

interface PolicyResp {
  policy: PublicPolicy;
  role: Role;
  limits: { min_session_minutes: number; max_session_minutes: number };
}

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (r.status === 401) throw new Error("Sign in to manage workspace security.");
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.detail ?? `request failed (${r.status})`);
  }
  return r.json();
};

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)] mb-1.5">
      {children}
    </div>
  );
}

function fmtUpdated(ms: number): string {
  if (!ms) return "never";
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

export default function SecurityClient() {
  const list = useSWR<{ items: WorkspaceListItem[] }>("/api/workspaces", fetcher);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (list.data?.items?.length && !selected) {
      const owned = list.data.items.find((w) => w.role === "owner") ?? list.data.items[0];
      setSelected(owned.id);
    }
  }, [list.data, selected]);

  const policySwr = useSWR<PolicyResp>(
    selected ? `/api/workspaces/${selected}/policy` : null,
    fetcher,
  );

  const role = policySwr.data?.role ?? null;
  const policy = policySwr.data?.policy ?? null;
  const limits = policySwr.data?.limits;
  const isOwner = role === "owner";

  const [maxAgeEnabled, setMaxAgeEnabled] = useState(false);
  const [maxAgeMinutes, setMaxAgeMinutes] = useState("480");
  const [requireMfa, setRequireMfa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    setErr(null);
    setOk(null);
    if (policy) {
      const cap = policy.session_max_age_minutes;
      setMaxAgeEnabled(cap !== null);
      setMaxAgeMinutes(cap !== null ? String(cap) : "480");
      setRequireMfa(Boolean(policy.require_mfa));
    }
  }, [policy, selected]);

  const ownedWorkspaces = useMemo(
    () => (list.data?.items ?? []).filter((w) => w.role === "owner"),
    [list.data],
  );

  async function save() {
    if (!selected || !isOwner) return;
    setBusy(true);
    setErr(null);
    setOk(null);
    let n: number | null = null;
    if (maxAgeEnabled) {
      const parsed = parseInt(maxAgeMinutes, 10);
      if (!Number.isFinite(parsed)) {
        setErr("Session lifetime must be a whole number of minutes.");
        setBusy(false);
        return;
      }
      n = parsed;
    }
    try {
      const r = await fetch(`/api/workspaces/${selected}/policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_max_age_minutes: n, require_mfa: requireMfa }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail ?? `request failed (${r.status})`);
      setOk("Security policy saved. New sessions follow the updated rules immediately.");
      await policySwr.mutate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  const minM = limits?.min_session_minutes ?? 5;
  const maxM = limits?.max_session_minutes ?? 43200;

  return (
    <div className="min-h-dvh">
      <PageHeader
        eyebrow="security"
        title="Security policy"
        description="Cap session lifetime and require two-factor for every workspace member."
        actions={
          <Link href="/workspace" className="text-[11px] font-mono text-[var(--color-muted)] inline-flex items-center gap-1 hover:text-[var(--color-fg)]">
            members and invites <ArrowSquareOut weight="duotone" size={12} />
          </Link>
        }
      />
      <div className="mx-auto max-w-3xl px-4 py-6 space-y-5">
        {list.error ? <ErrorBox message={(list.error as Error).message} /> : null}

        {ownedWorkspaces.length === 0 && list.data ? (
          <Card>
            <CardHeader title="No workspaces you own" />
            <div className="px-4 py-4 text-[13px] text-[var(--color-muted)]">
              Only workspace owners can change the security policy. Ask the owner of your workspace to make you an owner, or create one of your own from the{" "}
              <Link href="/workspace" className="underline">workspace page</Link>.
            </div>
          </Card>
        ) : null}

        {ownedWorkspaces.length > 0 ? (
          <Card>
            <CardHeader title="Workspace" />
            <div className="px-4 py-3 flex flex-wrap gap-2">
              {ownedWorkspaces.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => setSelected(w.id)}
                  className={`rounded-md border px-2.5 py-1 text-[12px] font-mono ${
                    selected === w.id
                      ? "border-[var(--color-fg)] bg-[var(--color-fg)] text-[var(--color-bg)]"
                      : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]"
                  }`}
                >
                  {w.name}
                </button>
              ))}
            </div>
          </Card>
        ) : null}

        {selected && policySwr.isLoading ? (
          <Card>
            <div className="px-4 py-4 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          </Card>
        ) : null}

        {policy ? (
          <Card>
            <CardHeader
              title="Session lifetime"
              right={
                <Badge>
                  updated {fmtUpdated(policy.updated_at)}
                </Badge>
              }
            />
            <div className="px-4 py-4 space-y-4">
              <div className="flex items-start gap-3">
                <input
                  id="maxage-on"
                  type="checkbox"
                  checked={maxAgeEnabled}
                  disabled={!isOwner}
                  onChange={(e) => setMaxAgeEnabled(e.target.checked)}
                  className="mt-1 h-4 w-4 accent-[var(--color-fg)]"
                />
                <div className="flex-1 min-w-0">
                  <label htmlFor="maxage-on" className="text-[13px] font-medium cursor-pointer">
                    Cap session length
                  </label>
                  <p className="text-[12px] text-[var(--color-muted)] mt-0.5">
                    Force every member to re-authenticate after this many minutes, no matter when their cookie was minted. Default is 30 days.
                  </p>
                </div>
              </div>
              <div className="pl-7 flex items-end gap-2">
                <div className="flex-1 max-w-[200px]">
                  <Label><Clock weight="duotone" size={11} /> Minutes</Label>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={minM}
                    max={maxM}
                    step={5}
                    value={maxAgeMinutes}
                    disabled={!isOwner || !maxAgeEnabled}
                    onChange={(e) => setMaxAgeMinutes(e.target.value)}
                  />
                </div>
                <div className="pb-1 text-[11px] font-mono text-[var(--color-muted)]">
                  range {minM}-{maxM}m
                </div>
              </div>
              <div className="pl-7 text-[11px] text-[var(--color-muted)] flex flex-wrap gap-2">
                <button type="button" className="underline disabled:opacity-50" disabled={!isOwner} onClick={() => { setMaxAgeEnabled(true); setMaxAgeMinutes("60"); }}>1 hour</button>
                <button type="button" className="underline disabled:opacity-50" disabled={!isOwner} onClick={() => { setMaxAgeEnabled(true); setMaxAgeMinutes("480"); }}>8 hours</button>
                <button type="button" className="underline disabled:opacity-50" disabled={!isOwner} onClick={() => { setMaxAgeEnabled(true); setMaxAgeMinutes("1440"); }}>24 hours</button>
                <button type="button" className="underline disabled:opacity-50" disabled={!isOwner} onClick={() => { setMaxAgeEnabled(true); setMaxAgeMinutes("10080"); }}>7 days</button>
              </div>
            </div>
          </Card>
        ) : null}

        {policy ? (
          <Card>
            <CardHeader title="Two-factor authentication" />
            <div className="px-4 py-4 space-y-3">
              <div className="flex items-start gap-3">
                <input
                  id="mfa-on"
                  type="checkbox"
                  checked={requireMfa}
                  disabled={!isOwner}
                  onChange={(e) => setRequireMfa(e.target.checked)}
                  className="mt-1 h-4 w-4 accent-[var(--color-fg)]"
                />
                <div className="flex-1 min-w-0">
                  <label htmlFor="mfa-on" className="text-[13px] font-medium cursor-pointer inline-flex items-center gap-2">
                    <Lock weight="duotone" size={13} /> Require TOTP for every member
                  </label>
                  <p className="text-[12px] text-[var(--color-muted)] mt-0.5">
                    Sign-in is blocked until the member enrolls an authenticator app. Existing members without TOTP will be redirected to enroll on their next login.
                  </p>
                </div>
              </div>
              <div className="pl-7 text-[11px] text-[var(--color-muted)] inline-flex items-center gap-2">
                <Warning weight="duotone" size={12} /> Make sure you have TOTP enabled before turning this on, or you may lock yourself out.
                <Link href="/settings/security" className="underline">enroll yours</Link>
              </div>
            </div>
          </Card>
        ) : null}

        {policy ? (
          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={!isOwner || busy}>
              <FloppyDisk weight="duotone" size={13} /> {busy ? "Saving" : "Save policy"}
            </Button>
            {ok ? (
              <span className="text-[12px] text-[var(--color-muted)] inline-flex items-center gap-1.5">
                <CheckCircle weight="duotone" size={13} /> {ok}
              </span>
            ) : null}
            {err ? <ErrorBox message={err} /> : null}
            {!isOwner ? (
              <span className="text-[11px] font-mono text-[var(--color-muted)]">
                Read-only: owners change this policy.
              </span>
            ) : null}
          </div>
        ) : null}

        {policy ? (
          <Card>
            <CardHeader title="Effective on this workspace" />
            <div className="px-4 py-3 text-[12px] font-mono text-[var(--color-muted)] space-y-1">
              <div>session_max_age_minutes = <MonoChip>{policy.session_max_age_minutes ?? "unset"}</MonoChip></div>
              <div>require_mfa = <MonoChip>{String(policy.require_mfa)}</MonoChip></div>
              <div className="text-[11px] mt-2">
                When a user belongs to multiple workspaces the tightest rule wins: the lowest session cap and require_mfa from any workspace applies.
              </div>
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
