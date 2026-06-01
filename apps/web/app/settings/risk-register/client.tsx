"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle,
  DownloadSimple,
  ShieldWarning,
  WarningCircle,
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
  category: string;
  description: string;
  asset: string | null;
  likelihood: number;
  impact: number;
  inherent_score: number;
  mitigations: string | null;
  residual_likelihood: number;
  residual_impact: number;
  residual_score: number;
  treatment: string;
  owner: string;
  status: string;
  identified_at: string;
  next_review_at: string | null;
  notes: string | null;
  version: number;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
  closed_reason: string | null;
  active: boolean;
  review_overdue: boolean;
};

type ListResp = {
  tenant_id: string;
  active_count: number;
  closed_count: number;
  overdue_count: number;
  entries: Entry[];
};

const CATEGORIES = [
  "security",
  "privacy",
  "availability",
  "integrity",
  "confidentiality",
  "compliance",
  "operational",
  "financial",
  "vendor",
  "model",
  "other",
];

const TREATMENTS = ["accept", "mitigate", "transfer", "avoid"];

const SCORES = [1, 2, 3, 4, 5];

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

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

function scoreTone(score: number): "success" | "warn" | "danger" {
  if (score >= 15) return "danger";
  if (score >= 8) return "warn";
  return "success";
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

export default function RiskRegisterClient() {
  const [includeClosed, setIncludeClosed] = useState(false);
  const [filterCategory, setFilterCategory] = useState<string>("");
  const url = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("include_closed", String(includeClosed));
    if (filterCategory) sp.set("category", filterCategory);
    return `/api/risk-register?${sp.toString()}`;
  }, [includeClosed, filterCategory]);
  const { data, error, isLoading, mutate } = useSWR<ListResp>(url, fetcher);

  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("security");
  const [description, setDescription] = useState("");
  const [asset, setAsset] = useState("");
  const [likelihood, setLikelihood] = useState(3);
  const [impact, setImpact] = useState(3);
  const [mitigations, setMitigations] = useState("");
  const [resL, setResL] = useState(3);
  const [resI, setResI] = useState(3);
  const [treatment, setTreatment] = useState("mitigate");
  const [owner, setOwner] = useState("");
  const [nextReview, setNextReview] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<number | null>(null);
  const [closeReason, setCloseReason] = useState<string>("");

  const reset = () => {
    setTitle("");
    setCategory("security");
    setDescription("");
    setAsset("");
    setLikelihood(3);
    setImpact(3);
    setMitigations("");
    setResL(3);
    setResI(3);
    setTreatment("mitigate");
    setOwner("");
    setNextReview("");
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
      if (resL > likelihood || resI > impact) {
        setFormError("residual scores cannot exceed inherent scores");
        return;
      }
      if (!owner.trim()) {
        setFormError("owner is required");
        return;
      }
      setSubmitting(true);
      try {
        const r = await fetch("/api/risk-register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            category,
            description: description.trim(),
            asset: asset.trim() || null,
            likelihood,
            impact,
            mitigations: mitigations.trim() || null,
            residual_likelihood: resL,
            residual_impact: resI,
            treatment,
            owner: owner.trim(),
            next_review_at: nextReview.trim() || null,
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
      category,
      description,
      asset,
      likelihood,
      impact,
      mitigations,
      resL,
      resI,
      treatment,
      owner,
      nextReview,
      mutate,
    ],
  );

  const onClose = useCallback(
    async (id: number) => {
      setClosingId(id);
      try {
        const r = await fetch(`/api/risk-register/${id}/close`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: closeReason.trim() || null }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            typeof body?.detail === "string"
              ? body.detail
              : `request failed (${r.status})`,
          );
        }
        setCloseReason("");
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed to close");
      } finally {
        setClosingId(null);
      }
    },
    [closeReason, mutate],
  );

  const inherent = likelihood * impact;
  const residual = resL * resI;

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
              enterprise risk register
            </h1>
            <p className="text-sm text-[var(--color-muted)] mt-1 max-w-2xl">
              Forward-looking risk catalogue scoped to this workspace.
              Required evidence for ISO 31000, SOC 2 CC3.2, and most
              enterprise procurement reviews. Mutations require admin role
              with active MFA and are written to the admin audit log.
            </p>
          </div>
          <a
            href="/api/risk-register/export.csv"
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-2 text-xs hover:bg-[var(--color-bg-elevated)]"
          >
            <DownloadSimple weight="duotone" size={14} />
            download csv
          </a>
        </div>
      </div>

      <Card>
        <CardHeader
          title="add risk"
          hint="Capture a new risk with inherent and residual scoring."
        />
        <form
          onSubmit={onCreate}
          className="px-4 sm:px-6 py-5 grid grid-cols-1 sm:grid-cols-2 gap-4"
        >
          <Field label="title">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Model drift on adherence scoring"
              maxLength={128}
              required
            />
          </Field>
          <Field label="category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="description"
            hint="Plain-language risk narrative; 10 to 4096 characters."
          >
            <TArea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={4096}
              required
            />
          </Field>
          <Field label="asset / system" hint="Optional. What is at risk.">
            <Input
              value={asset}
              onChange={(e) => setAsset(e.target.value)}
              placeholder="adherence-api, prediction model"
              maxLength={256}
            />
          </Field>
          <Field label="inherent likelihood (1 to 5)">
            <Select
              value={String(likelihood)}
              onChange={(e) => setLikelihood(Number(e.target.value))}
            >
              {SCORES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="inherent impact (1 to 5)">
            <Select
              value={String(impact)}
              onChange={(e) => setImpact(Number(e.target.value))}
            >
              {SCORES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="mitigations in place"
            hint="Controls already deployed."
          >
            <TArea
              rows={2}
              value={mitigations}
              onChange={(e) => setMitigations(e.target.value)}
              maxLength={4096}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="residual likelihood">
              <Select
                value={String(resL)}
                onChange={(e) => setResL(Number(e.target.value))}
              >
                {SCORES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="residual impact">
              <Select
                value={String(resI)}
                onChange={(e) => setResI(Number(e.target.value))}
              >
                {SCORES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="treatment">
            <Select
              value={treatment}
              onChange={(e) => setTreatment(e.target.value)}
            >
              {TREATMENTS.map((t) => (
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
              placeholder="security@acme"
              maxLength={128}
              required
            />
          </Field>
          <Field
            label="next review (YYYY-MM-DD)"
            hint="Optional. Overdue reviews are flagged."
          >
            <Input
              type="date"
              value={nextReview}
              onChange={(e) => setNextReview(e.target.value)}
            />
          </Field>
          <div className="sm:col-span-2 flex items-center justify-between gap-3 flex-wrap pt-2 border-t border-[var(--color-border)]">
            <div className="flex items-center gap-3 text-xs">
              <span className="text-[var(--color-muted)]">inherent</span>
              <Badge tone={scoreTone(inherent)}>{inherent}</Badge>
              <span className="text-[var(--color-muted)]">residual</span>
              <Badge tone={scoreTone(residual)}>{residual}</Badge>
            </div>
            <Button type="submit" disabled={submitting}>
              {submitting ? "saving..." : "add risk"}
            </Button>
          </div>
          {formError ? (
            <div className="sm:col-span-2">
              <ErrorBox message={formError} />
            </div>
          ) : null}
        </form>
      </Card>

      <Card>
        <CardHeader
          title="register"
          hint={
            data
              ? `${data.active_count} active, ${data.closed_count} closed, ${data.overdue_count} overdue review`
              : "loading"
          }
          right={
            <div className="flex items-center gap-2 flex-wrap">
              <Select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                aria-label="filter by category"
              >
                <option value="">all categories</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
              <label className="inline-flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
                <input
                  type="checkbox"
                  checked={includeClosed}
                  onChange={(e) => setIncludeClosed(e.target.checked)}
                />
                show closed
              </label>
            </div>
          }
        />
        <div className="px-4 sm:px-6 py-5 space-y-3">
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : error ? (
            <ErrorBox message={(error as Error).message} />
          ) : !data || data.entries.length === 0 ? (
            <Empty
              icon={<ShieldWarning weight="duotone" size={32} />}
              title="no risks recorded yet"
              hint="Add the first risk above. Procurement reviewers expect to see this register populated."
            />
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {data.entries.map((e) => (
                <li key={e.id} className="py-3 flex flex-col gap-2">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate flex items-center gap-2">
                        {e.title}
                        {e.review_overdue ? (
                          <Badge tone="warn">
                            <WarningCircle weight="duotone" size={10} />
                            review overdue
                          </Badge>
                        ) : null}
                        {!e.active ? (
                          <Badge tone="neutral">
                            <CheckCircle weight="duotone" size={10} />
                            closed
                          </Badge>
                        ) : null}
                      </div>
                      <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--color-muted)] mt-0.5">
                        #{e.id} • {e.category} • {e.treatment} • owner {e.owner}
                        {e.asset ? ` • ${e.asset}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-xs">
                      <span className="text-[var(--color-muted)]">inherent</span>
                      <Badge tone={scoreTone(e.inherent_score)}>
                        {e.inherent_score}
                      </Badge>
                      <span className="text-[var(--color-muted)]">residual</span>
                      <Badge tone={scoreTone(e.residual_score)}>
                        {e.residual_score}
                      </Badge>
                    </div>
                  </div>
                  <p className="text-[13px] text-[var(--color-fg)]/85 whitespace-pre-wrap">
                    {e.description}
                  </p>
                  {e.mitigations ? (
                    <p className="text-[12px] text-[var(--color-muted)] whitespace-pre-wrap">
                      <span className="font-mono uppercase tracking-[0.12em]">
                        mitigations:{" "}
                      </span>
                      {e.mitigations}
                    </p>
                  ) : null}
                  <div className="text-[11px] font-mono text-[var(--color-muted)] flex flex-wrap gap-x-4 gap-y-1">
                    <span>identified {fmtDate(e.identified_at)}</span>
                    {e.next_review_at ? (
                      <span>review due {fmtDate(e.next_review_at)}</span>
                    ) : null}
                    <span>v{e.version}</span>
                    <span>created by {e.created_by}</span>
                    {e.updated_at ? (
                      <span>
                        updated {fmtTime(e.updated_at)} by {e.updated_by ?? "?"}
                      </span>
                    ) : null}
                    {e.closed_at ? (
                      <span>
                        closed {fmtTime(e.closed_at)} by {e.closed_by ?? "?"}
                      </span>
                    ) : null}
                  </div>
                  {e.active ? (
                    <div className="flex items-center gap-2 pt-1">
                      <Input
                        placeholder="close reason (optional)"
                        value={closingId === e.id ? closeReason : ""}
                        onChange={(ev) => {
                          setClosingId(e.id);
                          setCloseReason(ev.target.value);
                        }}
                        onFocus={() => setClosingId(e.id)}
                        maxLength={256}
                      />
                      <Button
                        onClick={() => onClose(e.id)}
                        disabled={closingId === e.id && submitting}
                        variant="ghost"
                      >
                        close
                      </Button>
                    </div>
                  ) : e.closed_reason ? (
                    <p className="text-[12px] text-[var(--color-muted)]">
                      <span className="font-mono uppercase tracking-[0.12em]">
                        reason:{" "}
                      </span>
                      {e.closed_reason}
                    </p>
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
