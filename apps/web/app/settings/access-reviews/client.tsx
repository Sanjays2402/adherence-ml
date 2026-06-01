"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle,
  Eye,
  PencilLine,
  PlusCircle,
  ShieldCheck,
  ShieldWarning,
  Trash,
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
  Stat,
} from "@/components/ui/primitives";

type ReviewState = "open" | "closed" | "cancelled";
type Decision = "keep" | "change" | "revoke";

type Review = {
  id: number;
  tenant_id: string;
  label: string | null;
  reason: string;
  opened_by: string;
  opened_at: string;
  closed_by: string | null;
  closed_at: string | null;
  close_summary: string | null;
  state: ReviewState;
  item_count: number;
  decided_count: number;
  pending_count: number;
};

type Item = {
  id: number;
  review_id: number;
  tenant_id: string;
  subject: string;
  current_role: string;
  decision: Decision | null;
  new_role: string | null;
  note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  state: "pending" | "decided" | "applied";
  applied: boolean;
};

type ReviewListResp = { tenant_id: string; reviews: Review[] };
type ItemListResp = { tenant_id: string; review_id: number; items: Item[] };

type Tone = "accent" | "danger" | "warn" | "success" | "neutral";

const ROLES = ["owner", "editor", "viewer"];

const fetcher = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(
      typeof body?.detail === "string"
        ? body.detail
        : `request failed (${r.status})`,
    );
  }
  return body as T;
};

function fmtTime(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z";
  } catch {
    return iso;
  }
}

function stateTone(state: ReviewState): Tone {
  if (state === "open") return "warn";
  if (state === "closed") return "success";
  return "neutral";
}

function decisionTone(d: Decision | null): Tone {
  if (d === "keep") return "success";
  if (d === "change") return "warn";
  if (d === "revoke") return "danger";
  return "neutral";
}

export default function AccessReviewsClient() {
  const { data, error, isLoading, mutate } = useSWR<ReviewListResp>(
    "/api/access-reviews?limit=200",
    fetcher,
  );

  const [openForm, setOpenForm] = useState(false);
  const [reason, setReason] = useState("");
  const [label, setLabel] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const reviews = data?.reviews ?? [];
  const stats = useMemo(() => {
    const open = reviews.filter((r) => r.state === "open").length;
    const closed = reviews.filter((r) => r.state === "closed").length;
    const pending = reviews.reduce((s, r) => s + r.pending_count, 0);
    return { open, closed, pending, total: reviews.length };
  }, [reviews]);

  const onOpenReview = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      if (reason.trim().length < 10) {
        setFormError("Reason must be at least 10 characters.");
        return;
      }
      if (!mfaCode.trim()) {
        setFormError("Enter your admin TOTP code.");
        return;
      }
      setSubmitting(true);
      try {
        const r = await fetch("/api/access-reviews", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-mfa-code": mfaCode.trim(),
          },
          body: JSON.stringify({
            reason: reason.trim(),
            label: label.trim() || null,
          }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(
            typeof body?.detail === "string"
              ? body.detail
              : `request failed (${r.status})`,
          );
        }
        setReason("");
        setLabel("");
        setMfaCode("");
        setOpenForm(false);
        setToast(`Opened review with ${body.item_count ?? 0} members.`);
        setSelectedId(body.id ?? null);
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "Failed to open.");
      } finally {
        setSubmitting(false);
      }
    },
    [reason, label, mfaCode, mutate],
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="mb-6">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          <ArrowLeft size={14} weight="duotone" aria-hidden />
          back to settings
        </Link>
      </div>

      <header className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Access reviews</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)] max-w-2xl">
            Periodically re-certify who has access to this workspace.
            Required by SOC2 CC6.3 and ISO 27001 A.9.2.5. Opening a review
            snapshots every current member as a pending item. Closing
            applies every change and writes an admin audit row for each one.
          </p>
        </div>
        <div className="shrink-0">
          <Button
            variant="primary"
            onClick={() => { setOpenForm((v) => !v); setFormError(null); }}
            aria-expanded={openForm}
          >
            <PlusCircle size={14} weight="duotone" aria-hidden />
            {openForm ? "Cancel" : "Open review"}
          </Button>
        </div>
      </header>

      {toast ? (
        <div role="status" className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm flex items-center gap-2">
          <CheckCircle size={14} weight="duotone" aria-hidden />
          {toast}
          <button onClick={() => setToast(null)} className="ml-auto text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]" aria-label="Dismiss">dismiss</button>
        </div>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Open" value={isLoading ? "..." : String(stats.open)} />
        <Stat label="Closed" value={isLoading ? "..." : String(stats.closed)} />
        <Stat label="Pending items" value={isLoading ? "..." : String(stats.pending)} />
        <Stat label="Total reviews" value={isLoading ? "..." : String(stats.total)} />
      </div>

      {openForm ? (
        <Card className="mb-6">
          <CardHeader title="Open a new review" />
          <form onSubmit={onOpenReview} className="p-4 grid gap-3">
            <label className="grid gap-1 text-sm">
              <span className="text-[var(--color-muted)]">Reason (10 to 4096 chars)</span>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Quarterly Q2 access review for SOC2 evidence." required minLength={10} maxLength={4096} />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-[var(--color-muted)]">Label (optional)</span>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="2026-Q2" maxLength={128} />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-[var(--color-muted)]">Admin TOTP code</span>
              <Input value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ""))} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,8}" required />
            </label>
            {formError ? <ErrorBox message={formError} /> : null}
            <div className="flex items-center gap-2">
              <Button type="submit" variant="primary" disabled={submitting}>
                {submitting ? "Opening..." : "Snapshot members and open"}
              </Button>
              <span className="text-xs text-[var(--color-muted)]">A pending item is created for every current member.</span>
            </div>
          </form>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Reviews" hint={isLoading ? "loading" : `${reviews.length} review${reviews.length === 1 ? "" : "s"}`} />
        <div className="p-4">
          {error ? (
            <ErrorBox message={error instanceof Error ? error.message : "Failed to load reviews."} />
          ) : isLoading ? (
            <div className="grid gap-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
          ) : reviews.length === 0 ? (
            <Empty title="No reviews yet" hint="Open one to snapshot members. SOC2 expects this at least quarterly." />
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {reviews.map((r) => (
                <li key={r.id} className="py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge tone={stateTone(r.state)}>
                        {r.state === "open" ? <ShieldWarning size={11} weight="duotone" aria-hidden /> : <ShieldCheck size={11} weight="duotone" aria-hidden />}
                        {r.state}
                      </Badge>
                      <span className="text-sm font-medium truncate">#{r.id}{r.label ? ` // ${r.label}` : ""}</span>
                      <span className="text-xs text-[var(--color-muted)] tabular-nums">{fmtTime(r.opened_at)}</span>
                    </div>
                    <div className="mt-1 text-xs text-[var(--color-muted)] line-clamp-2">{r.reason}</div>
                    <div className="mt-1 text-xs text-[var(--color-muted)] tabular-nums">
                      opened by <span className="font-mono">{r.opened_by}</span>{" // "}{r.item_count} items // {r.decided_count} decided // {r.pending_count} pending
                    </div>
                  </div>
                  <div className="shrink-0">
                    <Button variant={selectedId === r.id ? "primary" : "ghost"} onClick={() => setSelectedId((v) => (v === r.id ? null : r.id))} aria-expanded={selectedId === r.id} aria-controls={`review-${r.id}-items`}>
                      <Eye size={14} weight="duotone" aria-hidden />
                      {selectedId === r.id ? "Hide" : "Review"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {selectedId !== null ? (
        <div id={`review-${selectedId}-items`} className="mt-6">
          <ReviewDetail reviewId={selectedId} onChanged={() => mutate()} onClosed={() => { setSelectedId(null); mutate(); }} />
        </div>
      ) : null}
    </div>
  );
}

function ReviewDetail({
  reviewId,
  onChanged,
  onClosed,
}: {
  reviewId: number;
  onChanged: () => void;
  onClosed: () => void;
}) {
  const { data, error, isLoading, mutate } = useSWR<ItemListResp>(
    `/api/access-reviews/${reviewId}/items`,
    fetcher,
  );
  const { data: review } = useSWR<Review>(
    `/api/access-reviews/${reviewId}`,
    fetcher,
  );

  const [mfa, setMfa] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [closeSummary, setCloseSummary] = useState("");
  const [closing, setClosing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingRoles, setPendingRoles] = useState<Record<number, string>>({});
  const [pendingNotes, setPendingNotes] = useState<Record<number, string>>({});

  const items = data?.items ?? [];
  const isOpen = review?.state === "open";

  const decide = useCallback(
    async (itemId: number, decision: Decision) => {
      setActionError(null);
      if (!mfa.trim()) { setActionError("Enter your admin TOTP code at the bottom first."); return; }
      const new_role = decision === "change" ? pendingRoles[itemId] : null;
      if (decision === "change" && !new_role) { setActionError("Pick a new role for the change decision."); return; }
      setBusy(itemId);
      try {
        const r = await fetch(`/api/access-reviews/${reviewId}/items/${itemId}/decide`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-mfa-code": mfa.trim() },
          body: JSON.stringify({ decision, new_role, note: (pendingNotes[itemId] || "").trim() || null }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof body?.detail === "string" ? body.detail : `request failed (${r.status})`);
        await mutate();
        onChanged();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to record decision.");
      } finally {
        setBusy(null);
      }
    },
    [mfa, mutate, onChanged, pendingNotes, pendingRoles, reviewId],
  );

  const closeReview = useCallback(async () => {
    setActionError(null);
    if (!mfa.trim()) { setActionError("Enter your admin TOTP code first."); return; }
    const pending = items.filter((i) => i.state !== "decided");
    if (pending.length > 0) {
      const ok = window.confirm(`${pending.length} item${pending.length === 1 ? " is" : "s are"} still pending and will be treated as keep. Close anyway?`);
      if (!ok) return;
    }
    setClosing(true);
    try {
      const r = await fetch(`/api/access-reviews/${reviewId}/close`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mfa-code": mfa.trim() },
        body: JSON.stringify({ summary: closeSummary.trim() || null }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof body?.detail === "string" ? body.detail : `request failed (${r.status})`);
      onClosed();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to close review.");
    } finally {
      setClosing(false);
    }
  }, [closeSummary, items, mfa, onClosed, reviewId]);

  const cancelReview = useCallback(async () => {
    setActionError(null);
    if (!mfa.trim()) { setActionError("Enter your admin TOTP code first."); return; }
    const ok = window.confirm("Cancel this review without applying changes?");
    if (!ok) return;
    setClosing(true);
    try {
      const r = await fetch(`/api/access-reviews/${reviewId}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mfa-code": mfa.trim() },
        body: JSON.stringify({ reason: closeSummary.trim() || null }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof body?.detail === "string" ? body.detail : `request failed (${r.status})`);
      onClosed();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to cancel review.");
    } finally {
      setClosing(false);
    }
  }, [closeSummary, mfa, onClosed, reviewId]);

  return (
    <Card>
      <CardHeader title={`Review #${reviewId}`} hint={review ? `${review.decided_count} of ${review.item_count} decided` : "loading"} />
      <div className="p-4">
        {error ? (
          <ErrorBox message={error instanceof Error ? error.message : "Load failed."} />
        ) : isLoading ? (
          <div className="grid gap-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
        ) : items.length === 0 ? (
          <Empty title="No items" hint="Workspace had no members when this review was opened." />
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {items.map((it) => (
              <li key={it.id} className="py-3 flex flex-col gap-2 lg:flex-row lg:items-start lg:gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <UserCircle size={14} weight="duotone" aria-hidden />
                    <span className="text-sm font-medium truncate">{it.subject}</span>
                    <Badge tone="neutral">current: {it.current_role}</Badge>
                    {it.decision ? (
                      <Badge tone={decisionTone(it.decision)}>
                        {it.decision === "keep" ? <CheckCircle size={11} weight="duotone" aria-hidden /> : it.decision === "change" ? <PencilLine size={11} weight="duotone" aria-hidden /> : <Trash size={11} weight="duotone" aria-hidden />}
                        {it.decision}{it.new_role ? ` -> ${it.new_role}` : ""}
                      </Badge>
                    ) : (
                      <Badge tone="warn">pending</Badge>
                    )}
                    {it.applied ? <Badge tone="success">applied</Badge> : null}
                  </div>
                  {it.decided_by ? (
                    <div className="mt-1 text-xs text-[var(--color-muted)] tabular-nums">
                      decided by <span className="font-mono">{it.decided_by}</span>{" // "}{fmtTime(it.decided_at)}
                    </div>
                  ) : null}
                  {it.note ? (
                    <div className="mt-1 text-xs text-[var(--color-muted)] line-clamp-2">note: {it.note}</div>
                  ) : null}
                  {isOpen && !it.applied ? (
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Select aria-label={`New role for ${it.subject}`} value={pendingRoles[it.id] || ""} onChange={(e) => setPendingRoles((r) => ({ ...r, [it.id]: e.target.value }))}>
                        <option value="">change to...</option>
                        {ROLES.filter((r) => r !== it.current_role).map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </Select>
                      <Input aria-label={`Note for ${it.subject}`} value={pendingNotes[it.id] || ""} onChange={(e) => setPendingNotes((n) => ({ ...n, [it.id]: e.target.value }))} placeholder="Note (optional)" maxLength={4096} />
                    </div>
                  ) : null}
                </div>
                {isOpen && !it.applied ? (
                  <div className="shrink-0 flex items-center gap-2 flex-wrap">
                    <Button variant="ghost" onClick={() => decide(it.id, "keep")} disabled={busy === it.id} aria-label={`Keep ${it.subject}`}>
                      <CheckCircle size={14} weight="duotone" aria-hidden />Keep
                    </Button>
                    <Button variant="ghost" onClick={() => decide(it.id, "change")} disabled={busy === it.id} aria-label={`Change role for ${it.subject}`}>
                      <PencilLine size={14} weight="duotone" aria-hidden />Change
                    </Button>
                    <Button variant="ghost" onClick={() => decide(it.id, "revoke")} disabled={busy === it.id} aria-label={`Revoke ${it.subject}`}>
                      <Trash size={14} weight="duotone" aria-hidden />Revoke
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {isOpen ? (
          <div className="mt-6 grid gap-3 border-t border-[var(--color-border)] pt-4">
            <label className="grid gap-1 text-sm">
              <span className="text-[var(--color-muted)]">Admin TOTP code (required for every decision and close)</span>
              <Input value={mfa} onChange={(e) => setMfa(e.target.value.replace(/\D/g, ""))} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,8}" />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-[var(--color-muted)]">Close summary (optional, also used as cancel reason)</span>
              <Input value={closeSummary} onChange={(e) => setCloseSummary(e.target.value)} placeholder="Q2 review complete; 2 revocations, 1 demotion." maxLength={4096} />
            </label>
            {actionError ? <ErrorBox message={actionError} /> : null}
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="primary" onClick={closeReview} disabled={closing}>
                <CheckCircle size={14} weight="duotone" aria-hidden />
                {closing ? "Closing..." : "Close and apply"}
              </Button>
              <Button variant="ghost" onClick={cancelReview} disabled={closing}>
                <Trash size={14} weight="duotone" aria-hidden />Cancel review
              </Button>
              <span className="text-xs text-[var(--color-muted)]">Close writes one admin audit row per applied change.</span>
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
