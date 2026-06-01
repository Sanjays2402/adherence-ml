"use client";

/**
 * Step-up MFA prompt.
 *
 * A small dialog the dashboard mounts once at the layout level. When any
 * fetch call returns 403 { code: "mfa_step_up_required" }, the helper
 * `stepUpFetch` opens this dialog, asks the user for a TOTP code (or
 * recovery code), posts it to /api/auth/2fa/step-up, and on success
 * retries the original request. The dialog focuses the code input,
 * supports Enter to submit and Esc to cancel, and is keyboard
 * accessible.
 *
 * Importantly this is NOT a login dialog. It only refreshes the per-session
 * `last_mfa_at` window so subsequent sensitive admin actions clear the
 * step-up gate for a fixed grace period (default 10 minutes).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldCheck, ShieldWarning, X } from "@phosphor-icons/react/dist/ssr";

type Mode = "totp" | "recovery";

interface PendingPrompt {
  detail: string;
  totpEnrolled: boolean;
  resolve: (ok: boolean) => void;
  reason?: string | null;
}

let openPrompt: ((p: Omit<PendingPrompt, "resolve">) => Promise<boolean>) | null =
  null;

/**
 * Wrapper around fetch that transparently handles a 403
 * mfa_step_up_required by prompting the user, then retrying once.
 * Returns the final Response (which may still be the original 403 if
 * the user cancelled or step-up failed).
 */
export async function stepUpFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status !== 403) return res;
  // Peek at the body without consuming it for the caller.
  const cloned = res.clone();
  let parsed: { code?: string; detail?: string; step_up?: { totp_enrolled?: boolean; reason?: string | null } } | null = null;
  try {
    parsed = await cloned.json();
  } catch {
    return res;
  }
  if (!parsed || parsed.code !== "mfa_step_up_required" || !openPrompt) {
    return res;
  }
  const ok = await openPrompt({
    detail: parsed.detail ?? "verify a second factor to continue",
    totpEnrolled: parsed.step_up?.totp_enrolled ?? true,
    reason: parsed.step_up?.reason ?? null,
  });
  if (!ok) return res;
  return fetch(input, init);
}

export function StepUpProvider() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const [mode, setMode] = useState<Mode>("totp");
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    openPrompt = (p) =>
      new Promise<boolean>((resolve) => {
        setPending({ ...p, resolve });
        setMode(p.totpEnrolled ? "totp" : "totp");
        setValue("");
        setError(null);
        setOpen(true);
      });
    return () => {
      openPrompt = null;
    };
  }, []);

  useEffect(() => {
    if (open) {
      // delay so the dialog has actually mounted before we focus.
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
    return;
  }, [open, mode]);

  const close = useCallback(
    (ok: boolean) => {
      pending?.resolve(ok);
      setOpen(false);
      setPending(null);
      setValue("");
      setError(null);
    },
    [pending],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const submit = useCallback(async () => {
    if (submitting) return;
    const trimmed = value.trim();
    if (!trimmed) {
      setError(mode === "totp" ? "enter the 6-digit code" : "enter a recovery code");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const body = mode === "totp" ? { code: trimmed } : { recovery: trimmed };
      const res = await fetch("/api/auth/2fa/step-up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: true; error?: string; detail?: string }
        | null;
      if (!res.ok || !data?.ok) {
        const msg = data?.detail ?? data?.error ?? `verification failed (${res.status})`;
        setError(msg);
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
      close(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
      setSubmitting(false);
    }
  }, [submitting, value, mode, close]);

  if (!open || !pending) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="stepup-title"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(false);
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-3">
          <div className="flex items-center gap-2">
            {pending.totpEnrolled ? (
              <ShieldCheck size={18} weight="duotone" className="text-[var(--color-accent)]" />
            ) : (
              <ShieldWarning size={18} weight="duotone" className="text-amber-500" />
            )}
            <h2 id="stepup-title" className="text-[14px] font-semibold tracking-tight">
              verify a second factor
            </h2>
          </div>
          <button
            type="button"
            aria-label="cancel"
            onClick={() => close(false)}
            className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
          >
            <X size={16} weight="bold" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p className="text-[12px] leading-relaxed text-[var(--color-muted)]">
            {pending.detail}
          </p>
          {pending.totpEnrolled ? (
            <>
              <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                {mode === "totp" ? "totp code" : "recovery code"}
              </label>
              <input
                ref={inputRef}
                inputMode={mode === "totp" ? "numeric" : "text"}
                autoComplete="one-time-code"
                aria-label={mode === "totp" ? "totp code" : "recovery code"}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submit();
                  }
                }}
                placeholder={mode === "totp" ? "123456" : "abcd-efgh"}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[14px] font-mono tracking-widest outline-none focus:border-[var(--color-accent)]"
              />
              <button
                type="button"
                onClick={() => {
                  setMode((m) => (m === "totp" ? "recovery" : "totp"));
                  setValue("");
                  setError(null);
                }}
                className="text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)] underline-offset-2 hover:underline"
              >
                use {mode === "totp" ? "a recovery code" : "an authenticator code"} instead
              </button>
            </>
          ) : (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
              your workspace policy requires MFA but your account has no TOTP enrolled.
              open <span className="font-mono">/settings/security</span> and add an
              authenticator, then retry this action.
            </div>
          )}
          {error ? (
            <div role="alert" className="text-[12px] text-red-400">
              {error}
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-5 py-3">
          <button
            type="button"
            onClick={() => close(false)}
            className="rounded border border-[var(--color-border)] px-3 py-1.5 text-[12px] hover:bg-[var(--color-surface)]"
          >
            cancel
          </button>
          {pending.totpEnrolled ? (
            <button
              type="button"
              disabled={submitting}
              onClick={() => void submit()}
              className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-black disabled:opacity-50"
            >
              {submitting ? "verifying..." : "verify and continue"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
