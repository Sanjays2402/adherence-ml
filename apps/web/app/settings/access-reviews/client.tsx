"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Plus, ArrowsClockwise } from "@phosphor-icons/react/dist/ssr";

type AccessReview = {
  id: string;
  label: string | null;
  reason: string;
  status: "open" | "closed" | "cancelled";
  created_at: string;
  closed_at?: string | null;
  item_count?: number;
  decided_count?: number;
};

type ListResponse = {
  reviews: AccessReview[];
};

export default function AccessReviewsClient() {
  const [reviews, setReviews] = useState<AccessReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [label, setLabel] = useState("");
  const [mfa, setMfa] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/access-reviews", { cache: "no-store" });
      if (!res.ok) throw new Error(`upstream ${res.status}`);
      const data = (await res.json()) as ListResponse;
      setReviews(data.reviews ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
      setReviews([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/access-reviews", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(mfa ? { "x-mfa-code": mfa } : {}),
          },
          body: JSON.stringify({ reason, label: label || null }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.detail ?? `failed: ${res.status}`);
        }
        setReason("");
        setLabel("");
        setMfa("");
        setFormOpen(false);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed");
      } finally {
        setBusy(false);
      }
    },
    [busy, reason, label, mfa, load],
  );

  return (
    <div className="max-w-4xl mx-auto px-4 py-10 text-[var(--color-text)]">
      <header className="flex items-start justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <ShieldCheck
              size={18}
              weight="duotone"
              className="text-[var(--color-muted)]"
            />
            <h1 className="text-[15px] font-mono uppercase tracking-[0.14em]">
              access reviews
            </h1>
          </div>
          <p className="text-[12px] text-[var(--color-muted)] max-w-xl">
            Periodic SOC2 CC6.3 / ISO 27001 A.9.2.5 membership recertification.
            Snapshot every workspace member, decide keep, change, or revoke,
            then close the review to apply.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1.5 border border-[var(--color-border-strong)] rounded font-mono"
            aria-label="refresh"
          >
            <ArrowsClockwise size={12} weight="duotone" />
            refresh
          </button>
          <button
            type="button"
            onClick={() => setFormOpen((o) => !o)}
            className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1.5 border border-[var(--color-accent)]/60 bg-[var(--color-accent)]/10 rounded font-mono"
          >
            <Plus size={12} weight="duotone" />
            new review
          </button>
        </div>
      </header>

      {error ? (
        <div
          role="alert"
          className="mb-4 text-[12px] font-mono text-red-400 border border-red-500/30 bg-red-500/5 rounded px-3 py-2"
        >
          {error}
        </div>
      ) : null}

      {formOpen ? (
        <form
          onSubmit={create}
          className="mb-6 border border-[var(--color-border-strong)] rounded p-4 space-y-3"
        >
          <div>
            <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)] mb-1">
              reason
            </label>
            <textarea
              required
              minLength={10}
              maxLength={4096}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="w-full bg-transparent border border-[var(--color-border-strong)] rounded px-2 py-1.5 text-[12px] font-mono"
              placeholder="Q2 SOC2 CC6.3 access recertification..."
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)] mb-1">
                label (optional)
              </label>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={128}
                className="w-full bg-transparent border border-[var(--color-border-strong)] rounded px-2 py-1.5 text-[12px] font-mono"
                placeholder="2026-q2"
              />
            </div>
            <div>
              <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)] mb-1">
                admin TOTP
              </label>
              <input
                value={mfa}
                onChange={(e) => setMfa(e.target.value)}
                inputMode="numeric"
                maxLength={8}
                className="w-full bg-transparent border border-[var(--color-border-strong)] rounded px-2 py-1.5 text-[12px] font-mono"
                placeholder="123456"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={busy || reason.length < 10}
              className="text-[12px] px-3 py-1.5 border border-[var(--color-accent)]/60 bg-[var(--color-accent)]/10 rounded font-mono disabled:opacity-40"
            >
              {busy ? "opening..." : "open review"}
            </button>
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="text-[12px] px-3 py-1.5 border border-[var(--color-border-strong)] rounded font-mono"
            >
              cancel
            </button>
          </div>
        </form>
      ) : null}

      {loading ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-12 rounded border border-[var(--color-border-strong)] animate-pulse bg-[var(--color-border)]/30"
            />
          ))}
        </div>
      ) : reviews && reviews.length > 0 ? (
        <ul className="border border-[var(--color-border-strong)] rounded divide-y divide-[var(--color-border)]">
          {reviews.map((r) => (
            <li key={r.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-mono truncate">
                    {r.label ?? r.id}
                  </div>
                  <div className="text-[11px] text-[var(--color-muted)] mt-0.5 truncate">
                    {r.reason}
                  </div>
                </div>
                <span
                  className={`text-[10px] font-mono uppercase tracking-[0.14em] px-2 py-0.5 rounded border ${
                    r.status === "open"
                      ? "border-emerald-500/40 text-emerald-300"
                      : r.status === "closed"
                        ? "border-[var(--color-border-strong)] text-[var(--color-muted)]"
                        : "border-red-500/40 text-red-300"
                  }`}
                >
                  {r.status}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-[12px] font-mono text-[var(--color-muted)] border border-dashed border-[var(--color-border-strong)] rounded px-4 py-8 text-center">
          no access reviews yet. open one to snapshot current memberships.
        </div>
      )}
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
      if (!mfa.trim()) {
        setActionError("Enter your admin TOTP code at the bottom first.");
        return;
      }
      const new_role = decision === "change" ? pendingRoles[itemId] : null;
      if (decision === "change" && !new_role) {
        setActionError("Pick a new role for the change decision.");
        return;
      }
      setBusy(itemId);
      try {
        const r = await fetch(
          `/api/access-reviews/${reviewId}/items/${itemId}/decide`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-mfa-code": mfa.trim(),
            },
            body: JSON.stringify({
              decision,
              new_role,
              note: (pendingNotes[itemId] || "").trim() || null,
            }),
          },
        );
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(
            typeof body?.detail === "string"
              ? body.detail
              : `request failed (${r.status})`,
          );
        }
        await mutate();
        onChanged();
      } catch (err) {
        setActionError(
          err instanceof Error ? err.message : "Failed to record decision.",
        );
      } finally {
        setBusy(null);
      }
    },
    [mfa, mutate, onChanged, pendingNotes, pendingRoles, reviewId],
  );

  const closeReview = useCallback(async () => {
    setActionError(null);
    if (!mfa.trim()) {
      setActionError("Enter your admin TOTP code first.");
      return;
    }
    const pending = items.filter((i) => i.state !== "decided");
    if (pending.length > 0) {
      const ok = window.confirm(
        `${pending.length} item${pending.length === 1 ? " is" : "s are"} still pending and will be treated as keep. Close anyway?`,
      );
      if (!ok) return;
    }
    setClosing(true);
    try {
      const r = await fetch(`/api/access-reviews/${reviewId}/close`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mfa-code": mfa.trim(),
        },
        body: JSON.stringify({ summary: closeSummary.trim() || null }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(
          typeof body?.detail === "string"
            ? body.detail
            : `request failed (${r.status})`,
        );
      }
      onClosed();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to close review.",
      );
    } finally {
      setClosing(false);
    }
  }, [closeSummary, items, mfa, onClosed, reviewId]);

  const cancelReview = useCallback(async () => {
    setActionError(null);
    if (!mfa.trim()) {
      setActionError("Enter your admin TOTP code first.");
      return;
    }
    const ok = window.confirm("Cancel this review without applying changes?");
    if (!ok) return;
    setClosing(true);
    try {
      const r = await fetch(`/api/access-reviews/${reviewId}/cancel`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mfa-code": mfa.trim(),
        },
        body: JSON.stringify({ reason: closeSummary.trim() || null }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(
          typeof body?.detail === "string"
            ? body.detail
            : `request failed (${r.status})`,
        );
      }
      onClosed();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to cancel review.",
      );
    } finally {
      setClosing(false);
    }
  }, [closeSummary, mfa, onClosed, reviewId]);

  return (
    <Card>
      <CardHeader
        title={`Review #${reviewId}`}
        hint={
          review
            ? `${review.decided_count} of ${review.item_count} decided`
            : "loading"
        }
      />
      <div className="p-4">
        {error ? (
          <ErrorBox
            message={error instanceof Error ? error.message : "Load failed."}
          />
        ) : isLoading ? (
          <div className="grid gap-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : items.length === 0 ? (
          <Empty
            title="No items"
            hint="Workspace had no members when this review was opened."
          />
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {items.map((it) => (
              <li
                key={it.id}
                className="py-3 flex flex-col gap-2 lg:flex-row lg:items-start lg:gap-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <UserCircle size={14} weight="duotone" aria-hidden />
                    <span className="text-sm font-medium truncate">
                      {it.subject}
                    </span>
                    <Badge tone="neutral">current: {it.current_role}</Badge>
                    {it.decision ? (
                      <Badge tone={decisionTone(it.decision)}>
                        {it.decision === "keep" ? (
                          <CheckCircle size={11} weight="duotone" aria-hidden />
                        ) : it.decision === "change" ? (
                          <PencilLine size={11} weight="duotone" aria-hidden />
                        ) : (
                          <Trash size={11} weight="duotone" aria-hidden />
                        )}
                        {it.decision}
                        {it.new_role ? ` -> ${it.new_role}` : ""}
                      </Badge>
                    ) : (
                      <Badge tone="warn">pending</Badge>
                    )}
                    {it.applied ? <Badge tone="success">applied</Badge> : null}
                  </div>
                  {it.decided_by ? (
                    <div className="mt-1 text-xs text-[var(--color-muted)] tabular-nums">
                      decided by{" "}
                      <span className="font-mono">{it.decided_by}</span>
                      {" // "}
                      {fmtTime(it.decided_at)}
                    </div>
                  ) : null}
                  {it.note ? (
                    <div className="mt-1 text-xs text-[var(--color-muted)] line-clamp-2">
                      note: {it.note}
                    </div>
                  ) : null}
                  {isOpen && !it.applied ? (
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Select
                        aria-label={`New role for ${it.subject}`}
                        value={pendingRoles[it.id] || ""}
                        onChange={(e) =>
                          setPendingRoles((r) => ({
                            ...r,
                            [it.id]: e.target.value,
                          }))
                        }
                      >
                        <option value="">change to...</option>
                        {ROLES.filter((r) => r !== it.current_role).map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                      <Input
                        aria-label={`Note for ${it.subject}`}
                        value={pendingNotes[it.id] || ""}
                        onChange={(e) =>
                          setPendingNotes((n) => ({
                            ...n,
                            [it.id]: e.target.value,
                          }))
                        }
                        placeholder="Note (optional)"
                        maxLength={4096}
                      />
                    </div>
                  ) : null}
                </div>
                {isOpen && !it.applied ? (
                  <div className="shrink-0 flex items-center gap-2 flex-wrap">
                    <Button
                      variant="ghost"
                      onClick={() => decide(it.id, "keep")}
                      disabled={busy === it.id}
                      aria-label={`Keep ${it.subject}`}
                    >
                      <CheckCircle size={14} weight="duotone" aria-hidden />
                      Keep
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => decide(it.id, "change")}
                      disabled={busy === it.id}
                      aria-label={`Change role for ${it.subject}`}
                    >
                      <PencilLine size={14} weight="duotone" aria-hidden />
                      Change
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => decide(it.id, "revoke")}
                      disabled={busy === it.id}
                      aria-label={`Revoke ${it.subject}`}
                    >
                      <Trash size={14} weight="duotone" aria-hidden />
                      Revoke
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
              <span className="text-[var(--color-muted)]">
                Admin TOTP code (required for every decision and close)
              </span>
              <Input
                value={mfa}
                onChange={(e) => setMfa(e.target.value.replace(/\D/g, ""))}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6,8}"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-[var(--color-muted)]">
                Close summary (optional, also used as cancel reason)
              </span>
              <Input
                value={closeSummary}
                onChange={(e) => setCloseSummary(e.target.value)}
                placeholder="Q2 review complete; 2 revocations, 1 demotion."
                maxLength={4096}
              />
            </label>
            {actionError ? <ErrorBox message={actionError} /> : null}
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="primary" onClick={closeReview} disabled={closing}>
                <CheckCircle size={14} weight="duotone" aria-hidden />
                {closing ? "Closing..." : "Close and apply"}
              </Button>
              <Button variant="ghost" onClick={cancelReview} disabled={closing}>
                <Trash size={14} weight="duotone" aria-hidden />
                Cancel review
              </Button>
              <span className="text-xs text-[var(--color-muted)]">
                Close writes one admin audit row per applied change.
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
