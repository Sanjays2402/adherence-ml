"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  Archive,
  ArrowLeft,
  ClockCountdown,
  DownloadSimple,
  GitBranch,
  Plus,
  ShieldCheck,
  ShieldWarning,
  Stack,
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

type ChangeType = "standard" | "normal" | "emergency";
type RiskClass = "low" | "medium" | "high" | "critical";
type Status =
  | "planned"
  | "approved"
  | "in_progress"
  | "completed"
  | "rolled_back"
  | "cancelled";
type TargetStatus = Exclude<Status, "planned">;

type Entry = {
  id: number;
  reference: string | null;
  title: string;
  change_type: ChangeType;
  risk_class: RiskClass;
  affected_service: string;
  rollback_plan: string;
  notes: string | null;
  review_summary: string | null;
  requester_email: string;
  approver_email: string | null;
  status: Status;
  planned_start_at: string | null;
  planned_end_at: string | null;
  actual_start_at: string | null;
  actual_end_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  is_terminal: boolean;
  is_overdue: boolean;
  requires_approver: boolean;
  has_review: boolean;
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
  open_count: number;
  overdue_count: number;
  highest_open_risk: RiskClass;
  entries: Entry[];
};

const CHANGE_TYPES: ChangeType[] = ["standard", "normal", "emergency"];
const RISK_CLASSES: RiskClass[] = ["low", "medium", "high", "critical"];

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
  if (!iso) return "not set";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z";
  } catch {
    return iso;
  }
}

function riskTone(r: RiskClass): "success" | "warn" | "danger" | "neutral" {
  if (r === "critical" || r === "high") return "danger";
  if (r === "medium") return "warn";
  return "neutral";
}

function statusTone(s: Status): "success" | "warn" | "danger" | "neutral" {
  if (s === "completed") return "success";
  if (s === "rolled_back") return "danger";
  if (s === "in_progress") return "warn";
  return "neutral";
}

function statusLabel(s: Status): string {
  if (s === "in_progress") return "in progress";
  if (s === "rolled_back") return "rolled back";
  return s;
}

function nextTargets(s: Status): TargetStatus[] {
  if (s === "planned") return ["approved", "cancelled"];
  if (s === "approved") return ["in_progress", "cancelled"];
  if (s === "in_progress") return ["completed", "rolled_back"];
  return [];
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

function localToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export default function ChangesClient() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"" | Status>("");
  const params = new URLSearchParams({
    include_archived: String(includeArchived),
  });
  if (statusFilter) params.set("status", statusFilter);
  const { data, error, isLoading, mutate } = useSWR<ListResp>(
    `/api/changes?${params.toString()}`,
    fetcher,
  );

  const [title, setTitle] = useState("");
  const [changeType, setChangeType] = useState<ChangeType>("normal");
  const [riskClass, setRiskClass] = useState<RiskClass>("low");
  const [affectedService, setAffectedService] = useState("");
  const [rollbackPlan, setRollbackPlan] = useState("");
  const [requesterEmail, setRequesterEmail] = useState("");
  const [approverEmail, setApproverEmail] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [plannedStart, setPlannedStart] = useState("");
  const [plannedEnd, setPlannedEnd] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [transitioningId, setTransitioningId] = useState<number | null>(null);
  const [archivingId, setArchivingId] = useState<number | null>(null);
  const [tTarget, setTTarget] = useState<Record<number, TargetStatus>>({});
  const [tActor, setTActor] = useState<Record<number, string>>({});
  const [tReview, setTReview] = useState<Record<number, string>>({});

  const reset = () => {
    setTitle("");
    setChangeType("normal");
    setRiskClass("low");
    setAffectedService("");
    setRollbackPlan("");
    setRequesterEmail("");
    setApproverEmail("");
    setReference("");
    setNotes("");
    setPlannedStart("");
    setPlannedEnd("");
  };

  const onCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      if (title.trim().length < 4) {
        setFormError("title must be at least 4 characters");
        return;
      }
      if (affectedService.trim().length < 2) {
        setFormError("affected service must be at least 2 characters");
        return;
      }
      if (rollbackPlan.trim().length < 4) {
        setFormError("rollback plan must be at least 4 characters");
        return;
      }
      if (!requesterEmail.includes("@")) {
        setFormError("requester email must be valid");
        return;
      }
      const needsApprover =
        riskClass === "high" ||
        riskClass === "critical" ||
        changeType === "emergency";
      if (needsApprover && !approverEmail.includes("@")) {
        setFormError(
          "approver email is required for high or critical risk and for emergency changes",
        );
        return;
      }
      if (
        approverEmail &&
        approverEmail.trim().toLowerCase() ===
          requesterEmail.trim().toLowerCase()
      ) {
        setFormError(
          "approver email must differ from requester email (four-eyes control)",
        );
        return;
      }
      const startIso = localToIso(plannedStart);
      const endIso = localToIso(plannedEnd);
      if (startIso && endIso && new Date(endIso) <= new Date(startIso)) {
        setFormError("planned end must be after planned start");
        return;
      }
      setSubmitting(true);
      try {
        const r = await fetch("/api/changes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            change_type: changeType,
            risk_class: riskClass,
            affected_service: affectedService.trim(),
            rollback_plan: rollbackPlan.trim(),
            requester_email: requesterEmail.trim(),
            approver_email: approverEmail.trim() || null,
            reference: reference.trim() || null,
            notes: notes.trim() || null,
            planned_start_at: startIso,
            planned_end_at: endIso,
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
        setFormError(err instanceof Error ? err.message : "failed to file");
      } finally {
        setSubmitting(false);
      }
    },
    [
      title,
      changeType,
      riskClass,
      affectedService,
      rollbackPlan,
      requesterEmail,
      approverEmail,
      reference,
      notes,
      plannedStart,
      plannedEnd,
      mutate,
    ],
  );

  const onTransition = useCallback(
    async (entry: Entry) => {
      const target = tTarget[entry.id] ?? nextTargets(entry.status)[0];
      const actor = (tActor[entry.id] ?? "").trim();
      const review = (tReview[entry.id] ?? "").trim();
      if (!target) {
        setFormError("no transition available from this status");
        return;
      }
      if (!actor.includes("@")) {
        setFormError("actor email must be valid");
        return;
      }
      if (
        (target === "completed" || target === "rolled_back") &&
        review.length < 4
      ) {
        setFormError(
          "post implementation review is required to close a change",
        );
        return;
      }
      setTransitioningId(entry.id);
      try {
        const r = await fetch(`/api/changes/${entry.id}/transition`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            target_status: target,
            actor_email: actor,
            review_summary: review || null,
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
        setTReview((m) => ({ ...m, [entry.id]: "" }));
        await mutate();
      } catch (err) {
        setFormError(
          err instanceof Error ? err.message : "failed to transition",
        );
      } finally {
        setTransitioningId(null);
      }
    },
    [tTarget, tActor, tReview, mutate],
  );

  const onArchive = useCallback(
    async (id: number) => {
      setArchivingId(id);
      try {
        const r = await fetch(`/api/changes/${id}/archive`, {
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
              <GitBranch weight="duotone" size={26} />
              change management register
            </h1>
            <p className="text-sm text-[var(--color-muted)] mt-1 max-w-2xl">
              File each production change with risk class, rollback plan,
              named approver, planned and actual windows, and a post
              implementation review. SOC 2 CC8.1, ISO 27001 A.12.1.2 and
              A.14.2.2, NIST SP 800-53 CM-3, and any ITIL change advisory
              board reviewer expects this evidence in writing.
            </p>
          </div>
          <a
            href="/api/changes/export.csv"
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-2 text-xs hover:bg-[var(--color-bg-elevated)]"
          >
            <DownloadSimple weight="duotone" size={14} />
            download csv
          </a>
        </div>
      </div>

      {data && data.highest_open_risk !== "low" && data.open_count > 0 ? (
        <div
          className={
            "rounded-md border px-4 py-3 text-xs flex items-start gap-2 " +
            (data.highest_open_risk === "critical" ||
            data.highest_open_risk === "high"
              ? "border-rose-500/40 bg-rose-500/10"
              : "border-amber-500/40 bg-amber-500/10")
          }
        >
          <ShieldWarning
            weight="duotone"
            size={16}
            className={
              data.highest_open_risk === "critical" ||
              data.highest_open_risk === "high"
                ? "text-rose-400 mt-0.5"
                : "text-amber-400 mt-0.5"
            }
          />
          <div>
            <div className="font-medium">
              highest open risk: {data.highest_open_risk} {" · "}
              {data.open_count} open
            </div>
            <div className="text-[var(--color-muted)] mt-0.5">
              Approve, start, and close each open change. Procurement
              reviewers follow this trail end to end.
            </div>
          </div>
        </div>
      ) : null}

      {data && data.overdue_count > 0 ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs flex items-start gap-2">
          <Warning
            weight="duotone"
            size={16}
            className="text-amber-400 mt-0.5"
          />
          <div>
            <div className="font-medium">
              {data.overdue_count} change
              {data.overdue_count === 1 ? "" : "s"} past the planned window
            </div>
            <div className="text-[var(--color-muted)] mt-0.5">
              Close them out (completed, rolled back, or cancelled) so the
              register matches reality.
            </div>
          </div>
        </div>
      ) : null}

      <Card>
        <CardHeader
          title="file a change"
          right={<Plus weight="duotone" size={18} />}
        />
        <form
          onSubmit={onCreate}
          className="px-5 pb-5 grid gap-4 sm:grid-cols-2"
        >
          <Field label="title" hint="One line describing the change.">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Roll forecast worker to v3.4"
              maxLength={200}
              required
            />
          </Field>
          <Field label="reference" hint="Optional ticket id (CHG-1234).">
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="CHG-1234"
              maxLength={128}
            />
          </Field>
          <Field label="change type">
            <Select
              value={changeType}
              onChange={(e) => setChangeType(e.target.value as ChangeType)}
            >
              {CHANGE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="risk class">
            <Select
              value={riskClass}
              onChange={(e) => setRiskClass(e.target.value as RiskClass)}
            >
              {RISK_CLASSES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="affected service">
            <Input
              value={affectedService}
              onChange={(e) => setAffectedService(e.target.value)}
              placeholder="inference_worker"
              maxLength={128}
              required
            />
          </Field>
          <Field label="requester email" hint="Who is filing the change.">
            <Input
              type="email"
              value={requesterEmail}
              onChange={(e) => setRequesterEmail(e.target.value)}
              placeholder="alice@acme.example"
              maxLength={254}
              required
            />
          </Field>
          <Field
            label="approver email"
            hint="Required for high or critical risk and for emergency changes. Must differ from requester."
          >
            <Input
              type="email"
              value={approverEmail}
              onChange={(e) => setApproverEmail(e.target.value)}
              placeholder="bob@acme.example"
              maxLength={254}
            />
          </Field>
          <Field label="planned start" hint="Local time.">
            <Input
              type="datetime-local"
              value={plannedStart}
              onChange={(e) => setPlannedStart(e.target.value)}
            />
          </Field>
          <Field label="planned end">
            <Input
              type="datetime-local"
              value={plannedEnd}
              onChange={(e) => setPlannedEnd(e.target.value)}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field
              label="rollback plan"
              hint="Exactly how the change is undone if it fails. Required."
            >
              <TArea
                value={rollbackPlan}
                onChange={(e) => setRollbackPlan(e.target.value)}
                placeholder="Re-tag previous image and trigger blue-green rollback. Verify p95 on /v1/forecast for 10 minutes."
                rows={3}
                maxLength={4096}
                required
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="notes" hint="Optional context for reviewers.">
              <TArea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Feature flag stays off until smoke tests pass on staging."
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
          <div className="sm:col-span-2 flex items-center justify-end gap-3">
            <span className="text-[11px] text-[var(--color-muted)] inline-flex items-center gap-1">
              <ShieldCheck weight="duotone" size={12} />
              admin role and active MFA required
            </span>
            <Button type="submit" disabled={submitting}>
              {submitting ? "filing" : "file change"}
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader
          title="register"
          right={
            <div className="flex items-center gap-3">
              <Select
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as "" | Status)
                }
              >
                <option value="">all statuses</option>
                <option value="planned">planned</option>
                <option value="approved">approved</option>
                <option value="in_progress">in progress</option>
                <option value="completed">completed</option>
                <option value="rolled_back">rolled back</option>
                <option value="cancelled">cancelled</option>
              </Select>
              <label className="inline-flex items-center gap-2 text-xs text-[var(--color-muted)]">
                <input
                  type="checkbox"
                  checked={includeArchived}
                  onChange={(e) => setIncludeArchived(e.target.checked)}
                  className="accent-[var(--color-accent)]"
                />
                show archived
              </label>
            </div>
          }
        />
        <div className="px-5 pb-5 space-y-3">
          {error ? <ErrorBox message={error.message} /> : null}
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-28 w-full" />
            </div>
          ) : null}
          {!isLoading && data && data.entries.length === 0 ? (
            <Empty
              title="no change requests yet"
              hint="File one entry per production change so auditors can verify your approval, rollback, and review trail."
              icon={<Stack weight="duotone" size={28} />}
            />
          ) : null}
          {data?.entries.map((entry) => {
            const targets = nextTargets(entry.status);
            const defaultTarget = targets[0];
            const selectedTarget = tTarget[entry.id] ?? defaultTarget;
            const needsReview =
              selectedTarget === "completed" ||
              selectedTarget === "rolled_back";
            return (
              <div
                key={entry.id}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4 space-y-3"
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{entry.title}</span>
                      {entry.reference ? (
                        <Badge tone="neutral">{entry.reference}</Badge>
                      ) : null}
                      <Badge tone={statusTone(entry.status)}>
                        {statusLabel(entry.status)}
                      </Badge>
                      <Badge tone="neutral">{entry.change_type}</Badge>                      <Badge tone={riskTone(entry.risk_class)}>
                        risk: {entry.risk_class}
                      </Badge>
                      <Badge tone="neutral">v{entry.version}</Badge>
                      {!entry.active ? (
                        <Badge tone="neutral">archived</Badge>
                      ) : null}
                      {entry.is_overdue ? (
                        <Badge tone="danger">overdue</Badge>
                      ) : null}
                    </div>
                    <div className="text-xs text-[var(--color-muted)] mt-1 inline-flex items-center gap-1 flex-wrap">
                      <ClockCountdown weight="duotone" size={12} />
                      service {entry.affected_service} {" · "} requester{" "}
                      {entry.requester_email}
                      {entry.approver_email
                        ? ` · approver ${entry.approver_email}`
                        : ""}
                      {entry.approved_at
                        ? ` · approved by ${entry.approved_by} on ${fmtTime(entry.approved_at)}`
                        : ""}
                    </div>
                  </div>
                  {entry.active ? (
                    <Button
                      variant="ghost"
                      onClick={() => onArchive(entry.id)}
                      disabled={archivingId === entry.id}
                    >
                      <Archive weight="duotone" size={14} />
                      {archivingId === entry.id ? "archiving" : "archive"}
                    </Button>
                  ) : null}
                </div>

                <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-xs">
                  <div>
                    <dt className="font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                      planned start
                    </dt>
                    <dd className="mt-0.5">{fmtTime(entry.planned_start_at)}</dd>
                  </div>
                  <div>
                    <dt className="font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                      planned end
                    </dt>
                    <dd className="mt-0.5">{fmtTime(entry.planned_end_at)}</dd>
                  </div>
                  <div>
                    <dt className="font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                      actual start
                    </dt>
                    <dd className="mt-0.5">{fmtTime(entry.actual_start_at)}</dd>
                  </div>
                  <div>
                    <dt className="font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                      actual end
                    </dt>
                    <dd className="mt-0.5">{fmtTime(entry.actual_end_at)}</dd>
                  </div>
                </dl>

                <div className="text-xs">
                  <span className="font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                    rollback plan
                  </span>
                  <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">
                    {entry.rollback_plan}
                  </p>
                </div>

                {entry.notes ? (
                  <div className="text-xs">
                    <span className="font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                      notes
                    </span>
                    <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">
                      {entry.notes}
                    </p>
                  </div>
                ) : null}

                {entry.review_summary ? (
                  <div className="text-xs">
                    <span className="font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                      post implementation review
                    </span>
                    <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">
                      {entry.review_summary}
                    </p>
                  </div>
                ) : null}

                {entry.active && targets.length > 0 ? (
                  <div className="border-t border-[var(--color-border)] pt-3 grid gap-2 sm:grid-cols-[auto_auto_1fr_auto] sm:items-end">
                    <Field label="next status">
                      <Select
                        value={selectedTarget}
                        onChange={(ev) =>
                          setTTarget((m) => ({
                            ...m,
                            [entry.id]: ev.target.value as TargetStatus,
                          }))
                        }
                      >
                        {targets.map((t) => (
                          <option key={t} value={t}>
                            {statusLabel(t as Status)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="actor email">
                      <Input
                        type="email"
                        value={tActor[entry.id] ?? ""}
                        onChange={(ev) =>
                          setTActor((m) => ({
                            ...m,
                            [entry.id]: ev.target.value,
                          }))
                        }
                        placeholder={
                          selectedTarget === "approved" && entry.approver_email
                            ? entry.approver_email
                            : "you@workspace.example"
                        }
                        maxLength={254}
                      />
                    </Field>
                    {needsReview ? (
                      <Field
                        label="post implementation review"
                        hint="Required to close (completed or rolled back)."
                      >
                        <TArea
                          value={tReview[entry.id] ?? ""}
                          onChange={(ev) =>
                            setTReview((m) => ({
                              ...m,
                              [entry.id]: ev.target.value,
                            }))
                          }
                          placeholder="What shipped, what broke, what was watched, what next."
                          rows={2}
                          maxLength={4096}
                        />
                      </Field>
                    ) : (
                      <div className="text-[11px] text-[var(--color-muted)] hidden sm:block">
                        {selectedTarget === "approved"
                          ? "Only the named approver can mark approved."
                          : selectedTarget === "in_progress"
                            ? "Marks the start of the actual implementation window."
                            : "Cancellation requires no review."}
                      </div>
                    )}
                    <Button
                      variant="ghost"
                      onClick={() => onTransition(entry)}
                      disabled={transitioningId === entry.id}
                    >
                      {transitioningId === entry.id
                        ? "recording"
                        : `mark ${statusLabel(selectedTarget as Status)}`}
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
