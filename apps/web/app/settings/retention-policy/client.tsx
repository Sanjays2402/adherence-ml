"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  Broom,
  CheckCircle,
  ClockCounterClockwise,
  Eraser,
  FloppyDisk,
  Info,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorBox,
  Skeleton,
} from "@/components/ui/primitives";

type PolicyOut = {
  tenant_id: string;
  ttls_days: Record<string, number>;
  updated_at: number | null;
  updated_by: string | null;
  allowed_tables: string[];
  min_ttl_days: number;
  max_ttl_days: number;
};

type SweepRow = {
  table: string;
  cutoff: string;
  candidates: number;
  deleted: number;
};

type SweepOut = {
  tenant_id: string;
  dry_run: boolean;
  results: SweepRow[];
};

const fetcher = async (url: string): Promise<PolicyOut> => {
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(
      typeof body?.detail === "string"
        ? body.detail
        : `request failed (${r.status})`,
    );
  }
  return r.json();
};

function fmtEpoch(secs: number | null): string {
  if (!secs) return "";
  try {
    return new Date(secs * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";
  } catch {
    return String(secs);
  }
}

function describeTable(t: string): string {
  switch (t) {
    case "predictions":
      return "Per-call prediction rows (model output, risk tier).";
    case "prediction_audit":
      return "Detailed prediction audit (latency, request id, caller).";
    case "admin_audit_log":
      return "Admin and security actions (policy changes, sweeps).";
    default:
      return "Tenant-scoped retention target.";
  }
}

export default function RetentionPolicyClient() {
  const { data, error, isLoading, mutate } = useSWR<PolicyOut>(
    "/api/retention-policy",
    fetcher,
  );

  // Local editable map of table -> ttl days (string for input control).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [sweeping, setSweeping] = useState<"dry" | "real" | null>(null);
  const [sweepResult, setSweepResult] = useState<SweepOut | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const allowed = data?.allowed_tables ?? [];
  const minDays = data?.min_ttl_days ?? 1;
  const maxDays = data?.max_ttl_days ?? 3650;

  const effective = useMemo<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const t of allowed) {
      const draft = drafts[t];
      if (draft !== undefined) {
        m[t] = draft;
      } else if (data?.ttls_days[t] != null) {
        m[t] = String(data.ttls_days[t]);
      } else {
        m[t] = "";
      }
    }
    return m;
  }, [allowed, drafts, data]);

  const buildPayload = useCallback((): {
    ok: boolean;
    ttls_days?: Record<string, number>;
    error?: string;
  } => {
    const out: Record<string, number> = {};
    for (const [t, v] of Object.entries(effective)) {
      const s = v.trim();
      if (s === "") continue;
      const n = Number(s);
      if (!Number.isInteger(n) || n < minDays || n > maxDays) {
        return {
          ok: false,
          error: `${t}: ttl must be an integer between ${minDays} and ${maxDays}`,
        };
      }
      out[t] = n;
    }
    if (Object.keys(out).length === 0) {
      return {
        ok: false,
        error:
          "set at least one table TTL, or use Clear overrides to fall back to the deployment default",
      };
    }
    return { ok: true, ttls_days: out };
  }, [effective, minDays, maxDays]);

  const onSave = useCallback(
    async (dryRun: boolean) => {
      setFormError(null);
      setSweepResult(null);
      const built = buildPayload();
      if (!built.ok) {
        setFormError(built.error ?? "invalid input");
        return;
      }
      setSaving(true);
      try {
        const r = await fetch(
          `/api/retention-policy${dryRun ? "?dry_run=true" : ""}`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ttls_days: built.ttls_days }),
          },
        );
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            typeof body?.detail === "string"
              ? body.detail
              : `request failed (${r.status})`,
          );
        }
        if (!dryRun) {
          setDrafts({});
          setSavedAt(Date.now());
        }
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed to save");
      } finally {
        setSaving(false);
      }
    },
    [buildPayload, mutate],
  );

  const onClear = useCallback(async () => {
    if (
      !confirm(
        "Clear all per-workspace retention overrides? Tables will fall back to the deployment default TTL.",
      )
    ) {
      return;
    }
    setFormError(null);
    setSweepResult(null);
    setClearing(true);
    try {
      const r = await fetch("/api/retention-policy", { method: "DELETE" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(
          typeof body?.detail === "string"
            ? body.detail
            : `request failed (${r.status})`,
        );
      }
      setDrafts({});
      await mutate();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "failed to clear");
    } finally {
      setClearing(false);
    }
  }, [mutate]);

  const onSweep = useCallback(
    async (dryRun: boolean) => {
      setFormError(null);
      setSweepResult(null);
      if (!dryRun) {
        if (
          !confirm(
            "Run a real retention sweep now? This permanently deletes rows older than the configured TTL for this workspace only.",
          )
        ) {
          return;
        }
      }
      setSweeping(dryRun ? "dry" : "real");
      try {
        const r = await fetch("/api/retention-policy/sweep", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dry_run: dryRun }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            typeof body?.detail === "string"
              ? body.detail
              : typeof body?.detail === "object" && body?.detail?.message
                ? String(body.detail.message)
                : `request failed (${r.status})`,
          );
        }
        const out: SweepOut = await r.json();
        setSweepResult(out);
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed to sweep");
      } finally {
        setSweeping(null);
      }
    },
    [],
  );

  const tenant = data?.tenant_id ?? "default";
  const hasOverrides = data ? Object.keys(data.ttls_days).length > 0 : false;
  const dirty = Object.keys(drafts).length > 0;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="mb-6">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          <ArrowLeft size={14} weight="duotone" aria-hidden />
          back to settings
        </Link>
      </div>

      <header className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
            Retention policy
          </h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Per-workspace TTL for tenant-scoped tables on workspace{" "}
            <span className="font-mono">{tenant}</span>. Sweeps only touch
            rows belonging to this workspace; cross-tenant deletion is
            impossible at the query layer.
          </p>
        </div>
        <div className="shrink-0">
          {isLoading ? (
            <Skeleton className="h-6 w-32" />
          ) : hasOverrides ? (
            <Badge tone="success">
              <CheckCircle size={12} weight="duotone" aria-hidden />
              overrides active
            </Badge>
          ) : (
            <Badge tone="neutral">
              <Info size={12} weight="duotone" aria-hidden />
              default policy
            </Badge>
          )}
        </div>
      </header>

      {error ? (
        <div className="mb-6">
          <ErrorBox
            message={error instanceof Error ? error.message : "failed to load"}
          />
        </div>
      ) : null}

      <Card className="mb-6">
        <CardHeader
          title="Per table TTL"
          hint={`Each value is the number of days rows are kept before they become eligible for the sweeper. Range: ${minDays} to ${maxDays} days. Leave a field blank to inherit the deployment default for that table.`}
          right={<ClockCounterClockwise size={16} weight="duotone" aria-hidden />}
        />
        <div className="border-t border-neutral-200 dark:border-neutral-800">
          {isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : allowed.length === 0 ? (
            <div className="p-4">
              <Empty
                title="No tables eligible"
                hint="The deployment does not expose any tenant scoped retention targets."
              />
            </div>
          ) : (
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {allowed.map((t) => {
                const current = data?.ttls_days[t];
                const value = effective[t] ?? "";
                const isDraft = drafts[t] !== undefined;
                return (
                  <li
                    key={t}
                    className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm text-neutral-900 dark:text-neutral-50">
                          {t}
                        </span>
                        {current != null ? (
                          <Badge tone="accent">override: {current}d</Badge>
                        ) : (
                          <Badge tone="neutral">default</Badge>
                        )}
                        {isDraft ? <Badge tone="warn">unsaved</Badge> : null}
                      </div>
                      <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                        {describeTable(t)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <label
                        className="sr-only"
                        htmlFor={`ttl-${t}`}
                      >{`TTL days for ${t}`}</label>
                      <input
                        id={`ttl-${t}`}
                        inputMode="numeric"
                        type="number"
                        min={minDays}
                        max={maxDays}
                        step={1}
                        value={value}
                        placeholder="inherit"
                        onChange={(e) =>
                          setDrafts((m) => ({ ...m, [t]: e.target.value }))
                        }
                        className="w-28 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] font-mono outline-none placeholder:text-[var(--color-subtle)] focus:border-[var(--color-accent)]/70 focus:shadow-[0_0_0_3px_var(--color-accent-soft)] transition-shadow"
                      />
                      <span className="text-xs text-neutral-500 dark:text-neutral-400">
                        days
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-2 border-t border-neutral-200 p-4 dark:border-neutral-800 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-neutral-500 dark:text-neutral-400">
            {data?.updated_at ? (
              <>
                last updated {fmtEpoch(data.updated_at)} by{" "}
                <span className="font-mono">
                  {data.updated_by ?? "unknown"}
                </span>
              </>
            ) : (
              "no per workspace policy saved yet"
            )}
            {savedAt ? (
              <span className="ml-2 text-emerald-600 dark:text-emerald-400">
                saved
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => onSave(true)}
              disabled={saving || isLoading}
              aria-label="Preview save without persisting"
            >
              <Info size={14} weight="duotone" aria-hidden />
              dry run save
            </Button>
            <Button
              onClick={() => onSave(false)}
              disabled={saving || isLoading || !dirty}
              aria-label="Save retention policy"
            >
              <FloppyDisk size={14} weight="duotone" aria-hidden />
              {saving ? "saving" : "save policy"}
            </Button>
            <Button
              variant="ghost"
              onClick={onClear}
              disabled={clearing || isLoading || !hasOverrides}
              aria-label="Clear all overrides"
            >
              <Eraser size={14} weight="duotone" aria-hidden />
              {clearing ? "clearing" : "clear overrides"}
            </Button>
          </div>
        </div>
        {formError ? (
          <div className="px-4 pb-4">
            <ErrorBox message={formError} />
          </div>
        ) : null}
      </Card>

      <Card className="mb-6">
        <CardHeader
          title="Run sweep"
          hint="Apply the saved policy now. Dry run reports what would be deleted without touching rows. Both modes are admin only, MFA gated, and audit logged."
          right={<Broom size={16} weight="duotone" aria-hidden />}
        />
        <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Active legal holds return <span className="font-mono">423 Locked</span>{" "}
            and the sweep is skipped.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => onSweep(true)}
              disabled={sweeping !== null || isLoading}
              aria-label="Preview sweep without deleting"
            >
              <Info size={14} weight="duotone" aria-hidden />
              {sweeping === "dry" ? "previewing" : "dry run sweep"}
            </Button>
            <Button
              onClick={() => onSweep(false)}
              disabled={sweeping !== null || isLoading}
              aria-label="Run real sweep"
            >
              <Trash size={14} weight="duotone" aria-hidden />
              {sweeping === "real" ? "sweeping" : "run sweep"}
            </Button>
          </div>
        </div>
        {sweepResult ? (
          <div className="border-t border-neutral-200 dark:border-neutral-800">
            <div className="flex items-center gap-2 px-4 pt-4 text-xs text-neutral-500 dark:text-neutral-400">
              {sweepResult.dry_run ? (
                <Badge tone="accent">
                  <Info size={12} weight="duotone" aria-hidden />
                  dry run
                </Badge>
              ) : (
                <Badge tone="success">
                  <CheckCircle size={12} weight="duotone" aria-hidden />
                  applied
                </Badge>
              )}
              <span>
                tenant <span className="font-mono">{sweepResult.tenant_id}</span>
              </span>
            </div>
            {sweepResult.results.length === 0 ? (
              <div className="p-4">
                <Empty
                  title="No tables matched"
                  hint="Set at least one table TTL above before sweeping."
                />
              </div>
            ) : (
              <div className="overflow-x-auto p-4">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                      <th className="py-1 pr-4 font-medium">table</th>
                      <th className="py-1 pr-4 font-medium">cutoff</th>
                      <th className="py-1 pr-4 font-medium">candidates</th>
                      <th className="py-1 pr-4 font-medium">deleted</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {sweepResult.results.map((r) => (
                      <tr
                        key={r.table}
                        className="border-t border-neutral-200 dark:border-neutral-800"
                      >
                        <td className="py-1.5 pr-4">{r.table}</td>
                        <td className="py-1.5 pr-4 text-neutral-500 dark:text-neutral-400">
                          {r.cutoff.replace("T", " ").slice(0, 16)}Z
                        </td>
                        <td className="py-1.5 pr-4">{r.candidates}</td>
                        <td className="py-1.5 pr-4">
                          {sweepResult.dry_run ? (
                            <span className="text-neutral-500 dark:text-neutral-400">
                              0 (dry run)
                            </span>
                          ) : (
                            <span className="text-emerald-700 dark:text-emerald-400">
                              {r.deleted}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </Card>

      <Card className="mb-6 border-amber-400/30 bg-amber-50/30 dark:border-amber-500/20 dark:bg-amber-950/10">
        <div className="flex items-start gap-3 p-4">
          <Warning
            size={18}
            weight="duotone"
            className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden
          />
          <div className="text-xs text-neutral-700 dark:text-neutral-300">
            Sweeps are irreversible. Cross-tenant isolation is verified in{" "}
            <span className="font-mono">
              tests/integration/test_retention_policy.py
            </span>{" "}
            and every change is recorded to the admin audit log with the
            actor, target tenant, before and after policy, and the request id.
          </div>
        </div>
      </Card>
    </div>
  );
}
