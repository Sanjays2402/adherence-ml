"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  DownloadSimple,
  Plus,
  ShieldCheck,
  ShieldWarning,
  Warning,
  XCircle,
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorBox,
  Input,
  Select,
  Skeleton,
} from "@/components/ui/primitives";

type Entry = {
  id: number;
  tenant_id: string;
  counterparty: string;
  document_version: string;
  status: "draft" | "active" | "expired" | "terminated";
  effective_status: "draft" | "active" | "expired" | "terminated";
  effective_on: string | null;
  expires_on: string | null;
  breach_notify_hours: number;
  covered_entity_signatory: string | null;
  business_associate_signatory: string | null;
  evidence_url: string | null;
  notes: string | null;
  version: number;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
};

type ListResp = {
  tenant_id: string;
  active_count: number;
  expiring_30d: number;
  total: number;
  has_active_baa: boolean;
  entries: Entry[];
};

type Policy = {
  tenant_id: string;
  require_baa_for_phi: boolean;
  grace_until: string | null;
  updated_by: string | null;
  updated_at: string;
};

const STATUSES = ["draft", "active", "expired", "terminated"] as const;

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
  s: Entry["effective_status"],
): "success" | "warn" | "danger" | "neutral" {
  if (s === "active") return "success";
  if (s === "draft") return "neutral";
  if (s === "expired") return "warn";
  return "danger";
}

export default function BaaClient() {
  const [includeTerminated, setIncludeTerminated] = useState(false);
  const {
    data,
    error,
    isLoading,
    mutate,
  } = useSWR<ListResp>(
    `/api/baa?include_terminated=${includeTerminated}`,
    fetcher<ListResp>,
  );
  const {
    data: policy,
    error: polError,
    isLoading: polLoading,
    mutate: mutatePolicy,
  } = useSWR<Policy>("/api/baa/policy", fetcher<Policy>);

  // Create form
  const [counterparty, setCounterparty] = useState("");
  const [docVersion, setDocVersion] = useState("");
  const [statusVal, setStatusVal] = useState<(typeof STATUSES)[number]>("draft");
  const [effectiveOn, setEffectiveOn] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [breachHours, setBreachHours] = useState("72");
  const [ceSig, setCeSig] = useState("");
  const [baSig, setBaSig] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [terminatingId, setTerminatingId] = useState<number | null>(null);

  // Policy form
  const [requireOn, setRequireOn] = useState<boolean | null>(null);
  const [graceUntil, setGraceUntil] = useState("");
  const [policySaving, setPolicySaving] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const effectiveRequire =
    requireOn ?? policy?.require_baa_for_phi ?? false;
  const effectiveGrace = graceUntil || policy?.grace_until || "";

  const reset = () => {
    setCounterparty("");
    setDocVersion("");
    setStatusVal("draft");
    setEffectiveOn("");
    setExpiresOn("");
    setBreachHours("72");
    setCeSig("");
    setBaSig("");
    setEvidenceUrl("");
    setNotes("");
  };

  const onCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      if (counterparty.trim().length < 2) {
        setFormError("counterparty must be at least 2 characters");
        return;
      }
      if (docVersion.trim().length < 1) {
        setFormError("document version is required");
        return;
      }
      const hrs = Number(breachHours);
      if (!Number.isInteger(hrs) || hrs < 1 || hrs > 60 * 24) {
        setFormError("breach window must be between 1 and 1440 hours");
        return;
      }
      if (effectiveOn && expiresOn && expiresOn < effectiveOn) {
        setFormError("expires_on must not be before effective_on");
        return;
      }
      setSubmitting(true);
      try {
        const r = await fetch("/api/baa", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            counterparty: counterparty.trim(),
            document_version: docVersion.trim(),
            status: statusVal,
            effective_on: effectiveOn || null,
            expires_on: expiresOn || null,
            breach_notify_hours: hrs,
            covered_entity_signatory: ceSig.trim() || null,
            business_associate_signatory: baSig.trim() || null,
            evidence_url: evidenceUrl.trim() || null,
            notes: notes.trim() || null,
          }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            typeof body?.detail === "string"
              ? body.detail
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
      counterparty,
      docVersion,
      statusVal,
      effectiveOn,
      expiresOn,
      breachHours,
      ceSig,
      baSig,
      evidenceUrl,
      notes,
      mutate,
    ],
  );

  const onTerminate = useCallback(
    async (id: number) => {
      setTerminatingId(id);
      try {
        const r = await fetch(`/api/baa/${id}/terminate`, { method: "POST" });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            typeof body?.detail === "string"
              ? body.detail
              : `request failed (${r.status})`,
          );
        }
        await mutate();
      } catch (err) {
        setFormError(
          err instanceof Error ? err.message : "failed to terminate",
        );
      } finally {
        setTerminatingId(null);
      }
    },
    [mutate],
  );

  const onSavePolicy = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setPolicyError(null);
      if (effectiveGrace && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveGrace)) {
        setPolicyError("grace_until must be ISO date YYYY-MM-DD");
        return;
      }
      setPolicySaving(true);
      try {
        const r = await fetch("/api/baa/policy", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            require_baa_for_phi: effectiveRequire,
            grace_until: effectiveGrace || null,
          }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            typeof body?.detail === "string"
              ? body.detail
              : `request failed (${r.status})`,
          );
        }
        setRequireOn(null);
        setGraceUntil("");
        await mutatePolicy();
      } catch (err) {
        setPolicyError(
          err instanceof Error ? err.message : "failed to save policy",
        );
      } finally {
        setPolicySaving(false);
      }
    },
    [effectiveRequire, effectiveGrace, mutatePolicy],
  );

  const blocking =
    policy?.require_baa_for_phi &&
    !data?.has_active_baa &&
    !(policy?.grace_until && policy.grace_until >= new Date().toISOString().slice(0, 10));

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 sm:py-12 space-y-8">
      <div className="flex flex-col gap-2">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]"
        >
          <ArrowLeft size={12} />
          <span>back to settings</span>
        </Link>
        <h1 className="text-2xl font-mono lowercase tracking-tight">
          business associate agreements
        </h1>
        <p className="text-sm text-[var(--color-muted)] max-w-prose">
          Per-workspace HIPAA BAA register. Required evidence before any U.S.
          covered entity can lawfully send PHI to this service. Reads need
          viewer access. Mutations need admin plus MFA. Every change is
          audit-logged.
        </p>
      </div>

      {/* Enforcement status */}
      <Card>
        <CardHeader
          title="enforcement"
          right={
            blocking ? (
              <ShieldWarning weight="duotone" size={16} />
            ) : (
              <ShieldCheck weight="duotone" size={16} />
            )
          }
        />
        {polLoading ? (
          <div className="p-4 space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
        ) : polError ? (
          <div className="p-4">
            <ErrorBox message={polError.message} />
          </div>
        ) : policy ? (
          <form onSubmit={onSavePolicy} className="p-4 space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge tone={blocking ? "danger" : "success"}>
                {blocking ? "blocking phi" : "phi allowed"}
              </Badge>
              <Badge tone={data?.has_active_baa ? "success" : "neutral"}>
                {data?.has_active_baa
                  ? `${data.active_count} active baa`
                  : "no active baa"}
              </Badge>
              {policy.grace_until ? (
                <Badge tone="warn">grace until {policy.grace_until}</Badge>
              ) : null}
              {data?.expiring_30d ? (
                <Badge tone="warn">
                  {data.expiring_30d} expiring in 30d
                </Badge>
              ) : null}
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={effectiveRequire}
                  onChange={(e) => setRequireOn(e.target.checked)}
                  className="mt-0.5 accent-[var(--color-accent)]"
                />
                <span>
                  <span className="block font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                    require baa for phi
                  </span>
                  <span className="block text-[11px] text-[var(--color-muted)] mt-1">
                    When on, requests to /v1/predict, /v1/explain,
                    /v1/cohort, /v1/forecast, /v1/interventions, /v1/phi, and
                    /v1/dsar return HTTP 451 until an active BAA exists or the
                    grace window covers today.
                  </span>
                </span>
              </label>
              <Field
                label="grace until"
                hint="Optional ISO date through which enforcement is deferred."
              >
                <Input
                  type="date"
                  value={effectiveGrace}
                  onChange={(e) => setGraceUntil(e.target.value)}
                />
              </Field>
            </div>
            {policyError ? <ErrorBox message={policyError} /> : null}
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={policySaving}>
                {policySaving ? "saving" : "save policy"}
              </Button>
              <span className="text-[11px] text-[var(--color-muted)]">
                last updated {fmtTime(policy.updated_at)} by{" "}
                {policy.updated_by ?? "system"}
              </span>
            </div>
          </form>
        ) : null}
      </Card>

      {/* Create */}
      <Card>
        <CardHeader title="register a baa" right={<Plus weight="duotone" size={16} />} />
        <form onSubmit={onCreate} className="p-4 space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="counterparty">
              <Input
                value={counterparty}
                onChange={(e) => setCounterparty(e.target.value)}
                placeholder="Mercy Health System"
                maxLength={200}
                required
              />
            </Field>
            <Field label="document version">
              <Input
                value={docVersion}
                onChange={(e) => setDocVersion(e.target.value)}
                placeholder="v2.1"
                maxLength={64}
                required
              />
            </Field>
            <Field label="status">
              <Select
                value={statusVal}
                onChange={(e) =>
                  setStatusVal(e.target.value as (typeof STATUSES)[number])
                }
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="breach notify hours"
              hint="Contractual breach-notification window from discovery. HIPAA caps at 1440 (60 days); most BAAs sit at 24 to 72."
            >
              <Input
                type="number"
                min={1}
                max={60 * 24}
                value={breachHours}
                onChange={(e) => setBreachHours(e.target.value)}
                required
              />
            </Field>
            <Field label="effective on">
              <Input
                type="date"
                value={effectiveOn}
                onChange={(e) => setEffectiveOn(e.target.value)}
              />
            </Field>
            <Field label="expires on">
              <Input
                type="date"
                value={expiresOn}
                onChange={(e) => setExpiresOn(e.target.value)}
              />
            </Field>
            <Field label="covered entity signatory">
              <Input
                value={ceSig}
                onChange={(e) => setCeSig(e.target.value)}
                placeholder="J. Patel, Privacy Officer"
                maxLength={200}
              />
            </Field>
            <Field label="business associate signatory">
              <Input
                value={baSig}
                onChange={(e) => setBaSig(e.target.value)}
                placeholder="S. Liu, COO"
                maxLength={200}
              />
            </Field>
            <Field
              label="evidence url"
              hint="Link to the executed document in your contracts vault."
            >
              <Input
                value={evidenceUrl}
                onChange={(e) => setEvidenceUrl(e.target.value)}
                placeholder="https://vault.example/contracts/baa.pdf"
                maxLength={1024}
              />
            </Field>
            <Field label="notes">
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={4096}
              />
            </Field>
          </div>
          {formError ? <ErrorBox message={formError} /> : null}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={submitting}>
              {submitting ? "registering" : "register baa"}
            </Button>
            <a
              href="/api/baa?include_terminated=false"
              download
              className="inline-flex items-center gap-1.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]"
            >
              <DownloadSimple size={12} weight="duotone" /> json
            </a>
            <a
              href="/v1/admin/baa/export.csv"
              className="inline-flex items-center gap-1.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]"
            >
              <DownloadSimple size={12} weight="duotone" /> csv
            </a>
          </div>
        </form>
      </Card>

      {/* List */}
      <Card>
        <CardHeader
          title={`register ${data ? `(${data.total})` : ""}`.trim()}
          right={
            <label className="flex items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
              <Warning weight="duotone" size={14} />
              <input
                type="checkbox"
                checked={includeTerminated}
                onChange={(e) => setIncludeTerminated(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              show terminated
            </label>
          }
        />
        <div className="divide-y divide-[var(--color-border)]">
          {isLoading ? (
            <div className="p-4 space-y-3">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-5 w-1/2" />
            </div>
          ) : error ? (
            <div className="p-4">
              <ErrorBox message={error.message} />
            </div>
          ) : !data || data.entries.length === 0 ? (
            <Empty
              title="no agreements yet"
              hint="Register your first BAA above. Until an active BAA exists, the policy toggle will block PHI traffic if turned on."
            />
          ) : (
            data.entries.map((e) => (
              <div key={e.id} className="p-4 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">
                    {e.counterparty}
                  </span>
                  <span className="text-[11px] text-[var(--color-muted)] font-mono">
                    {e.document_version}
                  </span>
                  <Badge tone={statusTone(e.effective_status)}>
                    {e.effective_status}
                  </Badge>
                  {e.status !== e.effective_status ? (
                    <Badge tone="neutral">stored: {e.status}</Badge>
                  ) : null}
                  <Badge tone="neutral">v{e.version}</Badge>
                </div>
                <div className="text-[12px] text-[var(--color-muted)] space-y-0.5">
                  <div>
                    effective {e.effective_on ?? "unset"} to{" "}
                    {e.expires_on ?? "unset"} | breach notify{" "}
                    {e.breach_notify_hours}h
                  </div>
                  {e.covered_entity_signatory || e.business_associate_signatory ? (
                    <div>
                      signed by{" "}
                      {e.covered_entity_signatory ?? "unknown"} for the covered
                      entity, {e.business_associate_signatory ?? "unknown"} for
                      the business associate
                    </div>
                  ) : null}
                  {e.evidence_url ? (
                    <div className="truncate">
                      evidence:{" "}
                      <a
                        href={e.evidence_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-[var(--color-text)]"
                      >
                        {e.evidence_url}
                      </a>
                    </div>
                  ) : null}
                  {e.notes ? <div className="italic">{e.notes}</div> : null}
                  <div className="font-mono text-[10px]">
                    created {fmtTime(e.created_at)} by {e.created_by}
                    {e.updated_at
                      ? ` | updated ${fmtTime(e.updated_at)} by ${
                          e.updated_by ?? "system"
                        }`
                      : ""}
                  </div>
                </div>
                {e.status !== "terminated" ? (
                  <div>
                    <Button
                      onClick={() => onTerminate(e.id)}
                      disabled={terminatingId === e.id}
                      variant="ghost"
                    >
                      <XCircle size={12} weight="duotone" />
                      <span className="ml-1">
                        {terminatingId === e.id
                          ? "terminating"
                          : "terminate"}
                      </span>
                    </Button>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
