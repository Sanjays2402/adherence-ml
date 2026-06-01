"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  Scales,
  ClockCountdown,
  CheckCircle,
  EnvelopeOpen,
  IdentificationCard,
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
  Stat,
} from "@/components/ui/primitives";

type RequestType =
  | "access"
  | "erasure"
  | "rectification"
  | "restriction"
  | "portability"
  | "objection"
  | "opt_out_sale";

type Status =
  | "received"
  | "in_progress"
  | "fulfilled"
  | "rejected"
  | "withdrawn";

type EventKind =
  | "ack_sent"
  | "identity_verified"
  | "extension"
  | "data_package_generated"
  | "rejection"
  | "regulator_correspondence"
  | "note";

type Event = {
  id: number;
  request_id: number;
  kind: EventKind;
  author: string;
  note: string;
  created_at: string;
};

type DSAR = {
  id: number;
  tenant_id: string;
  request_type: RequestType;
  status: Status;
  subject_name: string;
  subject_email_hash: string;
  subject_email_redacted: string | null;
  has_raw_contact: boolean;
  description: string;
  external_ref: string | null;
  received_via: string | null;
  opened_by: string;
  received_at: string;
  acknowledged_at: string | null;
  identity_verified_at: string | null;
  response_deadline_at: string;
  closed_at: string | null;
  closed_by: string | null;
  resolution_note: string | null;
  events: Event[];
};

type ListResp = {
  tenant_id: string;
  summary: {
    open: number;
    past_deadline: number;
    due_soon: number;
    by_type: Record<string, number>;
  };
  entries: DSAR[];
};

const REQUEST_TYPES: RequestType[] = [
  "access",
  "erasure",
  "rectification",
  "restriction",
  "portability",
  "objection",
  "opt_out_sale",
];

const EVENT_KINDS: EventKind[] = [
  "ack_sent",
  "identity_verified",
  "extension",
  "data_package_generated",
  "rejection",
  "regulator_correspondence",
  "note",
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

function statusTone(s: Status) {
  switch (s) {
    case "fulfilled":
      return "success" as const;
    case "rejected":
    case "withdrawn":
      return "neutral" as const;
    case "in_progress":
      return "neutral" as const;
    default:
      return "warn" as const;
  }
}

function countdown(deadline: string | null, closed: string | null): string {
  if (!deadline) return "n/a";
  if (closed) return "closed";
  const ms = new Date(deadline).getTime() - Date.now();
  if (Number.isNaN(ms)) return "n/a";
  if (ms <= 0) {
    const overdueDays = Math.ceil(-ms / 86_400_000);
    return `overdue by ${overdueDays}d`;
  }
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  return `${days}d ${hours}h left`;
}

function deadlineTone(
  deadline: string,
  closed: string | null,
): "danger" | "warn" | "neutral" {
  if (closed) return "neutral";
  const ms = new Date(deadline).getTime() - Date.now();
  if (ms <= 0) return "danger";
  if (ms <= 7 * 86_400_000) return "warn";
  return "neutral";
}

export default function DSARClient() {
  const { data, error, isLoading, mutate } = useSWR<ListResp>(
    "/api/dsar",
    fetcher,
  );

  const [requestType, setRequestType] = useState<RequestType>("access");
  const [subjectName, setSubjectName] = useState("");
  const [subjectEmail, setSubjectEmail] = useState("");
  const [description, setDescription] = useState("");
  const [receivedVia, setReceivedVia] = useState("");
  const [storeRaw, setStoreRaw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<number | null>(null);
  const [eventDraft, setEventDraft] = useState<
    Record<number, { kind: EventKind; note: string }>
  >({});
  const [closeDraft, setCloseDraft] = useState<
    Record<number, { status: "fulfilled" | "rejected" | "withdrawn"; note: string }>
  >({});

  const onOpen = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      if (subjectName.trim().length < 3) {
        setFormError("subject name must be at least 3 characters");
        return;
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(subjectEmail.trim())) {
        setFormError("subject email is not a valid address");
        return;
      }
      if (description.trim().length < 10) {
        setFormError("description must be at least 10 characters");
        return;
      }
      setSubmitting(true);
      try {
        const payload: Record<string, unknown> = {
          request_type: requestType,
          subject_name: subjectName.trim(),
          subject_email: subjectEmail.trim(),
          description: description.trim(),
          store_raw_contact: storeRaw,
        };
        if (receivedVia.trim()) payload.received_via = receivedVia.trim();
        const r = await fetch("/api/dsar", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            typeof body?.detail === "string"
              ? body.detail
              : `failed (${r.status})`,
          );
        }
        setSubjectName("");
        setSubjectEmail("");
        setDescription("");
        setReceivedVia("");
        setStoreRaw(false);
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed");
      } finally {
        setSubmitting(false);
      }
    },
    [
      requestType,
      subjectName,
      subjectEmail,
      description,
      receivedVia,
      storeRaw,
      mutate,
    ],
  );

  const onEvent = useCallback(
    async (id: number) => {
      const draft = eventDraft[id];
      if (!draft || !draft.note.trim()) return;
      setBusyId(id);
      try {
        const r = await fetch(`/api/dsar/${id}/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: draft.kind, note: draft.note.trim() }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            typeof body?.detail === "string"
              ? body.detail
              : `failed (${r.status})`,
          );
        }
        setEventDraft((prev) => ({
          ...prev,
          [id]: { kind: draft.kind, note: "" },
        }));
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed");
      } finally {
        setBusyId(null);
      }
    },
    [eventDraft, mutate],
  );

  const onClose = useCallback(
    async (id: number) => {
      const draft = closeDraft[id];
      if (!draft) return;
      setBusyId(id);
      try {
        const r = await fetch(`/api/dsar/${id}/close`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            status: draft.status,
            resolution_note: draft.note.trim() || null,
          }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            typeof body?.detail === "string"
              ? body.detail
              : `failed (${r.status})`,
          );
        }
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed");
      } finally {
        setBusyId(null);
      }
    },
    [closeDraft, mutate],
  );

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/settings"
            className="inline-flex items-center gap-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
          >
            <ArrowLeft weight="duotone" size={14} /> settings
          </Link>
          <h1 className="mt-2 text-xl font-semibold flex items-center gap-2">
            <Scales weight="duotone" size={22} />
            data subject access requests
          </h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Per-workspace register of GDPR Art. 15-22 and CCPA / CPRA
            requests. The statutory window is 30 days from receipt; the
            UI tracks the countdown and flags overdue items for the
            admin tile. Subject e-mails are stored as tenant-salted
            sha256 fingerprints by default; raw contact is opt-in and
            purged automatically on close.
          </p>
        </div>
      </header>

      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat
          label="open"
          value={isLoading ? "..." : String(data?.summary.open ?? 0)}
        />
        <Stat
          label="due within 7d"
          value={isLoading ? "..." : String(data?.summary.due_soon ?? 0)}
        />
        <Stat
          label="past deadline"
          value={isLoading ? "..." : String(data?.summary.past_deadline ?? 0)}
          sub={
            (data?.summary.past_deadline ?? 0) > 0
              ? "breach of Art. 12(3)"
              : "on schedule"
          }
        />
        <Stat
          label="total in register"
          value={isLoading ? "..." : String(data?.entries.length ?? 0)}
        />
      </section>

      <Card>
        <CardHeader
          title="log a new request"
          hint="Intake from email, portal form, regulator forward, or in-app message. Only the workspace this api key belongs to will see this entry."
        />
        <form
          onSubmit={onOpen}
          className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4"
        >
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[var(--color-muted)]">request type</span>
            <Select
              value={requestType}
              onChange={(e) =>
                setRequestType(e.target.value as RequestType)
              }
            >
              {REQUEST_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, " ")}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[var(--color-muted)]">received via</span>
            <Input
              placeholder="email, portal, post, regulator"
              maxLength={64}
              value={receivedVia}
              onChange={(e) => setReceivedVia(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[var(--color-muted)]">subject name</span>
            <Input
              placeholder="full legal name of the data subject"
              minLength={3}
              maxLength={256}
              value={subjectName}
              onChange={(e) => setSubjectName(e.target.value)}
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[var(--color-muted)]">
              subject email (hashed at rest)
            </span>
            <Input
              type="email"
              placeholder="alice@patient.example"
              maxLength={320}
              value={subjectEmail}
              onChange={(e) => setSubjectEmail(e.target.value)}
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-xs sm:col-span-2">
            <span className="text-[var(--color-muted)]">description</span>
            <textarea
              className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm font-mono"
              rows={3}
              minLength={10}
              maxLength={8192}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is the subject asking for, in their own words? Include any verification context (account id, regulator case number)."
              required
            />
          </label>
          <label className="flex items-center gap-2 text-xs sm:col-span-2">
            <input
              type="checkbox"
              checked={storeRaw}
              onChange={(e) => setStoreRaw(e.target.checked)}
            />
            <span>
              retain raw e-mail address (auto purged on close).
              Leave off to keep only the salted fingerprint.
            </span>
          </label>
          {formError ? (
            <div className="sm:col-span-2">
              <ErrorBox message={formError} />
            </div>
          ) : null}
          <div className="sm:col-span-2 flex items-center justify-end gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? "logging..." : "log request"}
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader
          title="register"
          hint="Append-only timeline per request with the GDPR 30 day countdown. Closing fulfilled, rejected, or withdrawn requests purges the raw contact and stamps the audit log."
        />
        <div className="p-4 space-y-3">
          {error ? (
            <ErrorBox
              message={
                error instanceof Error ? error.message : "failed to load"
              }
            />
          ) : null}
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : !data || data.entries.length === 0 ? (
            <Empty
              icon={<Scales weight="duotone" size={28} />}
              title="No requests yet"
              hint="Use the form above to log the first DSAR. Every workspace keeps its own register; nothing is shared across tenants."
            />
          ) : (
            <ul className="space-y-3">
              {data.entries.map((r) => (
                <li
                  key={r.id}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
                >
                  <div className="p-3 flex flex-wrap items-start gap-2 justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-sm truncate">
                          {r.subject_name}
                        </span>
                        <Badge tone="neutral">
                          {r.request_type.replace(/_/g, " ")}
                        </Badge>
                        <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                        <Badge tone={deadlineTone(r.response_deadline_at, r.closed_at)}>
                          {countdown(r.response_deadline_at, r.closed_at)}
                        </Badge>
                        {r.has_raw_contact ? (
                          <Badge tone="warn">raw contact retained</Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 text-[11px] text-[var(--color-muted)] font-mono break-all">
                        {r.subject_email_redacted ?? "***"} ·{" "}
                        {r.subject_email_hash.slice(0, 12)}... · received{" "}
                        {fmtTime(r.received_at)} by {r.opened_by}
                        {r.received_via ? ` via ${r.received_via}` : ""}
                      </div>
                      <p className="mt-2 text-xs whitespace-pre-wrap">
                        {r.description}
                      </p>
                    </div>
                  </div>

                  <div className="px-3 pb-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] text-[var(--color-muted)]">
                    <span className="flex items-center gap-1">
                      <EnvelopeOpen weight="duotone" size={12} /> ack:{" "}
                      {r.acknowledged_at ? fmtTime(r.acknowledged_at) : "pending"}
                    </span>
                    <span className="flex items-center gap-1">
                      <IdentificationCard weight="duotone" size={12} /> id verified:{" "}
                      {r.identity_verified_at
                        ? fmtTime(r.identity_verified_at)
                        : "pending"}
                    </span>
                    <span className="flex items-center gap-1">
                      <ClockCountdown weight="duotone" size={12} /> deadline:{" "}
                      {fmtTime(r.response_deadline_at)}
                    </span>
                    <span className="flex items-center gap-1">
                      <CheckCircle weight="duotone" size={12} /> closed:{" "}
                      {r.closed_at ? fmtTime(r.closed_at) : "—"}
                    </span>
                  </div>

                  {r.events.length > 0 ? (
                    <ol className="mx-3 mb-3 border-l border-[var(--color-border)] pl-3 space-y-1">
                      {r.events.map((e) => (
                        <li key={e.id} className="text-[11px]">
                          <span className="font-mono text-[var(--color-muted)]">
                            {fmtTime(e.created_at)}
                          </span>{" "}
                          <Badge tone="neutral">{e.kind.replace(/_/g, " ")}</Badge>{" "}
                          <span className="text-[var(--color-muted)]">{e.author}</span>{" "}
                          <span>{e.note}</span>
                        </li>
                      ))}
                    </ol>
                  ) : null}

                  {r.closed_at ? (
                    r.resolution_note ? (
                      <div className="mx-3 mb-3 text-[11px] text-[var(--color-muted)]">
                        resolution: {r.resolution_note}
                      </div>
                    ) : null
                  ) : (
                    <div className="border-t border-[var(--color-border)] p-3 grid grid-cols-1 sm:grid-cols-[150px_1fr_auto] gap-2">
                      <Select
                        aria-label="event kind"
                        value={eventDraft[r.id]?.kind ?? "ack_sent"}
                        onChange={(e) =>
                          setEventDraft((prev) => ({
                            ...prev,
                            [r.id]: {
                              kind: e.target.value as EventKind,
                              note: prev[r.id]?.note ?? "",
                            },
                          }))
                        }
                      >
                        {EVENT_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {k.replace(/_/g, " ")}
                          </option>
                        ))}
                      </Select>
                      <Input
                        placeholder="add a timeline note (extension: include +60d to push the deadline)"
                        maxLength={8192}
                        value={eventDraft[r.id]?.note ?? ""}
                        onChange={(e) =>
                          setEventDraft((prev) => ({
                            ...prev,
                            [r.id]: {
                              kind: prev[r.id]?.kind ?? "ack_sent",
                              note: e.target.value,
                            },
                          }))
                        }
                      />
                      <Button
                        type="button"
                        onClick={() => onEvent(r.id)}
                        disabled={
                          busyId === r.id ||
                          !(eventDraft[r.id]?.note?.trim())
                        }
                      >
                        log event
                      </Button>

                      <Select
                        aria-label="close status"
                        value={closeDraft[r.id]?.status ?? "fulfilled"}
                        onChange={(e) =>
                          setCloseDraft((prev) => ({
                            ...prev,
                            [r.id]: {
                              status: e.target.value as
                                | "fulfilled"
                                | "rejected"
                                | "withdrawn",
                              note: prev[r.id]?.note ?? "",
                            },
                          }))
                        }
                      >
                        <option value="fulfilled">fulfilled</option>
                        <option value="rejected">rejected</option>
                        <option value="withdrawn">withdrawn</option>
                      </Select>
                      <Input
                        placeholder="resolution note (kept in the register)"
                        maxLength={8192}
                        value={closeDraft[r.id]?.note ?? ""}
                        onChange={(e) =>
                          setCloseDraft((prev) => ({
                            ...prev,
                            [r.id]: {
                              status: prev[r.id]?.status ?? "fulfilled",
                              note: e.target.value,
                            },
                          }))
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => onClose(r.id)}
                        disabled={busyId === r.id}
                      >
                        close request
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </main>
  );
}
