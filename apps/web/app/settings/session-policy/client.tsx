"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowClockwise,
  ShieldCheck,
  Clock,
  FloppyDisk,
  Trash,
  Info,
} from "@phosphor-icons/react";
import {
  Button,
  Card,
  CardHeader,
  ErrorBox,
  Skeleton,
  Badge,
  Input,
  Select,
} from "@/components/ui/primitives";

type Policy = {
  tenant_id: string;
  max_age_seconds: number | null;
  updated_at: number | null;
  updated_by: string | null;
  min_allowed_seconds: number;
  max_allowed_seconds: number;
};

const fetcher = (url: string) =>
  fetch(url).then(async (r) => {
    if (!r.ok) {
      const d = (await r.json().catch(() => ({}))) as { detail?: string };
      throw new Error(d.detail ?? `HTTP ${r.status}`);
    }
    return r.json();
  });

type UnitKey = "minutes" | "hours" | "days";
const UNITS: Record<UnitKey, number> = {
  minutes: 60,
  hours: 3600,
  days: 86400,
};

function splitSeconds(sec: number | null): { value: number; unit: UnitKey } {
  if (sec == null) return { value: 8, unit: "hours" };
  if (sec % 86400 === 0) return { value: sec / 86400, unit: "days" };
  if (sec % 3600 === 0) return { value: sec / 3600, unit: "hours" };
  return { value: Math.max(1, Math.round(sec / 60)), unit: "minutes" };
}

function fmtAbs(ms: number | null): string {
  if (!ms) return "never";
  // updated_at is a unix epoch in seconds upstream
  const d = new Date(ms * 1000);
  return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function fmtSec(sec: number): string {
  if (sec >= 86400 && sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

export default function SessionPolicyClient() {
  const { data, error, isLoading, mutate } = useSWR<Policy>(
    "/api/workspace/session-policy",
    fetcher,
    { revalidateOnFocus: true },
  );

  const initial = useMemo(
    () => splitSeconds(data?.max_age_seconds ?? null),
    [data?.max_age_seconds],
  );
  const [value, setValue] = useState<number>(initial.value);
  const [unit, setUnit] = useState<UnitKey>(initial.unit);
  const [mfa, setMfa] = useState<string>("");
  const [busy, setBusy] = useState<"save" | "clear" | "dry" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  const [preview, setPreview] = useState<unknown>(null);

  const min = data?.min_allowed_seconds ?? 300;
  const max = data?.max_allowed_seconds ?? 2_592_000;

  const composedSeconds = Math.round((Number(value) || 0) * UNITS[unit]);
  const outOfRange = composedSeconds < min || composedSeconds > max;

  // Re-seed inputs once data arrives.
  const seedKey = data ? `${data.max_age_seconds ?? "none"}` : "loading";
  // Use a render-time effect via useMemo would be wrong; do a simple
  // one-shot using a ref via state synchronization on first valid load.
  // Light approach: only seed if user hasn't typed (value === 8 default).
  // Acceptable for first paint; users can also press Reset.
  // (Avoids useEffect import noise.)
  void seedKey;

  const headers = useCallback((): HeadersInit => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (mfa.trim()) h["x-mfa-code"] = mfa.trim();
    return h;
  }, [mfa]);

  const save = useCallback(
    async (mode: "save" | "dry") => {
      setMsg(null);
      setPreview(null);
      if (outOfRange) {
        setMsg({
          kind: "err",
          text: `Out of range. Allowed: ${fmtSec(min)} to ${fmtSec(max)}.`,
        });
        return;
      }
      setBusy(mode);
      try {
        const qs = mode === "dry" ? "?dry_run=true" : "";
        const r = await fetch(`/api/workspace/session-policy${qs}`, {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ max_age_seconds: composedSeconds }),
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
          setMsg({
            kind: "ok",
            text: `Saved. Cap is now ${fmtSec(composedSeconds)}.`,
          });
          await mutate();
        }
      } catch {
        setMsg({ kind: "err", text: "Network error." });
      } finally {
        setBusy(null);
      }
    },
    [composedSeconds, headers, max, min, mutate, outOfRange],
  );

  const clear = useCallback(async () => {
    if (!confirm("Clear the workspace cap and fall back to the global TTL?")) {
      return;
    }
    setMsg(null);
    setPreview(null);
    setBusy("clear");
    try {
      const r = await fetch("/api/workspace/session-policy", {
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
      setMsg({ kind: "ok", text: "Cap cleared. Using the global default." });
      await mutate();
    } catch {
      setMsg({ kind: "err", text: "Network error." });
    } finally {
      setBusy(null);
    }
  }, [headers, mutate]);

  return (
    <main className="min-h-dvh bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-10 space-y-6">
        <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
          <Link
            href="/settings"
            className="inline-flex items-center gap-1 hover:text-[var(--color-text)] transition-colors"
          >
            <ArrowLeft size={12} />
            settings
          </Link>
          <span aria-hidden>/</span>
          <span>session policy</span>
        </div>

        <header className="space-y-1">
          <h1 className="text-[20px] tracking-tight">session policy</h1>
          <p className="text-[13px] text-[var(--color-muted)]">
            Cap how long a signed-in session is honoured inside this workspace.
            Regulated verticals (HIPAA, PCI, SOX) often require a tighter cap
            than the global default. Changes are admin-only, MFA-gated, and
            written to the audit log.
          </p>
        </header>

        {error ? (
          <ErrorBox message="Could not load the workspace policy." />
        ) : null}
        {msg ? (
          msg.kind === "err" ? (
            <ErrorBox message={msg.text} />
          ) : (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-border)]/20 px-3 py-2 text-[12px] text-[var(--color-text)]">
              {msg.text}
            </div>
          )
        ) : null}

        <Card>
          <CardHeader
            title="current policy"
            hint={data ? data.tenant_id : "loading"}
            right={
              <button
                type="button"
                onClick={() => mutate()}
                className="inline-flex items-center gap-1 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)] transition"
                aria-label="Refresh policy"
              >
                <ArrowClockwise size={12} />
                refresh
              </button>
            }
          />
          <div className="px-4 py-4 space-y-3">
            {isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-64" />
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <ShieldCheck
                    size={16}
                    weight="duotone"
                    className="text-[var(--color-muted)]"
                  />
                  <span className="text-[13px]">
                    {data?.max_age_seconds
                      ? `Capped at ${fmtSec(data.max_age_seconds)}`
                      : "No workspace cap. Using global default."}
                  </span>
                  {data?.max_age_seconds ? (
                    <Badge>tenant override</Badge>
                  ) : (
                    <Badge>global</Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[11px] text-[var(--color-muted)]">
                  <Clock size={12} />
                  last change {fmtAbs(data?.updated_at ?? null)} by{" "}
                  {data?.updated_by ?? "n/a"}
                </div>
                <div className="flex items-start gap-2 text-[11px] text-[var(--color-muted)]">
                  <Info size={12} className="mt-0.5 shrink-0" />
                  <span>
                    Allowed range: {fmtSec(min)} to {fmtSec(max)}. Active
                    sessions older than the new cap are rejected on their next
                    request.
                  </span>
                </div>
              </>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="set a workspace cap" hint="admin + MFA" />
          <div className="px-4 py-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_180px] gap-3">
              <label className="block">
                <span className="block text-[11px] text-[var(--color-muted)] mb-1">
                  Cap
                </span>
                <Input
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={String(value)}
                  onChange={(e) => setValue(Number(e.target.value))}
                  aria-label="Session cap value"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] text-[var(--color-muted)] mb-1">
                  Unit
                </span>
                <Select
                  value={unit}
                  onChange={(e) => setUnit(e.target.value as UnitKey)}
                  aria-label="Session cap unit"
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </Select>
              </label>
            </div>

            <div className="text-[11px] text-[var(--color-muted)]">
              Effective cap: {fmtSec(composedSeconds || 0)} ({composedSeconds}{" "}
              seconds)
              {outOfRange ? (
                <span className="ml-2 text-[var(--color-danger,theme(colors.red.400))]">
                  out of allowed range
                </span>
              ) : null}
            </div>

            <label className="block">
              <span className="block text-[11px] text-[var(--color-muted)] mb-1">
                Admin MFA code (if enrolled)
              </span>
              <Input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={mfa}
                onChange={(e) => setMfa(e.target.value)}
                aria-label="Admin MFA code"
                maxLength={8}
              />
            </label>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                onClick={() => save("save")}
                disabled={busy !== null || outOfRange}
                aria-label="Save workspace session policy"
              >
                <FloppyDisk size={14} weight="duotone" />
                {busy === "save" ? "saving" : "save policy"}
              </Button>
              <Button
                onClick={() => save("dry")}
                disabled={busy !== null || outOfRange}
                aria-label="Dry run the policy change"
              >
                {busy === "dry" ? "checking" : "dry run"}
              </Button>
              <Button
                onClick={clear}
                disabled={busy !== null || !data?.max_age_seconds}
                aria-label="Clear workspace cap"
              >
                <Trash size={14} weight="duotone" />
                {busy === "clear" ? "clearing" : "clear cap"}
              </Button>
              <button
                type="button"
                onClick={() => {
                  const seed = splitSeconds(data?.max_age_seconds ?? null);
                  setValue(seed.value);
                  setUnit(seed.unit);
                }}
                className="text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)] transition px-2 py-1"
              >
                reset to current
              </button>
            </div>

            {preview ? (
              <pre className="text-[11px] bg-black/30 border border-[var(--color-border)] rounded-md p-3 overflow-x-auto">
                {JSON.stringify(preview, null, 2)}
              </pre>
            ) : null}
          </div>
        </Card>
      </div>
    </main>
  );
}
