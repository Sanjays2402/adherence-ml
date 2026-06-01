"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  Archive,
  DownloadSimple,
  Plus,
  ShieldCheck,
  ShieldWarning,
  Warning,
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
  title: string;
  description: string;
  necessity: string | null;
  risks: string | null;
  mitigations: string | null;
  residual_risk: "low" | "moderate" | "high";
  dpo_consulted: boolean;
  consultation_required: boolean;
  review_due_at: string;
  review_overdue: boolean;
  version: number;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
  archived_by: string | null;
  archived_at: string | null;
  active: boolean;
};

type ListResp = {
  tenant_id: string;
  active_count: number;
  archived_count: number;
  overdue_count: number;
  entries: Entry[];
};

const RATINGS = ["low", "moderate", "high"] as const;

const fetcher = async (url: string): Promise<ListResp> => {
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

function TArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = "", ...rest } = props;
  return (
    <textarea
      {...rest}
      className={
        "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] " +
        "px-3 py-2 text-sm font-sans leading-relaxed " +
        "placeholder:text-[var(--color-muted)] focus:outline-none " +
        "focus:ring-1 focus:ring-[var(--color-accent)] " +
        className
      }
    />
  );
}

function riskTone(r: Entry["residual_risk"]): "success" | "warn" | "danger" {
  if (r === "low") return "success";
  if (r === "moderate") return "warn";
  return "danger";
}

export default function DpiaClient() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data, error, isLoading, mutate } = useSWR<ListResp>(
    `/api/dpia?include_archived=${includeArchived}`,
    fetcher,
  );

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [residual, setResidual] = useState<"low" | "moderate" | "high">(
    "moderate",
  );
  const [necessity, setNecessity] = useState("");
  const [risks, setRisks] = useState("");
  const [mitigations, setMitigations] = useState("");
  const [dpoConsulted, setDpoConsulted] = useState(false);
  const [consultationRequired, setConsultationRequired] = useState(false);
  const [reviewDays, setReviewDays] = useState<string>("365");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<number | null>(null);

  const reset = () => {
    setTitle("");
    setDescription("");
    setResidual("moderate");
    setNecessity("");
    setRisks("");
    setMitigations("");
    setDpoConsulted(false);
    setConsultationRequired(false);
    setReviewDays("365");
  };

  const onCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      if (title.trim().length < 3) {
        setFormError("title must be at least 3 characters");
        return;
      }
      if (description.trim().length < 10) {
        setFormError("description must be at least 10 characters");
        return;
      }
      const days = Number(reviewDays);
      if (!Number.isInteger(days) || days < 30 || days > 1095) {
        setFormError("review window must be between 30 and 1095 days");
        return;
      }
      setSubmitting(true);
      try {
        const r = await fetch("/api/dpia", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            description: description.trim(),
            residual_risk: residual,
            necessity: necessity.trim() || null,
            risks: risks.trim() || null,
            mitigations: mitigations.trim() || null,
            dpo_consulted: dpoConsulted,
            consultation_required: consultationRequired,
            review_in_days: days,
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
      title,
      description,
      residual,
      necessity,
      risks,
      mitigations,
      dpoConsulted,
      consultationRequired,
      reviewDays,
      mutate,
    ],
  );

  const onArchive = useCallback(
    async (id: number) => {
      setArchivingId(id);
      try {
        const r = await fetch(`/api/dpia/${id}/archive`, { method: "POST" });
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
        setFormError(err instanceof Error ? err.message : "failed to archive");
      } finally {
        setArchivingId(null);
      }
    },
    [mutate],
  );

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 sm:py-12 space-y-8">
      <div className="flex flex-col gap-2">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] w-fit"
        >
          <ArrowLeft weight="duotone" size={14} />
          settings
        </Link>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight inline-flex items-center gap-2">
              <ShieldWarning weight="duotone" size={26} />
              data protection impact assessments
            </h1>
            <p className="text-sm text-[var(--color-muted)] mt-1 max-w-2xl">
              GDPR Article 35 register. Document each high-risk processing
              activity with necessity, risks, mitigations, residual risk, and
              the next review date so procurement and regulators can verify
              the assessment is current.
            </p>
          </div>
          <a
            href="/api/dpia/export.csv"
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-2 text-xs hover:bg-[var(--color-bg-elevated)]"
          >
            <DownloadSimple weight="duotone" size={14} />
            download csv
          </a>
        </div>
      </div>

      {data && data.overdue_count > 0 ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs flex items-start gap-2">
          <Warning weight="duotone" size={16} className="text-amber-400 mt-0.5" />
          <div>
            <div className="font-medium">
              {data.overdue_count} assessment{data.overdue_count === 1 ? "" : "s"} overdue for review
            </div>
            <div className="text-[var(--color-muted)] mt-0.5">
              Update each overdue entry with a new review window to keep the
              register current.
            </div>
          </div>
        </div>
      ) : null}

      <Card>
        <CardHeader
          title="add an assessment"
          right={<Plus weight="duotone" size={18} />}
        />
        <form onSubmit={onCreate} className="px-5 pb-5 grid gap-4 sm:grid-cols-2">
          <Field label="title" hint="Short label for the processing activity.">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Adherence risk scoring"
              maxLength={128}
              required
            />
          </Field>
          <Field label="residual risk">
            <Select
              value={residual}
              onChange={(e) =>
                setResidual(e.target.value as "low" | "moderate" | "high")
              }
            >
              {RATINGS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="description"
            hint="Systematic description of the processing under Art. 35(7)(a)."
          >
            <TArea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Train and serve adherence risk model over patient dose history to drive clinician outreach."
              rows={3}
              minLength={10}
              maxLength={4096}
              required
            />
          </Field>
          <Field
            label="necessity and proportionality"
            hint="Art. 35(7)(b)."
          >
            <TArea
              value={necessity}
              onChange={(e) => setNecessity(e.target.value)}
              placeholder="No less intrusive way to flag high-risk patients in time."
              rows={3}
              maxLength={4096}
            />
          </Field>
          <Field
            label="identified risks"
            hint="Art. 35(7)(c). Risks to data subjects."
          >
            <TArea
              value={risks}
              onChange={(e) => setRisks(e.target.value)}
              placeholder="Re-identification of patients in small cohorts. Score bias in under-represented groups."
              rows={3}
              maxLength={4096}
            />
          </Field>
          <Field label="mitigations" hint="Art. 35(7)(d).">
            <TArea
              value={mitigations}
              onChange={(e) => setMitigations(e.target.value)}
              placeholder="Tenant scoping, k-anonymity floor in exports, drift monitoring with auto-mute."
              rows={3}
              maxLength={4096}
            />
          </Field>
          <Field
            label="review window (days)"
            hint="Next scheduled review. 30 to 1095 days."
          >
            <Input
              type="number"
              min={30}
              max={1095}
              value={reviewDays}
              onChange={(e) => setReviewDays(e.target.value)}
            />
          </Field>
          <div className="flex flex-col gap-2 text-xs">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={dpoConsulted}
                onChange={(e) => setDpoConsulted(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              data protection officer consulted
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={consultationRequired}
                onChange={(e) => setConsultationRequired(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              prior supervisory authority consultation required (Art. 36)
            </label>
          </div>
          {formError ? (
            <div className="sm:col-span-2">
              <ErrorBox message={formError} />
            </div>
          ) : null}
          <div className="sm:col-span-2 flex items-center justify-end gap-3">
            <span className="text-[11px] text-[var(--color-muted)] inline-flex items-center gap-1">
              <ShieldCheck weight="duotone" size={12} />
              admin role and active MFA required
            </span>
            <Button type="submit" disabled={submitting}>
              {submitting ? "saving" : "add assessment"}
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader
          title="register"
          right={
            <label className="inline-flex items-center gap-2 text-xs text-[var(--color-muted)]">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              show archived
            </label>
          }
        />
        <div className="px-5 pb-5 space-y-3">
          {error ? <ErrorBox message={error.message} /> : null}
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : null}
          {!isLoading && data && data.entries.length === 0 ? (
            <Empty
              title="no assessments yet"
              hint="Add at least one DPIA for any high-risk processing activity this workspace runs."
              icon={<ShieldWarning weight="duotone" size={28} />}
            />
          ) : null}
          {data?.entries.map((e) => (
            <div
              key={e.id}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4 space-y-2"
            >
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{e.title}</span>
                    <Badge tone={e.active ? "success" : "neutral"}>
                      {e.active ? "active" : "archived"}
                    </Badge>
                    <Badge tone="neutral">v{e.version}</Badge>
                    <Badge tone={riskTone(e.residual_risk)}>
                      residual: {e.residual_risk}
                    </Badge>
                    {e.dpo_consulted ? (
                      <Badge tone="neutral">DPO consulted</Badge>
                    ) : null}
                    {e.consultation_required ? (
                      <Badge tone="warn">Art. 36 consult</Badge>
                    ) : null}
                    {e.review_overdue && e.active ? (
                      <Badge tone="danger">review overdue</Badge>
                    ) : null}
                  </div>
                  <div className="text-xs text-[var(--color-muted)] mt-1">
                    review due {fmtTime(e.review_due_at)} {" · "}
                    added by {e.created_by} on {fmtTime(e.created_at)}
                    {e.updated_at
                      ? ` · updated by ${e.updated_by} on ${fmtTime(e.updated_at)}`
                      : ""}
                    {e.archived_at
                      ? ` · archived by ${e.archived_by} on ${fmtTime(e.archived_at)}`
                      : ""}
                  </div>
                </div>
                {e.active ? (
                  <Button
                    variant="ghost"
                    onClick={() => onArchive(e.id)}
                    disabled={archivingId === e.id}
                  >
                    <Archive weight="duotone" size={14} />
                    {archivingId === e.id ? "archiving" : "archive"}
                  </Button>
                ) : null}
              </div>
              <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                {e.description}
              </p>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
                {[
                  ["necessity and proportionality", e.necessity],
                  ["identified risks", e.risks],
                  ["mitigations", e.mitigations],
                ].map(([k, v]) =>
                  v ? (
                    <div key={k as string}>
                      <dt className="font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                        {k}
                      </dt>
                      <dd className="text-[var(--color-fg)]/90 mt-0.5 whitespace-pre-wrap break-words">
                        {v}
                      </dd>
                    </div>
                  ) : null,
                )}
              </dl>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
