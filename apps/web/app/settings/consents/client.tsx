"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  DownloadSimple,
  Plus,
  Prohibit,
  ShieldCheck,
  User,
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

type Consent = {
  id: number;
  tenant_id: string;
  subject_ref: string;
  subject_hash: string;
  purpose: string;
  lawful_basis: string;
  capture_channel: string;
  evidence_ref: string | null;
  notes: string | null;
  version: number;
  granted_by: string;
  granted_at: string;
  updated_by: string | null;
  updated_at: string | null;
  withdrawn_by: string | null;
  withdrawn_at: string | null;
  withdrawal_reason: string | null;
  active: boolean;
};

type ListResp = {
  tenant_id: string;
  active_count: number;
  withdrawn_count: number;
  active_subjects: number;
  active_purposes: string[];
  entries: Consent[];
};

const LAWFUL_BASES = [
  "consent",
  "contract",
  "legal_obligation",
  "vital_interests",
  "public_task",
  "legitimate_interests",
  "hipaa_authorization",
  "hipaa_treatment",
] as const;

const CAPTURE_CHANNELS = [
  "web_form",
  "paper_form",
  "verbal_recorded",
  "api",
  "import",
  "other",
] as const;

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

function basisTone(b: string): "success" | "warn" | "danger" | "neutral" {
  if (b === "consent" || b === "hipaa_authorization") return "success";
  if (b === "legitimate_interests" || b === "public_task") return "warn";
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

export default function ConsentsClient() {
  const [includeWithdrawn, setIncludeWithdrawn] = useState(false);
  const [filterSubject, setFilterSubject] = useState("");
  const [filterPurpose, setFilterPurpose] = useState("");

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    p.set("include_withdrawn", String(includeWithdrawn));
    if (filterSubject.trim()) p.set("subject_ref", filterSubject.trim());
    if (filterPurpose.trim()) p.set("purpose", filterPurpose.trim());
    return p.toString();
  }, [includeWithdrawn, filterSubject, filterPurpose]);

  const { data, error, isLoading, mutate } = useSWR<ListResp>(
    `/api/consents?${qs}`,
    fetcher,
    { refreshInterval: 30_000 },
  );

  const [subjectRef, setSubjectRef] = useState("");
  const [purpose, setPurpose] = useState("");
  const [lawfulBasis, setLawfulBasis] =
    useState<(typeof LAWFUL_BASES)[number]>("consent");
  const [captureChannel, setCaptureChannel] =
    useState<(typeof CAPTURE_CHANNELS)[number]>("web_form");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [withdrawingId, setWithdrawingId] = useState<number | null>(null);

  const reset = () => {
    setSubjectRef("");
    setPurpose("");
    setLawfulBasis("consent");
    setCaptureChannel("web_form");
    setEvidenceRef("");
    setNotes("");
  };

  const onGrant = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      if (subjectRef.trim().length < 1) {
        setFormError("subject reference is required");
        return;
      }
      if (purpose.trim().length < 2) {
        setFormError("purpose must be at least 2 characters");
        return;
      }
      setSubmitting(true);
      try {
        const r = await fetch("/api/consents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            subject_ref: subjectRef.trim(),
            purpose: purpose.trim(),
            lawful_basis: lawfulBasis,
            capture_channel: captureChannel,
            evidence_ref: evidenceRef.trim() || null,
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
        setFormError(err instanceof Error ? err.message : "failed to record");
      } finally {
        setSubmitting(false);
      }
    },
    [
      subjectRef,
      purpose,
      lawfulBasis,
      captureChannel,
      evidenceRef,
      notes,
      mutate,
    ],
  );

  const onWithdraw = useCallback(
    async (id: number) => {
      const reason =
        typeof window !== "undefined"
          ? window.prompt(
              "Reason for withdrawal (optional, kept in audit log)",
              "",
            )
          : "";
      setWithdrawingId(id);
      try {
        const r = await fetch(`/api/consents/${id}/withdraw`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: reason || null }),
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
        setFormError(err instanceof Error ? err.message : "failed to withdraw");
      } finally {
        setWithdrawingId(null);
      }
    },
    [mutate],
  );

  const entries = data?.entries ?? [];

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
              <ShieldCheck weight="duotone" size={26} />
              consent register
            </h1>
            <p className="text-sm text-[var(--color-muted)] mt-1 max-w-2xl">
              Per-workspace data subject consent receipts. Covers HIPAA
              Authorization (45 CFR 164.508) and GDPR Article 7. Every grant
              and withdrawal is admin-MFA gated and written to the audit log.
              Subject references are hashed for indexing so cross-tenant
              correlation by hash is impossible.
            </p>
          </div>
          <a
            href="/api/consents/export.csv"
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-2 text-xs hover:bg-[var(--color-bg-elevated)]"
          >
            <DownloadSimple weight="duotone" size={14} />
            download csv
          </a>
        </div>
      </div>

      <Card>
        <CardHeader
          title="record a consent receipt"
          right={<Plus weight="duotone" size={18} />}
        />
        <form
          onSubmit={onGrant}
          className="px-5 pb-5 grid gap-4 sm:grid-cols-2"
        >
          <Field label="subject reference" hint="patient id, member id, email">
            <Input
              value={subjectRef}
              onChange={(e) => setSubjectRef(e.target.value)}
              placeholder="patient:000123"
              maxLength={256}
              required
            />
          </Field>
          <Field label="purpose" hint="dot.notation, lowercased server-side">
            <Input
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="research.secondary_use"
              maxLength={96}
              required
            />
          </Field>
          <Field label="lawful basis">
            <Select
              value={lawfulBasis}
              onChange={(e) =>
                setLawfulBasis(
                  e.target.value as (typeof LAWFUL_BASES)[number],
                )
              }
            >
              {LAWFUL_BASES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="capture channel">
            <Select
              value={captureChannel}
              onChange={(e) =>
                setCaptureChannel(
                  e.target.value as (typeof CAPTURE_CHANNELS)[number],
                )
              }
            >
              {CAPTURE_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field
              label="evidence reference"
              hint="form id, doc id, recording id (optional)"
            >
              <Input
                value={evidenceRef}
                onChange={(e) => setEvidenceRef(e.target.value)}
                placeholder="form-2026-01-15-a7c4"
                maxLength={512}
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="notes" hint="up to 4096 characters (optional)">
              <TArea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Context the auditor will want to see later."
                rows={2}
                maxLength={4096}
              />
            </Field>
          </div>
          {formError ? (
            <div className="sm:col-span-2">
              <ErrorBox message={formError} />
            </div>
          ) : null}
          <div className="sm:col-span-2 flex justify-end">
            <Button type="submit" disabled={submitting}>
              {submitting ? "recording..." : "record consent"}
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <div className="px-5 pt-5 pb-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="inline-flex items-center gap-2 text-sm font-medium">
            <User weight="duotone" size={16} />
            register
            {data ? (
              <span className="text-[11px] text-[var(--color-muted)] font-normal">
                {data.active_count} active · {data.active_subjects} subjects ·{" "}
                {data.active_purposes.length} purposes ·{" "}
                {data.withdrawn_count} withdrawn
              </span>
            ) : null}
          </div>
          <label className="inline-flex items-center gap-2 text-[11px] text-[var(--color-muted)] cursor-pointer">
            <input
              type="checkbox"
              checked={includeWithdrawn}
              onChange={(e) => setIncludeWithdrawn(e.target.checked)}
            />
            show withdrawn
          </label>
        </div>

        <div className="px-5 pb-3 grid gap-3 sm:grid-cols-2">
          <Field label="filter by subject">
            <Input
              value={filterSubject}
              onChange={(e) => setFilterSubject(e.target.value)}
              placeholder="patient:000123"
              maxLength={256}
            />
          </Field>
          <Field label="filter by purpose">
            <Input
              value={filterPurpose}
              onChange={(e) => setFilterPurpose(e.target.value)}
              placeholder="research.secondary_use"
              maxLength={96}
            />
          </Field>
        </div>

        {isLoading ? (
          <div className="px-5 pb-5 space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : error ? (
          <div className="px-5 pb-5">
            <ErrorBox
              message={
                error instanceof Error ? error.message : "failed to load"
              }
            />
          </div>
        ) : entries.length === 0 ? (
          <div className="px-5 pb-5">
            <Empty
              icon={<ShieldCheck weight="duotone" size={28} />}
              title="no consent receipts recorded"
              hint="Record a consent above. Subject references are hashed before storage so the register is safe to share with auditors."
            />
          </div>
        ) : (
          <ul className="border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]">
            {entries.map((c) => (
              <li
                key={c.id}
                className="px-5 py-4 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium truncate">
                      {c.subject_ref}
                    </span>
                    <Badge tone="neutral">{c.purpose}</Badge>
                    <Badge tone={basisTone(c.lawful_basis)}>
                      {c.lawful_basis}
                    </Badge>
                    <Badge tone="neutral">{c.capture_channel}</Badge>
                    {c.active ? (
                      <Badge tone="success">active</Badge>
                    ) : (
                      <Badge tone="danger">withdrawn</Badge>
                    )}
                  </div>
                  <div className="mt-1 text-[12px] text-[var(--color-muted)]">
                    granted {fmtTime(c.granted_at)} by {c.granted_by} · v
                    {c.version}
                    {c.evidence_ref ? ` · evidence ${c.evidence_ref}` : ""}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--color-muted)] font-mono break-all">
                    hash {c.subject_hash.slice(0, 16)}...
                  </div>
                  {c.notes ? (
                    <div className="mt-1 text-[12px] whitespace-pre-wrap">
                      {c.notes}
                    </div>
                  ) : null}
                  {c.withdrawn_at ? (
                    <div className="mt-1 text-[11px] text-[var(--color-muted)]">
                      withdrawn {fmtTime(c.withdrawn_at)} by {c.withdrawn_by}
                      {c.withdrawal_reason
                        ? ` (${c.withdrawal_reason})`
                        : ""}
                    </div>
                  ) : null}
                </div>
                {c.active ? (
                  <Button
                    onClick={() => onWithdraw(c.id)}
                    disabled={withdrawingId === c.id}
                    variant="ghost"
                  >
                    <Prohibit weight="duotone" size={14} />
                    {withdrawingId === c.id ? "withdrawing..." : "withdraw"}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
