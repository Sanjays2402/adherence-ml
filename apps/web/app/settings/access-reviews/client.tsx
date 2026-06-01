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
