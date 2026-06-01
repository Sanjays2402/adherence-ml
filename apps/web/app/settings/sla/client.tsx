"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  Archive,
  DownloadSimple,
  Plus,
  ShieldCheck,
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorBox,
  Input,
  Skeleton,
} from "@/components/ui/primitives";

type Commitment = {
  id: number;
  tenant_id: string;
  contract_ref: string;
  plan: string;
  uptime_pct: number;
  sev1_response_hours: number;
  sev2_response_hours: number;
  sev3_response_hours: number;
  sev4_response_hours: number;
  rto_minutes: number;
  rpo_minutes: number;
  effective_from: string;
  effective_until: string | null;
  notes: string | null;
  version: number;
  status: string;
  created_by: string;
  created_at: string;
  archived_by: string | null;
  archived_at: string | null;
  archive_reason: string | null;
  superseded_by_id: number | null;
  active: boolean;
};

type ListResp = {
  tenant_id: string;
  active_count: number;
  archived_count: number;
  in_force_count: number;
  total: number;
  entries: Commitment[];
};

const fetcher = async <T,>(url: string): Promise<T> => {
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

function fmtTime(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z";
  } catch {
    return iso;
  }
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-xs">
      <span className="font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="text-[11px] text-[var(--color-muted)]">{hint}</span>
      ) : null}
    </label>
  );
}

function statusTone(
  c: Commitment,
): "success" | "warn" | "danger" | "neutral" {
  if (c.status === "active" && c.active) return "success";
  if (c.status === "archived") return "neutral";
  if (c.status === "expired") return "warn";
  return "neutral";
}

export default function SlaClient() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data, error, isLoading, mutate } = useSWR<ListResp>(
    `/api/sla?include_archived=${includeArchived}`,
    fetcher<ListResp>,
  );

  const [contractRef, setContractRef] = useState("");
  const [plan, setPlan] = useState("enterprise");
  const [uptime, setUptime] = useState("99.9");
  const [sev1, setSev1] = useState("1");
  const [sev2, setSev2] = useState("4");
  const [sev3, setSev3] = useState("8");
  const [sev4, setSev4] = useState("24");
  const [rto, setRto] = useState("240");
  const [rpo, setRpo] = useState("60");
  const [effFrom, setEffFrom] = useState("");
  const [effUntil, setEffUntil] = useState("");
  const [notes, setNotes] = useState("");
  const [supersede, setSupersede] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<number | null>(null);

  const inForce = useMemo(() => {
    if (!data) return null;
    return (
      data.entries.find((e) => e.active && e.status === "active") ?? null
    );
  }, [data]);

  const reset = () => {
    setContractRef("");
    setPlan("enterprise");
    setUptime("99.9");
    setSev1("1");
    setSev2("4");
    setSev3("8");
    setSev4("24");
    setRto("240");
    setRpo("60");
    setEffFrom("");
    setEffUntil("");
    setNotes("");
    setSupersede("");
  };

  const onCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      if (contractRef.trim().length < 2) {
        setFormError("contract_ref must be at least 2 characters");
        return;
      }
      const num = (s: string) => Number(s);
      const body = {
        contract_ref: contractRef.trim(),
        plan: plan.trim() || "enterprise",
        uptime_pct: num(uptime),
        sev1_response_hours: num(sev1),
        sev2_response_hours: num(sev2),
        sev3_response_hours: num(sev3),
        sev4_response_hours: num(sev4),
        rto_minutes: parseInt(rto, 10),
        rpo_minutes: parseInt(rpo, 10),
        effective_from: effFrom.trim(),
        effective_until: effUntil.trim() || null,
        notes: notes.trim() || null,
        supersede_reason: supersede.trim() || null,
      };
      for (const [k, v] of Object.entries({
        uptime_pct: body.uptime_pct,
        sev1_response_hours: body.sev1_response_hours,
        sev2_response_hours: body.sev2_response_hours,
        sev3_response_hours: body.sev3_response_hours,
        sev4_response_hours: body.sev4_response_hours,
        rto_minutes: body.rto_minutes,
        rpo_minutes: body.rpo_minutes,
      })) {
        if (!Number.isFinite(v as number)) {
          setFormError(`${k} must be a number`);
          return;
        }
      }
      if (!body.effective_from) {
        setFormError("effective_from is required (ISO 8601 datetime)");
        return;
      }
      setSubmitting(true);
      try {
        const r = await fetch("/api/sla", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const b = await r.json().catch(() => ({}));
          throw new Error(
            typeof b?.detail === "string"
              ? b.detail
              : `request failed (${r.status})`,
          );
        }
        reset();
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed to create");
      } finally {
        setSubmitting(false);
      }
    },
    [
      contractRef,
      plan,
      uptime,
      sev1,
      sev2,
      sev3,
      sev4,
      rto,
      rpo,
      effFrom,
      effUntil,
      notes,
      supersede,
      mutate,
    ],
  );

  const onArchive = useCallback(
    async (id: number) => {
      setArchivingId(id);
      try {
        const r = await fetch(`/api/sla/${id}/archive`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "archived from settings console" }),
        });
        if (!r.ok) {
          const b = await r.json().catch(() => ({}));
          throw new Error(
            typeof b?.detail === "string"
              ? b.detail
              : `request failed (${r.status})`,
          );
        }
        await mutate();
      } catch (err) {
        setFormError(
          err instanceof Error ? err.message : "failed to archive",
        );
      } finally {
        setArchivingId(null);
      }
    },
    [mutate],
  );

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1200px] flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/settings"
          className="inline-flex items-center gap-2 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          <ArrowLeft size={14} weight="duotone" />
          settings
        </Link>
        <a
          className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-fg)] hover:bg-[var(--color-surface-2)]"
          href="/api/sla?include_archived=true"
          onClick={(e) => {
            e.preventDefault();
            window.location.href = "/api/sla?include_archived=true";
          }}
        >
          <DownloadSimple size={14} weight="duotone" />
          export json
        </a>
      </div>

      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck size={20} weight="duotone" />
          <h1 className="text-xl font-semibold tracking-tight">
            SLA commitment register
          </h1>
        </div>
        <p className="max-w-3xl text-sm text-[var(--color-muted)]">
          Per-workspace record of contracted uptime, severity response
          targets, RTO, and RPO. The in-force commitment is what your
          customer sees and what procurement reviews. Creating a new
          commitment automatically supersedes the prior active one.
        </p>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <div className="flex flex-col gap-1 p-4">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
              in force
            </span>
            <span className="text-2xl font-semibold tabular-nums">
              {data ? data.in_force_count : "."}
            </span>
          </div>
        </Card>
        <Card>
          <div className="flex flex-col gap-1 p-4">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
              active rows
            </span>
            <span className="text-2xl font-semibold tabular-nums">
              {data ? data.active_count : "."}
            </span>
          </div>
        </Card>
        <Card>
          <div className="flex flex-col gap-1 p-4">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
              archived
            </span>
            <span className="text-2xl font-semibold tabular-nums">
              {data ? data.archived_count : "."}
            </span>
          </div>
        </Card>
        <Card>
          <div className="flex flex-col gap-1 p-4">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
              current uptime target
            </span>
            <span className="text-2xl font-semibold tabular-nums">
              {inForce ? `${inForce.uptime_pct.toFixed(2)}%` : "none"}
            </span>
          </div>
        </Card>
      </section>

      <Card>
        <CardHeader
          title="New commitment"
          hint="Recording a new commitment archives and supersedes the prior active row. Mutations require admin and an active MFA challenge."
        />
        <form
          onSubmit={onCreate}
          className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          <Field label="contract_ref">
            <Input
              value={contractRef}
              onChange={(e) => setContractRef(e.target.value)}
              placeholder="MSA-2026-0001"
              required
            />
          </Field>
          <Field label="plan">
            <Input
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
              placeholder="enterprise"
            />
          </Field>
          <Field label="uptime % (50.0 to 100.0)">
            <Input
              type="number"
              step="0.01"
              min="50"
              max="100"
              value={uptime}
              onChange={(e) => setUptime(e.target.value)}
              required
            />
          </Field>
          <Field label="sev1 response hrs">
            <Input
              type="number"
              step="0.25"
              value={sev1}
              onChange={(e) => setSev1(e.target.value)}
              required
            />
          </Field>
          <Field label="sev2 response hrs">
            <Input
              type="number"
              step="0.25"
              value={sev2}
              onChange={(e) => setSev2(e.target.value)}
              required
            />
          </Field>
          <Field label="sev3 response hrs">
            <Input
              type="number"
              step="0.25"
              value={sev3}
              onChange={(e) => setSev3(e.target.value)}
              required
            />
          </Field>
          <Field label="sev4 response hrs">
            <Input
              type="number"
              step="0.25"
              value={sev4}
              onChange={(e) => setSev4(e.target.value)}
              required
            />
          </Field>
          <Field label="rto minutes">
            <Input
              type="number"
              min="0"
              value={rto}
              onChange={(e) => setRto(e.target.value)}
              required
            />
          </Field>
          <Field label="rpo minutes">
            <Input
              type="number"
              min="0"
              value={rpo}
              onChange={(e) => setRpo(e.target.value)}
              required
            />
          </Field>
          <Field label="effective_from (ISO 8601)">
            <Input
              value={effFrom}
              onChange={(e) => setEffFrom(e.target.value)}
              placeholder="2026-01-01T00:00:00Z"
              required
            />
          </Field>
          <Field label="effective_until (optional)">
            <Input
              value={effUntil}
              onChange={(e) => setEffUntil(e.target.value)}
              placeholder="2027-01-01T00:00:00Z"
            />
          </Field>
          <Field label="supersede reason (optional)">
            <Input
              value={supersede}
              onChange={(e) => setSupersede(e.target.value)}
              placeholder="renewal, scope change, ..."
            />
          </Field>
          <div className="sm:col-span-2 lg:col-span-3">
            <Field label="notes">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono text-[var(--color-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              />
            </Field>
          </div>
          {formError ? (
            <div className="sm:col-span-2 lg:col-span-3">
              <ErrorBox message={formError} />
            </div>
          ) : null}
          <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-3">
            <Button type="submit" disabled={submitting}>
              <Plus size={14} weight="duotone" />
              {submitting ? "recording ..." : "record commitment"}
            </Button>
            <span className="text-[11px] text-[var(--color-muted)]">
              Writes an immutable admin audit row with actor, IP, and
              request id.
            </span>
          </div>
        </form>
      </Card>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-tight">
            Commitment history
          </h2>
          <label className="inline-flex items-center gap-2 text-xs text-[var(--color-muted)]">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              className="size-3.5 accent-[var(--color-accent)]"
            />
            include archived
          </label>
        </div>

        {error ? (
          <ErrorBox message={(error as Error).message} />
        ) : isLoading || !data ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : data.entries.length === 0 ? (
          <Empty
            title="No commitments recorded"
            hint="Record the first one above. It becomes the in-force commitment exposed at /v1/sla/current."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
            <table className="min-w-full divide-y divide-[var(--color-border)] text-xs">
              <thead className="bg-[var(--color-surface-2)] text-left font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                <tr>
                  <th className="px-3 py-2">contract</th>
                  <th className="px-3 py-2">plan</th>
                  <th className="px-3 py-2">uptime</th>
                  <th className="px-3 py-2">sev1/2/3/4 hrs</th>
                  <th className="px-3 py-2">rto / rpo (min)</th>
                  <th className="px-3 py-2">effective</th>
                  <th className="px-3 py-2">status</th>
                  <th className="px-3 py-2">v</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {data.entries.map((c) => (
                  <tr key={c.id} className="align-top">
                    <td className="px-3 py-2 font-mono">
                      <div className="font-semibold">{c.contract_ref}</div>
                      <div className="text-[10px] text-[var(--color-muted)]">
                        id {c.id} . by {c.created_by}
                      </div>
                    </td>
                    <td className="px-3 py-2">{c.plan}</td>
                    <td className="px-3 py-2 font-mono tabular-nums">
                      {c.uptime_pct.toFixed(2)}%
                    </td>
                    <td className="px-3 py-2 font-mono tabular-nums">
                      {c.sev1_response_hours}/{c.sev2_response_hours}/
                      {c.sev3_response_hours}/{c.sev4_response_hours}
                    </td>
                    <td className="px-3 py-2 font-mono tabular-nums">
                      {c.rto_minutes} / {c.rpo_minutes}
                    </td>
                    <td className="px-3 py-2 font-mono tabular-nums">
                      <div>{fmtTime(c.effective_from)}</div>
                      <div className="text-[10px] text-[var(--color-muted)]">
                        {c.effective_until
                          ? `until ${fmtTime(c.effective_until)}`
                          : "open ended"}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={statusTone(c)}>{c.status}</Badge>
                      {c.superseded_by_id ? (
                        <div className="mt-1 text-[10px] text-[var(--color-muted)]">
                          superseded by id {c.superseded_by_id}
                        </div>
                      ) : null}
                      {c.archive_reason ? (
                        <div className="mt-1 text-[10px] text-[var(--color-muted)]">
                          {c.archive_reason}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 font-mono tabular-nums">
                      {c.version}
                    </td>
                    <td className="px-3 py-2">
                      {c.active ? (
                        <button
                          type="button"
                          onClick={() => onArchive(c.id)}
                          disabled={archivingId === c.id}
                          className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
                          aria-label={`archive commitment ${c.id}`}
                        >
                          <Archive size={12} weight="duotone" />
                          {archivingId === c.id ? "archiving" : "archive"}
                        </button>
                      ) : (
                        <span className="text-[10px] text-[var(--color-muted)]">
                          {c.archived_at ? fmtTime(c.archived_at) : ""}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
