"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  Archive,
  ClipboardText,
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
  Select,
  Skeleton,
} from "@/components/ui/primitives";

type Entry = {
  id: number;
  tenant_id: string;
  name: string;
  purpose: string;
  lawful_basis: string;
  data_categories: string | null;
  data_subjects: string | null;
  recipients: string | null;
  retention: string | null;
  transfers: string | null;
  security_measures: string | null;
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
  entries: Entry[];
};

const BASES = [
  "consent",
  "contract",
  "legal_obligation",
  "vital_interests",
  "public_task",
  "legitimate_interests",
];

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

export default function RopaClient() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data, error, isLoading, mutate } = useSWR<ListResp>(
    `/api/ropa?include_archived=${includeArchived}`,
    fetcher,
  );

  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [basis, setBasis] = useState("contract");
  const [subjects, setSubjects] = useState("");
  const [categories, setCategories] = useState("");
  const [recipients, setRecipients] = useState("");
  const [retention, setRetention] = useState("");
  const [transfers, setTransfers] = useState("");
  const [measures, setMeasures] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<number | null>(null);

  const reset = () => {
    setName("");
    setPurpose("");
    setBasis("contract");
    setSubjects("");
    setCategories("");
    setRecipients("");
    setRetention("");
    setTransfers("");
    setMeasures("");
  };

  const onCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      if (name.trim().length < 3) {
        setFormError("name must be at least 3 characters");
        return;
      }
      if (purpose.trim().length < 10) {
        setFormError("purpose must be at least 10 characters");
        return;
      }
      setSubmitting(true);
      try {
        const r = await fetch("/api/ropa", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            purpose: purpose.trim(),
            lawful_basis: basis,
            data_subjects: subjects.trim() || null,
            data_categories: categories.trim() || null,
            recipients: recipients.trim() || null,
            retention: retention.trim() || null,
            transfers: transfers.trim() || null,
            security_measures: measures.trim() || null,
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
    [name, purpose, basis, subjects, categories, recipients, retention, transfers, measures, mutate],
  );

  const onArchive = useCallback(
    async (id: number) => {
      setArchivingId(id);
      try {
        const r = await fetch(`/api/ropa/${id}/archive`, { method: "POST" });
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
              <ClipboardText weight="duotone" size={26} />
              record of processing activities
            </h1>
            <p className="text-sm text-[var(--color-muted)] mt-1 max-w-2xl">
              GDPR Article 30 register. Document every processing activity this
              workspace carries out so procurement and regulators can verify
              lawful basis, retention, and security measures.
            </p>
          </div>
          <a
            href="/api/ropa/export.csv"
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-2 text-xs hover:bg-[var(--color-bg-elevated)]"
          >
            <DownloadSimple weight="duotone" size={14} />
            download csv
          </a>
        </div>
      </div>

      <Card>
        <CardHeader
          title="add an entry"
          right={<Plus weight="duotone" size={18} />}
        />
        <form onSubmit={onCreate} className="px-5 pb-5 grid gap-4 sm:grid-cols-2">
          <Field label="name" hint="Short label for the activity.">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Adherence risk scoring"
              maxLength={128}
              required
            />
          </Field>
          <Field label="lawful basis">
            <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
              {BASES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="purpose" hint="Why personal data is processed.">
            <TArea
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="Compute medication adherence risk to support clinician outreach."
              rows={3}
              minLength={10}
              maxLength={2048}
              required
            />
          </Field>
          <Field label="data subjects">
            <TArea
              value={subjects}
              onChange={(e) => setSubjects(e.target.value)}
              placeholder="patients enrolled in adherence program"
              rows={2}
              maxLength={1024}
            />
          </Field>
          <Field label="data categories">
            <TArea
              value={categories}
              onChange={(e) => setCategories(e.target.value)}
              placeholder="dose history, demographics"
              rows={2}
              maxLength={1024}
            />
          </Field>
          <Field label="recipients">
            <TArea
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder="internal care coordinators"
              rows={2}
              maxLength={1024}
            />
          </Field>
          <Field label="retention period">
            <Input
              value={retention}
              onChange={(e) => setRetention(e.target.value)}
              placeholder="36 months from last dose event"
              maxLength={256}
            />
          </Field>
          <Field label="international transfers">
            <TArea
              value={transfers}
              onChange={(e) => setTransfers(e.target.value)}
              placeholder="none; data stays in EU region"
              rows={2}
              maxLength={1024}
            />
          </Field>
          <Field label="security measures">
            <TArea
              value={measures}
              onChange={(e) => setMeasures(e.target.value)}
              placeholder="encryption at rest, row-level tenant scoping, audit log"
              rows={2}
              maxLength={2048}
            />
          </Field>
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
              {submitting ? "saving" : "add entry"}
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
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : null}
          {!isLoading && data && data.entries.length === 0 ? (
            <Empty
              title="no entries yet"
              hint="Add at least one entry to satisfy GDPR Art. 30 for this workspace."
              icon={<ClipboardText weight="duotone" size={28} />}
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
                    <span className="font-medium text-sm">{e.name}</span>
                    <Badge tone={e.active ? "success" : "neutral"}>
                      {e.active ? "active" : "archived"}
                    </Badge>
                    <Badge tone="neutral">v{e.version}</Badge>
                    <Badge tone="neutral">{e.lawful_basis}</Badge>
                  </div>
                  <div className="text-xs text-[var(--color-muted)] mt-1">
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
              <p className="text-sm leading-relaxed">{e.purpose}</p>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
                {[
                  ["data subjects", e.data_subjects],
                  ["data categories", e.data_categories],
                  ["recipients", e.recipients],
                  ["retention", e.retention],
                  ["transfers", e.transfers],
                  ["security measures", e.security_measures],
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
