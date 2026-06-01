"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowClockwise,
  Lock,
  LockOpen,
  Prohibit,
  ShieldCheck,
  Info,
} from "@phosphor-icons/react";
import {
  Button,
  Card,
  CardHeader,
  ErrorBox,
  Empty,
  Skeleton,
  Badge,
  Input,
  Select,
  MonoChip,
} from "@/components/ui/primitives";

type Policy = {
  tenant_id: string;
  require_grant: boolean;
  updated_at: number | null;
  updated_by: string | null;
  min_ttl_seconds: number;
  max_ttl_seconds: number;
  default_ttl_seconds: number;
};

type Grant = {
  id: number;
  public_id: string;
  tenant_id: string;
  grantee_sub: string | null;
  reason: string;
  granted_by: string;
  granted_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
  last_used_at: number | null;
  use_count: number;
  is_active: boolean;
};

type GrantList = {
  tenant_id: string;
  grants: Grant[];
  include_inactive: boolean;
};

const fetcher = (url: string) =>
  fetch(url).then(async (r) => {
    if (!r.ok) {
      const d = (await r.json().catch(() => ({}))) as { detail?: unknown };
      const msg =
        typeof d.detail === "string"
          ? d.detail
          : d.detail
            ? JSON.stringify(d.detail)
            : `HTTP ${r.status}`;
      throw new Error(msg);
    }
    return r.json();
  });

function fmtTs(sec: number | null): string {
  if (!sec) return "never";
  return new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function fmtCountdown(sec: number): string {
  const delta = sec - Math.floor(Date.now() / 1000);
  if (delta <= 0) return "expired";
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}

const TTL_OPTIONS: Array<{ label: string; seconds: number }> = [
  { label: "15 minutes", seconds: 15 * 60 },
  { label: "1 hour", seconds: 60 * 60 },
  { label: "4 hours", seconds: 4 * 60 * 60 },
  { label: "24 hours", seconds: 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
];

export default function SupportAccessClient() {
  const {
    data: policy,
    error: policyErr,
    isLoading: policyLoading,
    mutate: refetchPolicy,
  } = useSWR<Policy>("/api/workspace/support-access/policy", fetcher, {
    revalidateOnFocus: true,
  });

  const [includeInactive, setIncludeInactive] = useState(false);
  const grantsKey = `/api/workspace/support-access/grants?include_inactive=${includeInactive}`;
  const {
    data: grants,
    error: grantsErr,
    isLoading: grantsLoading,
    mutate: refetchGrants,
  } = useSWR<GrantList>(grantsKey, fetcher, { revalidateOnFocus: true });

  const [mfa, setMfa] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  // grant form
  const [reason, setReason] = useState("");
  const [ttlSeconds, setTtlSeconds] = useState<number>(60 * 60);
  const [granteeSub, setGranteeSub] = useState("");

  const requireGrant = !!policy?.require_grant;

  const headers = useMemo(() => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (mfa.trim()) h["X-MFA-Code"] = mfa.trim();
    return h;
  }, [mfa]);

  async function togglePolicy() {
    if (!policy) return;
    setBusy("policy");
    setMsg(null);
    try {
      const r = await fetch("/api/workspace/support-access/policy", {
        method: "PUT",
        headers,
        body: JSON.stringify({ require_grant: !requireGrant }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        detail?: unknown;
      };
      if (!r.ok) {
        const m =
          typeof data.detail === "string"
            ? data.detail
            : JSON.stringify(data.detail ?? `HTTP ${r.status}`);
        throw new Error(m);
      }
      setMsg({
        kind: "ok",
        text: !requireGrant
          ? "workspace locked. vendor admins now require an active grant."
          : "workspace unlocked. cross-tenant access falls back to break-glass only.",
      });
      await refetchPolicy();
    } catch (err) {
      setMsg({
        kind: "err",
        text: err instanceof Error ? err.message : "request failed",
      });
    } finally {
      setBusy(null);
    }
  }

  async function createGrant() {
    if (reason.trim().length < 10) {
      setMsg({ kind: "err", text: "reason must be at least 10 characters" });
      return;
    }
    setBusy("create");
    setMsg(null);
    try {
      const r = await fetch("/api/workspace/support-access/grants", {
        method: "POST",
        headers,
        body: JSON.stringify({
          reason: reason.trim(),
          ttl_seconds: ttlSeconds,
          grantee_sub: granteeSub.trim() || null,
        }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        detail?: unknown;
        public_id?: string;
      };
      if (!r.ok) {
        const m =
          typeof data.detail === "string"
            ? data.detail
            : JSON.stringify(data.detail ?? `HTTP ${r.status}`);
        throw new Error(m);
      }
      setMsg({
        kind: "ok",
        text: `grant issued: ${data.public_id ?? ""}`,
      });
      setReason("");
      setGranteeSub("");
      await refetchGrants();
    } catch (err) {
      setMsg({
        kind: "err",
        text: err instanceof Error ? err.message : "request failed",
      });
    } finally {
      setBusy(null);
    }
  }

  async function revokeGrant(publicId: string) {
    if (!confirm(`Revoke grant ${publicId}? Active sessions using it will be denied on next request.`)) {
      return;
    }
    setBusy(`revoke:${publicId}`);
    setMsg(null);
    try {
      const r = await fetch(
        `/api/workspace/support-access/grants/${encodeURIComponent(publicId)}/revoke`,
        { method: "POST", headers },
      );
      const data = (await r.json().catch(() => ({}))) as {
        detail?: unknown;
      };
      if (!r.ok) {
        const m =
          typeof data.detail === "string"
            ? data.detail
            : JSON.stringify(data.detail ?? `HTTP ${r.status}`);
        throw new Error(m);
      }
      setMsg({ kind: "ok", text: `grant ${publicId} revoked` });
      await refetchGrants();
    } catch (err) {
      setMsg({
        kind: "err",
        text: err instanceof Error ? err.message : "request failed",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex items-center gap-3 text-sm text-zinc-500">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 hover:text-zinc-200"
        >
          <ArrowLeft size={14} weight="duotone" />
          settings
        </Link>
        <span className="text-zinc-700">/</span>
        <span className="text-zinc-300">support access</span>
      </div>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
          vendor support access
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
          Lock the workspace so adherence.ml support engineers cannot reach
          your tenant unless you have issued an active, time-bound grant. Every
          grant is auditable, revocable, and applied before the break-glass
          justification check.
        </p>
      </header>

      {/* Lock toggle */}
      <Card className="mb-6">
        <CardHeader
          title="lock-down policy"
          hint="when on, cross-tenant admin access requires an active grant from this page"
        />
        <div className="px-5 py-4">
          {policyLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : policyErr ? (
            <ErrorBox message={(policyErr as Error).message} />
          ) : policy ? (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                {requireGrant ? (
                  <Lock size={22} weight="duotone" className="text-emerald-400" />
                ) : (
                  <LockOpen size={22} weight="duotone" className="text-amber-400" />
                )}
                <div>
                  <div className="text-sm font-medium text-zinc-100">
                    {requireGrant ? "locked" : "unlocked"}
                  </div>
                  <div className="text-xs text-zinc-500">
                    updated {fmtTs(policy.updated_at)}{" "}
                    {policy.updated_by ? `by ${policy.updated_by}` : ""}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  placeholder="MFA code"
                  value={mfa}
                  onChange={(e) => setMfa(e.target.value)}
                  className="w-32"
                  aria-label="six digit MFA code"
                  inputMode="numeric"
                />
                <Button
                  onClick={togglePolicy}
                  disabled={busy !== null}
                  variant={requireGrant ? "ghost" : "primary"}
                >
                  {busy === "policy"
                    ? "..."
                    : requireGrant
                      ? "unlock"
                      : "lock workspace"}
                </Button>
              </div>
            </div>
          ) : null}
          <div className="mt-3 flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400">
            <Info size={14} weight="duotone" className="mt-0.5 flex-shrink-0" />
            <span>
              Toggling this policy requires an admin MFA code. Locking the
              workspace takes effect immediately for new cross-tenant requests.
            </span>
          </div>
        </div>
      </Card>

      {/* Create grant */}
      <Card className="mb-6">
        <CardHeader
          title="issue a grant"
          hint="authorise a vendor admin for a bounded window"
        />
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
          <label className="sm:col-span-2 text-xs text-zinc-400">
            reason
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="ticket 9921: debug ingestion lag on /v1/predict"
              className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
            />
            <span className="mt-1 block text-[10px] text-zinc-600">
              {reason.length}/1000, minimum 10
            </span>
          </label>
          <label className="text-xs text-zinc-400">
            valid for
            <Select
              value={String(ttlSeconds)}
              onChange={(e) => setTtlSeconds(Number(e.target.value))}
              className="mt-1"
            >
              {TTL_OPTIONS.map((o) => (
                <option key={o.seconds} value={o.seconds}>
                  {o.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-xs text-zinc-400">
            grantee subject (optional)
            <Input
              value={granteeSub}
              onChange={(e) => setGranteeSub(e.target.value)}
              placeholder="api-key:vendor-support"
              className="mt-1"
            />
            <span className="mt-1 block text-[10px] text-zinc-600">
              leave blank to allow any vendor admin
            </span>
          </label>
          <div className="sm:col-span-2 flex items-center gap-2">
            <Input
              placeholder="MFA code"
              value={mfa}
              onChange={(e) => setMfa(e.target.value)}
              className="w-32"
              aria-label="six digit MFA code"
              inputMode="numeric"
            />
            <Button
              onClick={createGrant}
              disabled={busy !== null || reason.trim().length < 10}
              variant="primary"
            >
              {busy === "create" ? "issuing..." : "issue grant"}
            </Button>
          </div>
        </div>
      </Card>

      {msg ? (
        <div
          className={
            "mb-4 rounded-md border px-3 py-2 text-xs " +
            (msg.kind === "ok"
              ? "border-emerald-900/50 bg-emerald-950/30 text-emerald-200"
              : "border-rose-900/50 bg-rose-950/30 text-rose-200")
          }
          role="status"
        >
          {msg.text}
        </div>
      ) : null}

      {/* Grants list */}
      <Card>
        <CardHeader
          title="grants"
          hint="active grants currently authorising vendor access"
          right={
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={includeInactive}
                  onChange={(e) => setIncludeInactive(e.target.checked)}
                  className="accent-zinc-500"
                />
                show revoked and expired
              </label>
              <Button
                onClick={() => refetchGrants()}
                variant="ghost"
                aria-label="refresh"
              >
                <ArrowClockwise size={14} weight="duotone" />
              </Button>
            </div>
          }
        />
        <div className="px-5 py-4">
          {grantsLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : grantsErr ? (
            <ErrorBox message={(grantsErr as Error).message} />
          ) : !grants || grants.grants.length === 0 ? (
            <Empty
              title="no grants"
              hint={
                requireGrant
                  ? "the workspace is locked. issue a grant above to let support engineers in."
                  : "the workspace is unlocked. issuing a grant is optional today."
              }
              icon={<ShieldCheck size={28} weight="duotone" />}
            />
          ) : (
            <ul className="divide-y divide-zinc-900">
              {grants.grants.map((g) => (
                <li key={g.public_id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <MonoChip>{g.public_id}</MonoChip>
                      {g.is_active ? (
                        <Badge tone="success">active {fmtCountdown(g.expires_at)}</Badge>
                      ) : g.revoked_at ? (
                        <Badge tone="neutral">revoked</Badge>
                      ) : (
                        <Badge tone="warn">expired</Badge>
                      )}
                      {g.grantee_sub ? (
                        <Badge tone="neutral">{g.grantee_sub}</Badge>
                      ) : (
                        <Badge tone="warn">any admin</Badge>
                      )}
                      <span className="text-[11px] text-zinc-500">
                        used {g.use_count}x
                        {g.last_used_at ? `, last ${fmtTs(g.last_used_at)}` : ""}
                      </span>
                    </div>
                    <div className="mt-1 text-sm text-zinc-200 break-words">
                      {g.reason}
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-500">
                      granted {fmtTs(g.granted_at)} by {g.granted_by} &middot; expires {fmtTs(g.expires_at)}
                      {g.revoked_at
                        ? ` \u00b7 revoked ${fmtTs(g.revoked_at)} by ${g.revoked_by ?? "?"}`
                        : ""}
                    </div>
                  </div>
                  {g.is_active ? (
                    <Button
                      onClick={() => revokeGrant(g.public_id)}
                      disabled={busy !== null}
                      variant="ghost"
                      aria-label={`revoke ${g.public_id}`}
                    >
                      <Prohibit size={14} weight="duotone" />
                      {busy === `revoke:${g.public_id}` ? "revoking..." : "revoke"}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}
