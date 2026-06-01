"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  DownloadSimple,
  FileMagnifyingGlass,
  Plus,
  ShieldCheck,
  UserCircle,
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

type Purpose =
  | "public_health"
  | "victim_of_abuse"
  | "health_oversight"
  | "judicial"
  | "law_enforcement"
  | "decedent"
  | "organ_donation"
  | "research"
  | "serious_threat"
  | "workers_comp"
  | "business_associate"
  | "other";

const PURPOSES: Purpose[] = [
  "public_health",
  "victim_of_abuse",
  "health_oversight",
  "judicial",
  "law_enforcement",
  "decedent",
  "organ_donation",
  "research",
  "serious_threat",
  "workers_comp",
  "business_associate",
  "other",
];

type Entry = {
  id: number;
  tenant_id: string;
  subject_id: string;
  recipient_name: string;
  recipient_org: string | null;
  purpose: Purpose;
  phi_description: string;
  legal_basis: string | null;
  requested_by: string;
  disclosed_at: string;
  notes: string | null;
  corrects_entry_id: number | null;
  created_by: string;
  created_at: string;
  retain_until: string;
};

type ListResp = {
  tenant_id: string;
  count: number;
  entries: Entry[];
};

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
  if (!iso) return "never";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z";
  } catch {
    return iso;
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return "never";
  try {
    return new Date(iso).toISOString().slice(0, 10);
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

export default function DisclosuresClient() {
  const [subjectFilter, setSubjectFilter] = useState("");
  const [purposeFilter, setPurposeFilter] = useState<"" | Purpose>("");

  const qs = new URLSearchParams();
  if (subjectFilter.trim()) qs.set("subject_id", subjectFilter.trim());
  if (purposeFilter) qs.set("purpose", purposeFilter);
  qs.set("limit", "200");

  const { data, error, isLoading, mutate } = useSWR<ListResp>(
    `/api/disclosures?${qs.toString()}`,
    fetcher,
  );

  const [subjectId, setSubjectId] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientOrg, setRecipientOrg] = useState("");
  const [purpose, setPurpose] = useState<Purpose>("public_health");
  const [phi, setPhi] = useState("");
  const [legalBasis, setLegalBasis] = useState("45 CFR 164.512(b)");
  const [requestedBy, setRequestedBy] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      setSubmitting(true);
      try {
        const r = await fetch("/api/disclosures", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            subject_id: subjectId.trim(),
            recipient_name: recipientName.trim(),
            recipient_org: recipientOrg.trim() || null,
            purpose,
            phi_description: phi.trim(),
            legal_basis: legalBasis.trim() || null,
            requested_by: requestedBy.trim(),
            notes: notes.trim() || null,
          }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            typeof body?.detail === "string"
              ? body.detail
              : `record failed (${r.status})`,
          );
        }
        setSubjectId("");
        setRecipientName("");
        setRecipientOrg("");
        setPhi("");
        setRequestedBy("");
        setNotes("");
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "record failed");
      } finally {
        setSubmitting(false);
      }
    },
    [
      subjectId,
      recipientName,
      recipientOrg,
      purpose,
      phi,
      legalBasis,
      requestedBy,
      notes,
      mutate,
    ],
  );

  const entries = data?.entries ?? [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 hover:text-[var(--color-fg)]"
        >
          <ArrowLeft size={14} weight="duotone" />
          settings
        </Link>
        <span>/</span>
        <span className="text-[var(--color-fg)]">disclosures</span>
      </div>

      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck size={22} weight="duotone" />
          <h1 className="text-xl font-semibold tracking-tight">
            HIPAA accounting of disclosures
          </h1>
        </div>
        <p className="max-w-3xl text-sm text-[var(--color-muted)]">
          Record PHI disclosures to external recipients (public health,
          oversight, judicial, law enforcement, research, business
          associates, and others). Entries are append-only: corrections
          create a new entry that references the prior id. Use the per
          subject accounting to satisfy a patient request under 45 CFR
          164.528.
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <a
            href="/api/disclosures/export.csv"
            className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs hover:bg-[var(--color-elev)]"
          >
            <DownloadSimple size={14} weight="duotone" />
            export csv
          </a>
          {data ? (
            <Badge tone="neutral">{data.count} entries</Badge>
          ) : null}
        </div>
      </header>

      <Card>
        <CardHeader
          title="record a disclosure"
          hint="every field below is captured on the audit row and on the patient accounting"
          right={<Plus size={16} weight="duotone" />}
        />
        <form
          onSubmit={onSubmit}
          className="grid gap-4 px-4 pb-4 sm:grid-cols-2"
        >
          <Field label="subject id" hint="patient identifier or pseudonym">
            <Input
              required
              value={subjectId}
              onChange={(e) => setSubjectId(e.target.value)}
              placeholder="patient-1042"
              maxLength={128}
            />
          </Field>
          <Field label="recipient name">
            <Input
              required
              value={recipientName}
              onChange={(e) => setRecipientName(e.target.value)}
              placeholder="Dr. J. Park / CDC FETP"
              maxLength={256}
            />
          </Field>
          <Field label="recipient organization" hint="optional">
            <Input
              value={recipientOrg}
              onChange={(e) => setRecipientOrg(e.target.value)}
              placeholder="State Department of Public Health"
              maxLength={256}
            />
          </Field>
          <Field label="purpose category">
            <Select
              value={purpose}
              onChange={(e) => setPurpose(e.target.value as Purpose)}
            >
              {PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {p.replaceAll("_", " ")}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="phi disclosed"
            hint="describe the records, do not paste raw PHI"
          >
            <TArea
              required
              value={phi}
              onChange={(e) => setPhi(e.target.value)}
              placeholder="lab result for reportable condition (no raw identifiers)"
              maxLength={4096}
              rows={2}
            />
          </Field>
          <Field label="legal basis" hint="citation or contract reference">
            <Input
              value={legalBasis}
              onChange={(e) => setLegalBasis(e.target.value)}
              placeholder="45 CFR 164.512(b)"
              maxLength={256}
            />
          </Field>
          <Field label="requested by" hint="internal owner / authorizer">
            <Input
              required
              value={requestedBy}
              onChange={(e) => setRequestedBy(e.target.value)}
              placeholder="compliance@acme"
              maxLength={128}
            />
          </Field>
          <Field label="notes" hint="optional">
            <TArea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="case number, ticket id, court order id"
              maxLength={4096}
              rows={2}
            />
          </Field>
          <div className="sm:col-span-2 flex flex-wrap items-center gap-3 pt-1">
            <Button type="submit" disabled={submitting}>
              {submitting ? "recording..." : "record disclosure"}
            </Button>
            {formError ? <ErrorBox message={formError} /> : null}
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader
          title="register"
          hint="filter by subject or purpose; entries are immutable"
          right={<FileMagnifyingGlass size={16} weight="duotone" />}
        />
        <div className="grid gap-3 px-4 pb-3 sm:grid-cols-[1fr_220px]">
          <Field label="subject id filter">
            <Input
              value={subjectFilter}
              onChange={(e) => setSubjectFilter(e.target.value)}
              placeholder="patient-1042"
              maxLength={128}
            />
          </Field>
          <Field label="purpose filter">
            <Select
              value={purposeFilter}
              onChange={(e) =>
                setPurposeFilter(e.target.value as "" | Purpose)
              }
            >
              <option value="">any</option>
              {PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {p.replaceAll("_", " ")}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="px-4 pb-4">
          {error ? (
            <ErrorBox
              message={
                error instanceof Error ? error.message : "failed to load"
              }
            />
          ) : isLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : entries.length === 0 ? (
            <Empty
              icon={<UserCircle size={22} weight="duotone" />}
              title="no disclosures recorded"
              hint="Record an external disclosure above. The accounting under 45 CFR 164.528 is built from these rows."
            />
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--color-border)]">
              {entries.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-col gap-1 py-3 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-6"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-[var(--color-muted)]">
                        #{e.id}
                      </span>
                      <Badge tone="neutral">
                        {e.purpose.replaceAll("_", " ")}
                      </Badge>
                      {e.corrects_entry_id ? (
                        <Badge tone="warn">
                          correction of #{e.corrects_entry_id}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="truncate">
                      <span className="font-medium">{e.subject_id}</span>
                      <span className="text-[var(--color-muted)]"> to </span>
                      <span className="font-medium">{e.recipient_name}</span>
                      {e.recipient_org ? (
                        <span className="text-[var(--color-muted)]">
                          {" "}
                          ({e.recipient_org})
                        </span>
                      ) : null}
                    </div>
                    <div className="text-xs text-[var(--color-muted)]">
                      {e.phi_description}
                    </div>
                    {e.legal_basis ? (
                      <div className="text-[11px] font-mono text-[var(--color-muted)]">
                        basis: {e.legal_basis}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-start gap-0.5 text-[11px] text-[var(--color-muted)] sm:items-end">
                    <span>disclosed {fmtTime(e.disclosed_at)}</span>
                    <span>by {e.requested_by}</span>
                    <span>retain until {fmtDate(e.retain_until)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}
