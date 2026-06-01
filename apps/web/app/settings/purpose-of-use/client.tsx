"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowClockwise,
  ShieldCheck,
  Lock,
  LockOpen,
  Eraser,
  FileText,
  Funnel,
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorBox,
  Input,
  MonoChip,
  PageHeader,
  Select,
  Skeleton,
} from "@/components/ui/primitives";

type Policy = {
  tenant_id: string;
  allowed: string[];
  enforce: boolean;
  default_purpose: string | null;
  updated_at: number;
  updated_by: string | null;
  known_codes: string[];
};

type PHIEvent = {
  id: number;
  tenant_id: string;
  created_at: string;
  request_id: string | null;
  route: string;
  method: string;
  purpose: string;
  actor: string;
  actor_role: string;
  key_name: string | null;
  client_ip: string | null;
  status_code: number;
  latency_ms: number | null;
  user_id: string | null;
  note: string | null;
};

type PHIList = {
  tenant_id: string;
  total: number;
  n: number;
  events: PHIEvent[];
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

function purposeTone(
  p: string,
): "success" | "warn" | "danger" | "neutral" {
  const up = p.toUpperCase();
  if (up === "TREATMENT") return "success";
  if (up === "EMERGENCY") return "danger";
  if (up === "RESEARCH" || up === "PUBLICHEALTH") return "warn";
  return "neutral";
}

export default function PurposeOfUseClient() {
  const {
    data: policy,
    error: policyErr,
    isLoading: policyLoading,
    mutate: refetchPolicy,
  } = useSWR<Policy>("/api/purpose-of-use", fetcher, {
    revalidateOnFocus: true,
  });

  const [draftAllowed, setDraftAllowed] = useState<Set<string> | null>(null);
  const [draftEnforce, setDraftEnforce] = useState<boolean | null>(null);
  const [draftDefault, setDraftDefault] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  const allowedNow = useMemo<Set<string>>(() => {
    if (draftAllowed) return draftAllowed;
    return new Set((policy?.allowed ?? []).map((s) => s.toUpperCase()));
  }, [draftAllowed, policy]);

  const enforceNow = draftEnforce ?? policy?.enforce ?? false;
  const defaultNow =
    draftDefault !== null ? draftDefault : (policy?.default_purpose ?? "");
  const known = policy?.known_codes ?? [
    "TREATMENT",
    "PAYMENT",
    "OPERATIONS",
    "EMERGENCY",
    "RESEARCH",
    "COVERAGE",
    "PUBLICHEALTH",
  ];

  const dirty =
    draftAllowed !== null || draftEnforce !== null || draftDefault !== null;

  const toggleCode = (code: string) => {
    const next = new Set(allowedNow);
    const up = code.toUpperCase();
    if (next.has(up)) next.delete(up);
    else next.add(up);
    setDraftAllowed(next);
  };

  const reset = () => {
    setDraftAllowed(null);
    setDraftEnforce(null);
    setDraftDefault(null);
    setMsg(null);
  };

  const save = async () => {
    setBusy("save");
    setMsg(null);
    try {
      const body = {
        allowed: Array.from(allowedNow),
        enforce: enforceNow,
        default_purpose: defaultNow ? defaultNow.toUpperCase() : null,
      };
      const r = await fetch("/api/purpose-of-use", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail =
          typeof data?.detail === "string" ? data.detail : `HTTP ${r.status}`;
        throw new Error(detail);
      }
      reset();
      await refetchPolicy();
      setMsg({ kind: "ok", text: "policy saved" });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    if (!confirm("clear the purpose-of-use policy for this workspace?")) return;
    setBusy("clear");
    setMsg(null);
    try {
      const r = await fetch("/api/purpose-of-use", { method: "DELETE" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail =
          typeof data?.detail === "string" ? data.detail : `HTTP ${r.status}`;
        throw new Error(detail);
      }
      reset();
      await refetchPolicy();
      setMsg({
        kind: "ok",
        text: data?.removed ? "policy removed" : "no policy to remove",
      });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  // PHI access log
  const [filterPurpose, setFilterPurpose] = useState("");
  const [filterActor, setFilterActor] = useState("");
  const [filterUser, setFilterUser] = useState("");
  const phiQs = new URLSearchParams();
  phiQs.set("limit", "100");
  if (filterPurpose) phiQs.set("purpose", filterPurpose);
  if (filterActor) phiQs.set("actor", filterActor);
  if (filterUser) phiQs.set("user_id", filterUser);
  const {
    data: phi,
    error: phiErr,
    isLoading: phiLoading,
    mutate: refetchPhi,
  } = useSWR<PHIList>(`/api/phi-access?${phiQs.toString()}`, fetcher, {
    revalidateOnFocus: true,
  });

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/settings"
        className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        <ArrowLeft weight="duotone" className="h-4 w-4" />
        settings
      </Link>

      <PageHeader
        eyebrow="hipaa"
        title="purpose of use"
        description="HL7 purpose-of-use policy this workspace enforces on every PHI request, plus the append-only access log."
      />

      {msg && (
        <div
          className={`mt-4 rounded-md border px-3 py-2 text-sm ${
            msg.kind === "ok"
              ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
              : "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200"
          }`}
        >
          {msg.text}
        </div>
      )}

      <Card className="mt-6">
        <CardHeader
          title="policy"
          right={
            <Button
              variant="ghost"
              onClick={() => refetchPolicy()}
              disabled={policyLoading}
              aria-label="refresh policy"
            >
              <ArrowClockwise weight="duotone" className="h-4 w-4" />
            </Button>
          }
        />
        <div className="px-4 pb-4">
          {policyLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-5 w-1/3" />
            </div>
          ) : policyErr ? (
            <ErrorBox message={(policyErr as Error).message} />
          ) : policy ? (
            <div className="space-y-5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-zinc-500">workspace</span>
                <MonoChip>{policy.tenant_id}</MonoChip>
                {policy.enforce ? (
                  <Badge tone="success">
                    <Lock weight="duotone" className="h-3.5 w-3.5" />
                    enforcing
                  </Badge>
                ) : (
                  <Badge tone="neutral">
                    <LockOpen weight="duotone" className="h-3.5 w-3.5" />
                    advisory
                  </Badge>
                )}
                <span className="ml-auto text-xs text-zinc-500">
                  updated {fmtTs(policy.updated_at)}
                  {policy.updated_by ? ` by ${policy.updated_by}` : ""}
                </span>
              </div>

              <div>
                <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
                  allowed purpose codes
                </div>
                <div className="flex flex-wrap gap-2">
                  {known.map((code) => {
                    const on = allowedNow.has(code);
                    return (
                      <button
                        key={code}
                        type="button"
                        onClick={() => toggleCode(code)}
                        className={`rounded-md border px-2.5 py-1 text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-offset-1 ${
                          on
                            ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                            : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
                        }`}
                        aria-pressed={on}
                      >
                        {code}
                      </button>
                    );
                  })}
                </div>
                {allowedNow.size === 0 && (
                  <p className="mt-2 text-xs text-zinc-500">
                    no codes selected. requests will be stamped UNKNOWN and, if
                    enforcing, rejected with HTTP 412.
                  </p>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex items-start gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                  <input
                    type="checkbox"
                    checked={enforceNow}
                    onChange={(e) => setDraftEnforce(e.target.checked)}
                    className="mt-1"
                  />
                  <div>
                    <div className="text-sm font-medium">enforce</div>
                    <div className="text-xs text-zinc-500">
                      reject PHI requests without a valid X-Purpose-Of-Use header
                      (HTTP 412).
                    </div>
                  </div>
                </label>

                <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="text-sm font-medium">default purpose</div>
                  <div className="mb-2 text-xs text-zinc-500">
                    stamped on PHI requests without the header while not
                    enforcing. must be in the allowed set.
                  </div>
                  <Select
                    value={defaultNow}
                    onChange={(e) => setDraftDefault(e.target.value)}
                  >
                    <option value="">(none)</option>
                    {Array.from(allowedNow).sort().map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={save}
                  disabled={!dirty || busy !== null}
                  aria-label="save policy"
                >
                  {busy === "save" ? "saving..." : "save"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={reset}
                  disabled={!dirty || busy !== null}
                >
                  reset
                </Button>
                <Button
                  variant="ghost"
                  onClick={clear}
                  disabled={busy !== null}
                  aria-label="clear policy"
                >
                  <Eraser weight="duotone" className="h-4 w-4" />
                  clear
                </Button>
              </div>
            </div>
          ) : (
            <Empty
              icon={<ShieldCheck weight="duotone" className="h-6 w-6" />}
              title="no policy"
              hint="no purpose-of-use policy configured for this workspace."
            />
          )}
        </div>
      </Card>

      <Card className="mt-6">
        <CardHeader
          title="PHI access log"
          right={
            <Button
              variant="ghost"
              onClick={() => refetchPhi()}
              disabled={phiLoading}
              aria-label="refresh access log"
            >
              <ArrowClockwise weight="duotone" className="h-4 w-4" />
            </Button>
          }
        />
        <div className="px-4 pb-4">
          <div className="mb-3 grid gap-2 sm:grid-cols-3">
            <div>
              <label className="mb-1 flex items-center gap-1 text-xs text-zinc-500">
                <Funnel weight="duotone" className="h-3.5 w-3.5" />
                purpose
              </label>
              <Select
                value={filterPurpose}
                onChange={(e) => setFilterPurpose(e.target.value)}
              >
                <option value="">all</option>
                {known.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">actor</label>
              <Input
                placeholder="api key name or sub"
                value={filterActor}
                onChange={(e) => setFilterActor(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">patient</label>
              <Input
                placeholder="user_id"
                value={filterUser}
                onChange={(e) => setFilterUser(e.target.value)}
              />
            </div>
          </div>

          {phiLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
            </div>
          ) : phiErr ? (
            <ErrorBox message={(phiErr as Error).message} />
          ) : !phi || phi.events.length === 0 ? (
            <Empty
              icon={<FileText weight="duotone" className="h-6 w-6" />}
              title="no PHI access yet"
              hint="once requests hit PHI routes they will appear here with actor, purpose, route and timestamp."
            />
          ) : (
            <div className="overflow-x-auto">
              <div className="mb-2 text-xs text-zinc-500">
                showing {phi.events.length} of {phi.total} events
              </div>
              <table className="w-full min-w-[720px] text-left text-xs">
                <thead className="text-zinc-500">
                  <tr className="border-b border-zinc-200 dark:border-zinc-800">
                    <th className="py-2 pr-3 font-medium">time</th>
                    <th className="py-2 pr-3 font-medium">purpose</th>
                    <th className="py-2 pr-3 font-medium">actor</th>
                    <th className="py-2 pr-3 font-medium">route</th>
                    <th className="py-2 pr-3 font-medium">patient</th>
                    <th className="py-2 pr-3 font-medium">ip</th>
                    <th className="py-2 pr-3 font-medium">status</th>
                  </tr>
                </thead>
                <tbody>
                  {phi.events.map((ev) => (
                    <tr
                      key={ev.id}
                      className="border-b border-zinc-100 align-top dark:border-zinc-900"
                    >
                      <td className="py-2 pr-3 font-mono text-zinc-600 dark:text-zinc-300">
                        {ev.created_at.replace("T", " ").slice(0, 19)}Z
                      </td>
                      <td className="py-2 pr-3">
                        <Badge tone={purposeTone(ev.purpose)}>
                          {ev.purpose}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3">
                        <div className="font-mono">{ev.actor}</div>
                        <div className="text-[10px] uppercase text-zinc-500">
                          {ev.actor_role}
                          {ev.key_name ? ` / ${ev.key_name}` : ""}
                        </div>
                      </td>
                      <td className="py-2 pr-3 font-mono text-zinc-700 dark:text-zinc-300">
                        <span className="text-zinc-500">{ev.method}</span>{" "}
                        {ev.route}
                      </td>
                      <td className="py-2 pr-3 font-mono">
                        {ev.user_id ?? "-"}
                      </td>
                      <td className="py-2 pr-3 font-mono text-zinc-500">
                        {ev.client_ip ?? "-"}
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={
                            ev.status_code >= 500
                              ? "text-rose-600"
                              : ev.status_code >= 400
                                ? "text-amber-600"
                                : "text-emerald-600"
                          }
                        >
                          {ev.status_code}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </main>
  );
}
