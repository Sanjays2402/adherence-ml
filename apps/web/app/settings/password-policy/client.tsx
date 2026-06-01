"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowClockwise,
  ShieldCheck,
  Key,
  FloppyDisk,
  Trash,
  Info,
  CheckCircle,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  Button,
  Card,
  CardHeader,
  ErrorBox,
  Skeleton,
  Badge,
  Input,
  SectionLabel,
} from "@/components/ui/primitives";

type Bounds = {
  min_length_floor: number;
  min_length_ceiling: number;
  max_age_days_ceiling: number;
  history_ceiling: number;
};

type Policy = {
  tenant_id: string | null;
  min_length: number;
  require_upper: boolean;
  require_lower: boolean;
  require_digit: boolean;
  require_symbol: boolean;
  max_age_days: number;
  history_size: number;
  updated_at: number | null;
  updated_by: string | null;
  using_default: boolean;
  bounds: Bounds;
};

type CheckResult = {
  ok: boolean;
  reasons: string[];
  policy_min_length: number;
};

const fetcher = (url: string) =>
  fetch(url).then(async (r) => {
    if (!r.ok) {
      const d = (await r.json().catch(() => ({}))) as { detail?: string };
      throw new Error(d.detail ?? `HTTP ${r.status}`);
    }
    return r.json();
  });

function fmtAbs(ts: number | null): string {
  if (!ts) return "never";
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

type Draft = {
  min_length: number;
  require_upper: boolean;
  require_lower: boolean;
  require_digit: boolean;
  require_symbol: boolean;
  max_age_days: number;
  history_size: number;
};

function policyToDraft(p: Policy): Draft {
  return {
    min_length: p.min_length,
    require_upper: p.require_upper,
    require_lower: p.require_lower,
    require_digit: p.require_digit,
    require_symbol: p.require_symbol,
    max_age_days: p.max_age_days,
    history_size: p.history_size,
  };
}

export default function PasswordPolicyClient() {
  const { data, error, isLoading, mutate } = useSWR<Policy>(
    "/api/workspace/password-policy",
    fetcher,
    { revalidateOnFocus: true },
  );

  const seed = useMemo<Draft | null>(
    () => (data ? policyToDraft(data) : null),
    [data],
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirtyKey, setDirtyKey] = useState<string>("");
  const current: Draft | null = draft ?? seed;

  // Re-seed once on first load.
  const seedKey = seed
    ? `${seed.min_length}|${seed.require_upper}|${seed.require_lower}|${seed.require_digit}|${seed.require_symbol}|${seed.max_age_days}|${seed.history_size}`
    : "";
  if (seed && draft === null && seedKey && dirtyKey !== seedKey) {
    // synchronous one-shot seed; avoids useEffect import noise.
    setDirtyKey(seedKey);
    setDraft(seed);
  }

  const [mfa, setMfa] = useState("");
  const [busy, setBusy] = useState<"save" | "clear" | "dry" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  const [preview, setPreview] = useState<unknown>(null);

  const [testPw, setTestPw] = useState("");
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);

  const bounds: Bounds = data?.bounds ?? {
    min_length_floor: 8,
    min_length_ceiling: 128,
    max_age_days_ceiling: 730,
    history_ceiling: 24,
  };

  const update = useCallback(<K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => {
      const base = d ?? seed;
      if (!base) return d;
      return { ...base, [k]: v };
    });
  }, [seed]);

  const headers = useCallback((): HeadersInit => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (mfa.trim()) h["x-mfa-code"] = mfa.trim();
    return h;
  }, [mfa]);

  const outOfRange = useMemo(() => {
    if (!current) return false;
    if (
      current.min_length < bounds.min_length_floor ||
      current.min_length > bounds.min_length_ceiling
    )
      return true;
    if (
      current.max_age_days < 0 ||
      current.max_age_days > bounds.max_age_days_ceiling
    )
      return true;
    if (
      current.history_size < 0 ||
      current.history_size > bounds.history_ceiling
    )
      return true;
    return false;
  }, [current, bounds]);

  const save = useCallback(
    async (mode: "save" | "dry") => {
      if (!current) return;
      setMsg(null);
      setPreview(null);
      if (outOfRange) {
        setMsg({ kind: "err", text: "One or more fields are out of range." });
        return;
      }
      setBusy(mode);
      try {
        const qs = mode === "dry" ? "?dry_run=true" : "";
        const r = await fetch(`/api/workspace/password-policy${qs}`, {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify(current),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          const detail =
            (body as { detail?: string }).detail ?? `HTTP ${r.status}`;
          if (r.status === 401) {
            setMsg({
              kind: "err",
              text: "Admin MFA required. Enter your authenticator code.",
            });
          } else {
            setMsg({ kind: "err", text: detail });
          }
          return;
        }
        if (mode === "dry") {
          setPreview(body);
          setMsg({ kind: "ok", text: "Dry run only. Nothing was saved." });
        } else {
          setMsg({ kind: "ok", text: "Password policy updated." });
          await mutate();
        }
      } catch {
        setMsg({ kind: "err", text: "Network error." });
      } finally {
        setBusy(null);
      }
    },
    [current, headers, mutate, outOfRange],
  );

  const clearPolicy = useCallback(async () => {
    if (
      !confirm(
        "Clear the workspace password policy and fall back to the default?",
      )
    )
      return;
    setMsg(null);
    setPreview(null);
    setBusy("clear");
    try {
      const r = await fetch("/api/workspace/password-policy", {
        method: "DELETE",
        headers: headers(),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail =
          (body as { detail?: string }).detail ?? `HTTP ${r.status}`;
        if (r.status === 401) {
          setMsg({
            kind: "err",
            text: "Admin MFA required. Enter your authenticator code.",
          });
        } else {
          setMsg({ kind: "err", text: detail });
        }
        return;
      }
      setMsg({ kind: "ok", text: "Cleared. Using the default policy." });
      setDraft(null);
      setDirtyKey("");
      await mutate();
    } catch {
      setMsg({ kind: "err", text: "Network error." });
    } finally {
      setBusy(null);
    }
  }, [headers, mutate]);

  const runCheck = useCallback(async () => {
    if (!testPw) {
      setCheck(null);
      return;
    }
    setChecking(true);
    try {
      const r = await fetch("/api/workspace/password-policy/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: testPw }),
      });
      const body = (await r.json().catch(() => ({}))) as CheckResult;
      if (!r.ok) {
        setCheck({ ok: false, reasons: ["check failed"], policy_min_length: 0 });
      } else {
        setCheck(body);
      }
    } catch {
      setCheck({ ok: false, reasons: ["network error"], policy_min_length: 0 });
    } finally {
      setChecking(false);
    }
  }, [testPw]);

  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <Link
            href="/settings"
            className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            <ArrowLeft size={14} weight="duotone" />
            back to settings
          </Link>
          <button
            type="button"
            onClick={() => mutate()}
            className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
            aria-label="refresh"
          >
            <ArrowClockwise size={14} weight="duotone" />
            refresh
          </button>
        </div>

        <header className="mb-6">
          <h1 className="text-[22px] font-semibold tracking-tight flex items-center gap-2">
            <Key size={20} weight="duotone" className="text-[var(--color-accent)]" />
            Password policy
          </h1>
          <p className="mt-1.5 text-[13px] text-[var(--color-muted)] leading-relaxed">
            Configure the rules enforced on local credentials, SCIM service
            accounts, and break-glass logins inside this workspace. Even when
            users sign in through SSO, procurement reviewers ask for a
            documented and enforceable fallback policy. Changes require admin
            MFA and are written to the audit log.
          </p>
        </header>

        {error && (
          <div className="mb-4">
            <ErrorBox message={`Failed to load policy: ${(error as Error).message}`} />
          </div>
        )}

        {isLoading || !current ? (
          <div className="space-y-3">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : (
          <>
            <Card>
              <CardHeader
                title="Current policy"
                right={
                  data?.using_default ? (
                    <Badge tone="neutral">default</Badge>
                  ) : (
                    <Badge tone="success">custom</Badge>
                  )
                }
              />
              <div className="px-4 py-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-[12px]">
                <div>
                  <div className="text-[var(--color-muted)]">Min length</div>
                  <div className="font-mono text-[13px] mt-0.5">{data?.min_length}</div>
                </div>
                <div>
                  <div className="text-[var(--color-muted)]">Rotation</div>
                  <div className="font-mono text-[13px] mt-0.5">
                    {data?.max_age_days ? `${data.max_age_days}d` : "off"}
                  </div>
                </div>
                <div>
                  <div className="text-[var(--color-muted)]">History</div>
                  <div className="font-mono text-[13px] mt-0.5">{data?.history_size}</div>
                </div>
                <div>
                  <div className="text-[var(--color-muted)]">Updated</div>
                  <div className="font-mono text-[11px] mt-0.5">
                    {fmtAbs(data?.updated_at ?? null)}
                  </div>
                </div>
              </div>
            </Card>

            <div className="h-4" />

            <Card>
              <CardHeader title="Edit policy" />
              <div className="px-4 py-4 space-y-5">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <SectionLabel>Min length</SectionLabel>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={bounds.min_length_floor}
                      max={bounds.min_length_ceiling}
                      value={current.min_length}
                      onChange={(e) =>
                        update("min_length", Number(e.target.value) || 0)
                      }
                      aria-label="minimum length"
                    />
                    <div className="text-[11px] text-[var(--color-muted)] mt-1">
                      {bounds.min_length_floor} to {bounds.min_length_ceiling}
                    </div>
                  </div>
                  <div>
                    <SectionLabel>Rotation (days)</SectionLabel>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={bounds.max_age_days_ceiling}
                      value={current.max_age_days}
                      onChange={(e) =>
                        update("max_age_days", Number(e.target.value) || 0)
                      }
                      aria-label="rotation days"
                    />
                    <div className="text-[11px] text-[var(--color-muted)] mt-1">
                      0 disables rotation
                    </div>
                  </div>
                  <div>
                    <SectionLabel>History size</SectionLabel>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={bounds.history_ceiling}
                      value={current.history_size}
                      onChange={(e) =>
                        update("history_size", Number(e.target.value) || 0)
                      }
                      aria-label="history size"
                    />
                    <div className="text-[11px] text-[var(--color-muted)] mt-1">
                      0 to {bounds.history_ceiling} previous hashes
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {(
                    [
                      ["require_upper", "Uppercase"],
                      ["require_lower", "Lowercase"],
                      ["require_digit", "Digit"],
                      ["require_symbol", "Symbol"],
                    ] as const
                  ).map(([k, label]) => (
                    <label
                      key={k}
                      className="flex items-center gap-2 text-[13px] border border-[var(--color-border)] rounded-md px-3 py-2 cursor-pointer hover:bg-[var(--color-border)]/30"
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(current[k])}
                        onChange={(e) => update(k, e.target.checked)}
                        className="h-4 w-4 accent-[var(--color-accent)]"
                      />
                      {label}
                    </label>
                  ))}
                </div>

                <div>
                  <SectionLabel>Admin MFA code</SectionLabel>
                  <Input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="6-digit code"
                    value={mfa}
                    onChange={(e) => setMfa(e.target.value)}
                    aria-label="admin mfa code"
                  />
                  <div className="text-[11px] text-[var(--color-muted)] mt-1 flex items-center gap-1.5">
                    <ShieldCheck size={12} weight="duotone" />
                    Required to save or clear. Not needed for dry run preview.
                  </div>
                </div>

                {outOfRange && (
                  <div className="text-[12px] text-[var(--color-warn,#b45309)] flex items-center gap-1.5">
                    <WarningCircle size={14} weight="duotone" />
                    One or more values are out of range.
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => save("save")}
                    disabled={busy !== null || outOfRange}
                    aria-label="save policy"
                  >
                    <FloppyDisk size={14} weight="duotone" />
                    {busy === "save" ? "Saving..." : "Save"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => save("dry")}
                    disabled={busy !== null || outOfRange}
                    aria-label="dry run"
                  >
                    <Info size={14} weight="duotone" />
                    {busy === "dry" ? "Checking..." : "Dry run"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={clearPolicy}
                    disabled={busy !== null || data?.using_default}
                    aria-label="clear policy"
                  >
                    <Trash size={14} weight="duotone" />
                    {busy === "clear" ? "Clearing..." : "Clear"}
                  </Button>
                </div>

                {msg && (
                  <div
                    className={
                      "text-[12px] " +
                      (msg.kind === "ok"
                        ? "text-[var(--color-success,#15803d)]"
                        : "text-[var(--color-danger,#b91c1c)]")
                    }
                  >
                    {msg.text}
                  </div>
                )}

                {preview != null && (
                  <pre className="text-[11px] font-mono whitespace-pre-wrap bg-[var(--color-border)]/20 border border-[var(--color-border)] rounded-md p-3 overflow-x-auto">
                    {JSON.stringify(preview, null, 2)}
                  </pre>
                )}
              </div>
            </Card>

            <div className="h-4" />

            <Card>
              <CardHeader title="Test a candidate" />
              <div className="px-4 py-4 space-y-3">
                <p className="text-[12px] text-[var(--color-muted)]">
                  Runs the validator without storing the value. Use this to
                  spot-check a candidate before rolling it out through SCIM or
                  break-glass mint.
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    placeholder="candidate password"
                    value={testPw}
                    onChange={(e) => setTestPw(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") runCheck();
                    }}
                    aria-label="candidate password"
                    className="flex-1"
                  />
                  <Button
                    onClick={runCheck}
                    disabled={checking || !testPw}
                    aria-label="check"
                  >
                    {checking ? "Checking..." : "Check"}
                  </Button>
                </div>
                {check && (
                  <div className="text-[12px]">
                    {check.ok ? (
                      <div className="flex items-center gap-1.5 text-[var(--color-success,#15803d)]">
                        <CheckCircle size={14} weight="duotone" />
                        Passes the current workspace policy.
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5 text-[var(--color-danger,#b91c1c)]">
                          <WarningCircle size={14} weight="duotone" />
                          Rejected by the current policy.
                        </div>
                        <ul className="list-disc pl-5 text-[var(--color-muted)]">
                          {check.reasons.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
                {!check && !testPw && (
                  <div className="text-[11px] text-[var(--color-muted)]">
                    Empty input. Type a candidate and press Check.
                  </div>
                )}
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
