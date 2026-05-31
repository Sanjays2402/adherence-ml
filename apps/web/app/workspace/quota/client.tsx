"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  ArrowLeft,
  Gauge,
  Lightning,
  ShieldCheck,
  UsersThree,
  Warning,
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorBox,
  Input,
  PageHeader,
  Select,
  Skeleton,
} from "@/components/ui/primitives";

type PlanInfo = {
  name: string;
  monthly_predictions: number;
  seats: number;
  member_seats?: number;
};

type QuotaView = {
  tenant_id: string;
  plan: string;
  monthly_predictions_limit: number;
  monthly_predictions_used: number;
  monthly_predictions_remaining: number;
  seats_limit: number;
  seats_used: number;
  seats_remaining: number;
  member_seats_limit: number;
  member_seats_used: number;
  member_seats_remaining: number;
  members: number;
  pending_invitations: number;
  plans: PlanInfo[];
};

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (r.status === 401) throw new Error("Sign in to view quota.");
  if (r.status === 403) throw new Error("You do not have access to this workspace's quota.");
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.detail ?? `request failed (${r.status})`);
  }
  return r.json();
};

function fmt(n: number): string {
  return n.toLocaleString();
}

function pct(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

function barTone(p: number): string {
  if (p >= 95) return "bg-rose-500";
  if (p >= 80) return "bg-amber-500";
  return "bg-emerald-500";
}

export default function QuotaClient() {
  const { data, error, isLoading, mutate } = useSWR<QuotaView>(
    "/api/quota/me",
    fetcher,
    { revalidateOnFocus: false },
  );

  const [plan, setPlan] = useState<string>("");
  const [override, setOverride] = useState<string>("");
  const [memberOverride, setMemberOverride] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [adminErr, setAdminErr] = useState<string | null>(null);
  const [adminOk, setAdminOk] = useState<string | null>(null);

  const save = useCallback(async () => {
    if (!data) return;
    setSaving(true);
    setAdminErr(null);
    setAdminOk(null);
    const body: Record<string, unknown> = {};
    if (plan) body.plan = plan;
    if (override.trim() !== "") {
      const n = Number(override);
      if (!Number.isFinite(n) || n < 0) {
        setSaving(false);
        setAdminErr("Override must be a non-negative number. Use 0 to clear.");
        return;
      }
      body.monthly_predictions_override = n;
    }
    if (memberOverride.trim() !== "") {
      const n = Number(memberOverride);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        setSaving(false);
        setAdminErr("Member seat override must be a non-negative integer. Use 0 to clear.");
        return;
      }
      body.member_seats_override = n;
    }
    if (Object.keys(body).length === 0) {
      setSaving(false);
      setAdminErr("Pick a plan or set an override before saving.");
      return;
    }
    try {
      const r = await fetch(
        `/api/admin/quota/${encodeURIComponent(data.tenant_id)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail =
          typeof j?.detail === "string"
            ? j.detail
            : j?.detail?.error || `save failed (${r.status})`;
        throw new Error(detail);
      }
      setAdminOk("Plan updated.");
      setPlan("");
      setOverride("");
      setMemberOverride("");
      mutate();
    } catch (e) {
      setAdminErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [data, plan, override, memberOverride, mutate]);

  return (
    <div>
      <PageHeader
        eyebrow="billing // workspace quotas"
        title="Plan and prediction quota"
        description="Each workspace has a monthly prediction budget. Counters reset on the first of the month, UTC. Overage returns HTTP 429 with Retry-After."
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
          <CardHeader
            title="this billing period"
            hint="UTC calendar month. Headers X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset on every prediction."
          />
          <div className="p-4">
            {isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-4 w-64" />
              </div>
            ) : error ? (
              <ErrorBox message={(error as Error).message} />
            ) : !data ? (
              <ErrorBox message="No quota data returned." />
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Gauge weight="duotone" size={18} />
                    <div className="text-[14px] font-medium">
                      {fmt(data.monthly_predictions_used)} of{" "}
                      {fmt(data.monthly_predictions_limit)} predictions used
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge>
                      <Lightning weight="duotone" size={12} /> plan: {data.plan}
                    </Badge>
                    <Badge>
                      <ShieldCheck weight="duotone" size={12} /> seats: {fmt(data.seats_used)}/{fmt(data.seats_limit)}
                    </Badge>
                  </div>
                </div>

                <div
                  className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={data.monthly_predictions_limit}
                  aria-valuenow={data.monthly_predictions_used}
                >
                  <div
                    className={`h-full ${barTone(pct(data.monthly_predictions_used, data.monthly_predictions_limit))}`}
                    style={{
                      width: `${pct(data.monthly_predictions_used, data.monthly_predictions_limit)}%`,
                    }}
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-3">
                  <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                    <div className="text-[var(--color-text-muted)]">remaining</div>
                    <div className="mt-1 font-mono text-[14px]">
                      {fmt(data.monthly_predictions_remaining)}
                    </div>
                  </div>
                  <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                    <div className="text-[var(--color-text-muted)]">workspace</div>
                    <div className="mt-1 font-mono text-[14px]">{data.tenant_id}</div>
                  </div>
                  <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                    <div className="text-[var(--color-text-muted)]">plan</div>
                    <div className="mt-1 font-mono text-[14px]">{data.plan}</div>
                  </div>
                </div>

                <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                  <div className="flex items-center justify-between text-[12px]">
                    <div className="text-[var(--color-text-muted)]">seats</div>
                    <div className="font-mono">
                      {fmt(data.seats_used)} / {fmt(data.seats_limit)}
                    </div>
                  </div>
                  <div
                    className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={data.seats_limit}
                    aria-valuenow={data.seats_used}
                  >
                    <div
                      className={`h-full ${barTone(pct(data.seats_used, data.seats_limit))}`}
                      style={{
                        width: `${pct(data.seats_used, data.seats_limit)}%`,
                      }}
                    />
                  </div>
                  <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
                    Each active API key in this workspace consumes one seat.
                    Revoke unused keys to free a seat. Attempting to issue a
                    key past the cap returns HTTP 402.
                  </div>
                </div>

                {data.seats_remaining === 0 ? (
                  <div className="flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-[12px]">
                    <Warning weight="duotone" size={14} />
                    <div>
                      Seat cap reached. New API key creation will be rejected
                      with HTTP 402 until a key is revoked or the plan is
                      upgraded.
                    </div>
                  </div>
                ) : null}

                <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                  <div className="flex items-center justify-between text-[12px]">
                    <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
                      <UsersThree weight="duotone" size={13} /> people seats
                    </div>
                    <div className="font-mono">
                      {fmt(data.member_seats_used)} / {fmt(data.member_seats_limit)}
                    </div>
                  </div>
                  <div
                    className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={data.member_seats_limit}
                    aria-valuenow={data.member_seats_used}
                  >
                    <div
                      className={`h-full ${barTone(pct(data.member_seats_used, data.member_seats_limit))}`}
                      style={{
                        width: `${pct(data.member_seats_used, data.member_seats_limit)}%`,
                      }}
                    />
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-[var(--color-text-muted)] sm:grid-cols-3">
                    <div>
                      members <span className="ml-1 font-mono text-[var(--color-text)]">{fmt(data.members)}</span>
                    </div>
                    <div>
                      pending invites <span className="ml-1 font-mono text-[var(--color-text)]">{fmt(data.pending_invitations)}</span>
                    </div>
                    <div>
                      remaining <span className="ml-1 font-mono text-[var(--color-text)]">{fmt(data.member_seats_remaining)}</span>
                    </div>
                  </div>
                  <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
                    People seats count every workspace member plus every pending
                    invitation. Adding a member or sending another invite past
                    the cap returns HTTP 409 with code member_seat_limit.
                  </div>
                </div>

                {data.member_seats_remaining === 0 ? (
                  <div className="flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-[12px]">
                    <Warning weight="duotone" size={14} />
                    <div>
                      People seat cap reached. New invitations and member
                      additions will be rejected with HTTP 409 until an invite
                      is revoked, a member is removed, or the plan is upgraded.
                    </div>
                  </div>
                ) : null}

                {pct(
                  data.monthly_predictions_used,
                  data.monthly_predictions_limit,
                ) >= 80 ? (
                  <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-[12px]">
                    <Warning weight="duotone" size={14} />
                    <div>
                      You are nearing this period's cap. New predictions past
                      the limit return HTTP 429 with a Retry-After pointing at
                      the next month rollover.
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="plans"
            hint="Catalog ships with the API. Enterprise contracts get per-workspace overrides."
          />
          <div className="p-4">
            {data ? (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead className="text-left text-[var(--color-text-muted)]">
                    <tr>
                      <th className="py-1.5 pr-3">name</th>
                      <th className="py-1.5 pr-3">monthly predictions</th>
                      <th className="py-1.5 pr-3">api key seats</th>
                      <th className="py-1.5 pr-3">people seats</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.plans.map((p) => (
                      <tr
                        key={p.name}
                        className="border-t border-[var(--color-border)]"
                      >
                        <td className="py-2 pr-3 font-mono">{p.name}</td>
                        <td className="py-2 pr-3 font-mono">
                          {fmt(p.monthly_predictions)}
                        </td>
                        <td className="py-2 pr-3 font-mono">{fmt(p.seats)}</td>
                        <td className="py-2 pr-3 font-mono">{fmt(p.member_seats ?? 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Skeleton className="h-16 w-full" />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="change plan"
            hint="Admin only. Requires the admin role on this workspace. Audit-logged."
          />
          <div className="space-y-3 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]">
                  plan
                </label>
                <Select
                  value={plan}
                  onChange={(e) => setPlan(e.target.value)}
                  aria-label="Plan"
                >
                  <option value="">keep current</option>
                  {data?.plans.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]">
                  custom monthly cap (0 clears)
                </label>
                <Input
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder="e.g. 500000"
                  value={override}
                  onChange={(e) => setOverride(e.target.value)}
                  aria-label="Custom monthly prediction override"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]">
                  custom people seat cap (0 clears)
                </label>
                <Input
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder="e.g. 75"
                  value={memberOverride}
                  onChange={(e) => setMemberOverride(e.target.value)}
                  aria-label="Custom people seat override"
                />
              </div>
            </div>
            {adminErr ? <ErrorBox message={adminErr} /> : null}
            {adminOk ? (
              <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-[12px]">
                {adminOk}
              </div>
            ) : null}
            <div>
              <Button
                onClick={save}
                disabled={
                  saving ||
                  (!plan && override.trim() === "" && memberOverride.trim() === "")
                }
              >
                {saving ? "Saving..." : "Save changes"}
              </Button>
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              If the API returns 403 here, you are not an admin on this
              workspace. Ask the workspace owner.
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
