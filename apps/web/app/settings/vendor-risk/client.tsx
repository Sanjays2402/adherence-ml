"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  Buildings,
  ClockCountdown,
  DownloadSimple,
  Eye,
  Plus,
  ShieldCheck,
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

type Risk = "low" | "medium" | "high" | "critical";
type Status = "proposed" | "approved" | "conditional" | "rejected" | "retired";
type VendorType =
  | "subprocessor"
  | "integration"
  | "internal_tool"
  | "infrastructure"
  | "consultant"
  | "other";
type DataClass = "none" | "metadata" | "pii" | "phi" | "financial" | "secrets";
type Outcome = "approved" | "conditional" | "rejected" | "needs_followup";

type Entry = {
  id: number;
  tenant_id: string;
  vendor_name: string;
  vendor_type: VendorType;
  data_shared: DataClass;
  inherent_risk: Risk;
  residual_risk: Risk;
  soc2: boolean;
  iso27001: boolean;
  hipaa: boolean;
  pci_dss: boolean;
  evidence_url: string | null;
  owner: string;
  status: Status;
  notes: string | null;
  review_cadence_days: number;
  last_reviewed_at: string | null;
  last_review_outcome: string | null;
  next_review_at: string;
  review_overdue: boolean;
  version: number;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
  retired_by: string | null;
  retired_at: string | null;
  active: boolean;
};

type ListResp = {
  tenant_id: string;
  active_count: number;
  retired_count: number;
  overdue_count: number;
  entries: Entry[];
};

const VENDOR_TYPES: VendorType[] = [
  "subprocessor",
  "integration",
  "internal_tool",
  "infrastructure",
  "consultant",
  "other",
];
const DATA_CLASSES: DataClass[] = [
  "none",
  "metadata",
  "pii",
  "phi",
  "financial",
  "secrets",
];
const RISK_TIERS: Risk[] = ["low", "medium", "high", "critical"];
const STATUSES: Status[] = ["proposed", "approved", "conditional", "rejected"];
const OUTCOMES: Outcome[] = [
  "approved",
  "conditional",
  "rejected",
  "needs_followup",
];

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

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

function riskTone(r: Risk): "success" | "warn" | "danger" | "neutral" {
  if (r === "low") return "success";
  if (r === "medium") return "neutral";
  if (r === "high") return "warn";
  return "danger";
}

function statusTone(s: Status): "success" | "warn" | "danger" | "neutral" {
  if (s === "approved") return "success";
  if (s === "conditional") return "warn";
  if (s === "rejected") return "danger";
  return "neutral";
}

function dataTone(d: DataClass): "neutral" | "warn" | "danger" {
  if (d === "phi" || d === "secrets" || d === "financial") return "danger";
  if (d === "pii") return "warn";
  return "neutral";
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

function CertCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[11px]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[var(--color-accent)]"
      />
      <span className="font-mono uppercase tracking-[0.14em]">{label}</span>
    </label>
  );
}

export default function VendorRiskClient() {
  const [includeRetired, setIncludeRetired] = useState(false);
  const { data, error, isLoading, mutate } = useSWR<ListResp>(
    `/api/vendor-risk?include_retired=${includeRetired}`,
    fetcher<ListResp>,
  );

  const [name, setName] = useState("");
  const [vtype, setVtype] = useState<VendorType>("subprocessor");
  const [owner, setOwner] = useState("");
  const [dshared, setDshared] = useState<DataClass>("metadata");
  const [inh, setInh] = useState<Risk>("medium");
  const [res, setRes] = useState<Risk>("medium");
  const [soc2, setSoc2] = useState(false);
  const [iso, setIso] = useState(false);
  const [hipaa, setHipaa] = useState(false);
  const [pci, setPci] = useState(false);
  const [evUrl, setEvUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [cadence, setCadence] = useState("365");
  const [statusVal, setStatusVal] = useState<Status>("proposed");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [reviewingId, setReviewingId] = useState<number | null>(null);
  const [reviewOutcome, setReviewOutcome] = useState<Outcome>("approved");
  const [reviewNotes, setReviewNotes] = useState("");
  const [reviewBusy, setReviewBusy] = useState<number | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [retiringId, setRetiringId] = useState<number | null>(null);

  const reset = () => {
    setName("");
    setVtype("subprocessor");
    setOwner("");
    setDshared("metadata");
    setInh("medium");
    setRes("medium");
    setSoc2(false);
    setIso(false);
    setHipaa(false);
    setPci(false);
    setEvUrl("");
    setNotes("");
    setCadence("365");
    setStatusVal("proposed");
  };

  const onCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      if (name.trim().length < 2) {
        setFormError("vendor name must be at least 2 characters");
        return;
      }
      if (owner.trim().length < 1) {
        setFormError("owner is required");
        return;
      }
      const cad = Number(cadence);
      if (!Number.isInteger(cad) || cad < 30 || cad > 365 * 3) {
        setFormError("review cadence must be between 30 and 1095 days");
        return;
      }
      if (RISK_TIERS.indexOf(res) > RISK_TIERS.indexOf(inh)) {
        setFormError("residual risk cannot exceed inherent risk");
        return;
      }
      if (
        evUrl.trim() &&
        !(evUrl.startsWith("http://") || evUrl.startsWith("https://"))
      ) {
        setFormError("evidence url must start with http:// or https://");
        return;
      }
      setSubmitting(true);
      try {
        const r = await fetch("/api/vendor-risk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            vendor_name: name.trim(),
            vendor_type: vtype,
            owner: owner.trim(),
            data_shared: dshared,
            inherent_risk: inh,
            residual_risk: res,
            soc2,
            iso27001: iso,
            hipaa,
            pci_dss: pci,
            evidence_url: evUrl.trim() || null,
            status: statusVal,
            notes: notes.trim() || null,
            review_cadence_days: cad,
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
      name,
      vtype,
      owner,
      dshared,
      inh,
      res,
      soc2,
      iso,
      hipaa,
      pci,
      evUrl,
      notes,
      cadence,
      statusVal,
      mutate,
    ],
  );

  const onReview = useCallback(
    async (id: number) => {
      setReviewError(null);
      setReviewBusy(id);
      try {
        const r = await fetch(`/api/vendor-risk/${id}/review`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            outcome: reviewOutcome,
            notes: reviewNotes.trim() || null,
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
        setReviewingId(null);
        setReviewNotes("");
        setReviewOutcome("approved");
        await mutate();
      } catch (err) {
        setReviewError(
          err instanceof Error ? err.message : "failed to record review",
        );
      } finally {
        setReviewBusy(null);
      }
    },
    [reviewOutcome, reviewNotes, mutate],
  );

  const onRetire = useCallback(
    async (id: number) => {
      setRetiringId(id);
      try {
        const r = await fetch(`/api/vendor-risk/${id}/retire`, {
          method: "POST",
        });
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
          err instanceof Error ? err.message : "failed to retire vendor",
        );
      } finally {
        setRetiringId(null);
      }
    },
    [mutate],
  );

  const totals = useMemo(() => {
    if (!data) return null;
    const phi = data.entries.filter(
      (e) => e.active && e.data_shared === "phi",
    ).length;
    const noSoc2HighRisk = data.entries.filter(
      (e) =>
        e.active &&
        !e.soc2 &&
        (e.residual_risk === "high" || e.residual_risk === "critical"),
    ).length;
    return { phi, noSoc2HighRisk };
  }, [data]);

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
          vendor risk register
        </h1>
        <p className="text-sm text-[var(--color-muted)] max-w-prose">
          Per-workspace vendor risk assessments. Track every sub-processor,
          integration, and internal tool with the data class shared, inherent
          and residual risk, attested certifications, owner, status, and
          review cadence. Reads need viewer access. Mutations need admin plus
          MFA. Every change is audit-logged.
        </p>
      </div>

      <Card>
        <CardHeader title="posture" right={<ShieldCheck weight="duotone" size={16} />} />
        <div className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
              active
            </div>
            <div className="text-xl font-mono mt-1">
              {data ? data.active_count : "."}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
              overdue review
            </div>
            <div className="text-xl font-mono mt-1">
              {data ? data.overdue_count : "."}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
              phi vendors
            </div>
            <div className="text-xl font-mono mt-1">
              {totals ? totals.phi : "."}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
              high risk no soc2
            </div>
            <div className="text-xl font-mono mt-1">
              {totals ? totals.noSoc2HighRisk : "."}
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="register a vendor" right={<Plus weight="duotone" size={16} />} />
        <form onSubmit={onCreate} className="p-4 space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="vendor name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="OpenAI"
                maxLength={128}
                required
              />
            </Field>
            <Field label="vendor type">
              <Select value={vtype} onChange={(e) => setVtype(e.target.value as VendorType)}>
                {VENDOR_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="owner">
              <Input
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                placeholder="J. Patel, Security"
                maxLength={128}
                required
              />
            </Field>
            <Field
              label="data shared"
              hint="The most sensitive data class this vendor can access."
            >
              <Select
                value={dshared}
                onChange={(e) => setDshared(e.target.value as DataClass)}
              >
                {DATA_CLASSES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="inherent risk">
              <Select value={inh} onChange={(e) => setInh(e.target.value as Risk)}>
                {RISK_TIERS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="residual risk"
              hint="Risk after controls. Cannot exceed inherent risk."
            >
              <Select value={res} onChange={(e) => setRes(e.target.value as Risk)}>
                {RISK_TIERS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="initial status">
              <Select
                value={statusVal}
                onChange={(e) => setStatusVal(e.target.value as Status)}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="review cadence days"
              hint="Days between scheduled reviews. 30 to 1095."
            >
              <Input
                type="number"
                min={30}
                max={365 * 3}
                value={cadence}
                onChange={(e) => setCadence(e.target.value)}
                required
              />
            </Field>
            <Field
              label="evidence url"
              hint="Link to attestation, SOC2 report, or vendor due-diligence pack."
            >
              <Input
                value={evUrl}
                onChange={(e) => setEvUrl(e.target.value)}
                placeholder="https://vault.example/vendors/openai-soc2.pdf"
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
          <div className="flex flex-wrap gap-4 pt-2 border-t border-[var(--color-border)]">
            <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)] w-full">
              attested certifications
            </span>
            <CertCheckbox label="soc2" checked={soc2} onChange={setSoc2} />
            <CertCheckbox label="iso27001" checked={iso} onChange={setIso} />
            <CertCheckbox label="hipaa" checked={hipaa} onChange={setHipaa} />
            <CertCheckbox label="pci dss" checked={pci} onChange={setPci} />
          </div>
          {formError ? <ErrorBox message={formError} /> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={submitting}>
              {submitting ? "registering" : "register vendor"}
            </Button>
            <a
              href={`/api/vendor-risk/export.csv?include_retired=${includeRetired}`}
              className="inline-flex items-center gap-1.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]"
            >
              <DownloadSimple size={12} weight="duotone" /> csv
            </a>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader
          title={`register ${data ? `(${data.entries.length})` : ""}`.trim()}
          right={
            <label className="flex items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
              <Eye weight="duotone" size={14} />
              <input
                type="checkbox"
                checked={includeRetired}
                onChange={(e) => setIncludeRetired(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              show retired
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
              title="no vendors yet"
              hint="Register your first vendor above. Sub-processors, integrations, and internal tools that touch workspace data all belong here."
            />
          ) : (
            data.entries.map((e) => {
              const certs: string[] = [];
              if (e.soc2) certs.push("soc2");
              if (e.iso27001) certs.push("iso27001");
              if (e.hipaa) certs.push("hipaa");
              if (e.pci_dss) certs.push("pci");
              const isReviewing = reviewingId === e.id;
              return (
                <div key={e.id} className="p-4 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Buildings size={14} weight="duotone" />
                    <span className="text-[13px] font-medium">{e.vendor_name}</span>
                    <Badge tone="neutral">{e.vendor_type}</Badge>
                    <Badge tone={dataTone(e.data_shared)}>
                      data: {e.data_shared}
                    </Badge>
                    <Badge tone={riskTone(e.residual_risk)}>
                      residual: {e.residual_risk}
                    </Badge>
                    <Badge tone={statusTone(e.status)}>{e.status}</Badge>
                    <Badge tone="neutral">v{e.version}</Badge>
                    {e.review_overdue ? (
                      <Badge tone="warn">
                        <ClockCountdown
                          size={10}
                          weight="duotone"
                          className="inline mr-0.5"
                        />
                        overdue
                      </Badge>
                    ) : null}
                  </div>
                  <div className="text-[12px] text-[var(--color-muted)] space-y-0.5">
                    <div>
                      owner: {e.owner} | inherent: {e.inherent_risk} | next
                      review {fmtDate(e.next_review_at)} | cadence{" "}
                      {e.review_cadence_days}d
                    </div>
                    <div>
                      attested: {certs.length > 0 ? certs.join(", ") : "none on file"}
                    </div>
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
                    {e.last_reviewed_at ? (
                      <div>
                        last review: {e.last_review_outcome} on{" "}
                        {fmtDate(e.last_reviewed_at)}
                      </div>
                    ) : (
                      <div>no review on record</div>
                    )}
                    {e.notes ? <div className="italic">{e.notes}</div> : null}
                    <div className="font-mono text-[10px]">
                      created {fmtDate(e.created_at)} by {e.created_by}
                      {e.updated_at
                        ? ` | updated ${fmtDate(e.updated_at)} by ${e.updated_by ?? "system"}`
                        : ""}
                      {e.retired_at
                        ? ` | retired ${fmtDate(e.retired_at)} by ${e.retired_by ?? "system"}`
                        : ""}
                    </div>
                  </div>
                  {e.active ? (
                    isReviewing ? (
                      <div className="space-y-2 pt-2 border-t border-[var(--color-border)]">
                        <div className="grid sm:grid-cols-2 gap-2">
                          <Field label="outcome">
                            <Select
                              value={reviewOutcome}
                              onChange={(ev) =>
                                setReviewOutcome(ev.target.value as Outcome)
                              }
                            >
                              {OUTCOMES.map((o) => (
                                <option key={o} value={o}>
                                  {o}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          <Field label="notes">
                            <Input
                              value={reviewNotes}
                              onChange={(ev) => setReviewNotes(ev.target.value)}
                              maxLength={4096}
                              placeholder="Verified SOC2 Type II report dated 2026-03-12"
                            />
                          </Field>
                        </div>
                        {reviewError ? <ErrorBox message={reviewError} /> : null}
                        <div className="flex items-center gap-2">
                          <Button
                            onClick={() => onReview(e.id)}
                            disabled={reviewBusy === e.id}
                          >
                            {reviewBusy === e.id ? "recording" : "record review"}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setReviewingId(null);
                              setReviewError(null);
                            }}
                          >
                            cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setReviewingId(e.id);
                            setReviewError(null);
                            setReviewOutcome("approved");
                            setReviewNotes("");
                          }}
                        >
                          <ClockCountdown size={12} weight="duotone" />
                          <span className="ml-1">record review</span>
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => onRetire(e.id)}
                          disabled={retiringId === e.id}
                        >
                          <XCircle size={12} weight="duotone" />
                          <span className="ml-1">
                            {retiringId === e.id ? "retiring" : "retire"}
                          </span>
                        </Button>
                      </div>
                    )
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </Card>
    </div>
  );
}
