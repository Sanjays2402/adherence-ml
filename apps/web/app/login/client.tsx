"use client";

import { useState } from "react";
import { Envelope, PaperPlaneTilt, ShieldCheck, Spinner, Warning } from "@phosphor-icons/react";

interface SendResponse {
  ok?: boolean;
  message?: string;
  dev_link?: string;
  error?: { code: string; message: string };
}

const ERROR_COPY: Record<string, string> = {
  missing_token: "That sign-in link is missing its token. Request a new one.",
  invalid_or_expired:
    "That link is invalid or has expired. Request a new one and use it within 15 minutes.",
};

export default function LoginClient({
  error,
  next,
}: {
  error: string | null;
  next: string | null;
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus("sending");
    setMessage(null);
    setDevLink(null);
    try {
      const res = await fetch("/api/auth/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json()) as SendResponse;
      if (!res.ok || !data.ok) {
        setStatus("error");
        setMessage(data.error?.message ?? "Could not send sign-in link. Try again.");
        return;
      }
      setStatus("sent");
      setMessage(data.message ?? "Check your email for a sign-in link.");
      if (data.dev_link) setDevLink(data.dev_link);
    } catch {
      setStatus("error");
      setMessage("Network error. Please retry.");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-5 py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex items-center gap-2.5">
          <ShieldCheck weight="duotone" size={22} className="text-[var(--color-accent)]" />
          <div className="flex flex-col leading-tight">
            <span className="text-[15px] font-semibold tracking-tight">Sign in</span>
            <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted)]">
              adherence.ml // magic link
            </span>
          </div>
        </div>

        {error && ERROR_COPY[error] ? (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-2 text-[13px] text-[var(--color-fg)]"
          >
            <Warning weight="duotone" size={16} className="mt-0.5 text-[var(--color-danger)]" />
            <span>{ERROR_COPY[error]}</span>
          </div>
        ) : null}

        <form
          onSubmit={onSubmit}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]/60 p-5 backdrop-blur"
        >
          <label htmlFor="email" className="block text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted)]">
            Work email
          </label>
          <div className="mt-1.5 flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 focus-within:border-[var(--color-accent)]">
            <Envelope weight="duotone" size={16} className="text-[var(--color-muted)]" />
            <input
              id="email"
              type="email"
              required
              autoFocus
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={status === "sending"}
              className="flex-1 bg-transparent py-2 text-[14px] outline-none placeholder:text-[var(--color-subtle)] disabled:opacity-60"
            />
          </div>

          <button
            type="submit"
            disabled={status === "sending" || !email.trim()}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md bg-[var(--color-accent)] px-3 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "sending" ? (
              <>
                <Spinner weight="duotone" size={16} className="animate-spin" />
                Sending link
              </>
            ) : (
              <>
                <PaperPlaneTilt weight="duotone" size={16} />
                Email me a sign-in link
              </>
            )}
          </button>

          {next ? (
            <p className="mt-3 text-[11px] font-mono uppercase tracking-widest text-[var(--color-subtle)]">
              redirect after sign in: {next}
            </p>
          ) : null}

          {status === "sent" && message ? (
            <div
              role="status"
              className="mt-4 rounded-md border border-[var(--color-low)]/40 bg-[var(--color-low)]/10 px-3 py-2 text-[13px] text-[var(--color-fg)]"
            >
              {message}
            </div>
          ) : null}

          {status === "error" && message ? (
            <div
              role="alert"
              className="mt-4 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-2 text-[13px] text-[var(--color-fg)]"
            >
              {message}
            </div>
          ) : null}

          {devLink ? (
            <div className="mt-4 rounded-md border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-2)] p-3">
              <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted)]">
                Dev only // no SMTP configured
              </div>
              <a
                href={devLink}
                className="mt-1 block break-all text-[12px] font-mono text-[var(--color-accent)] hover:underline"
              >
                {devLink}
              </a>
            </div>
          ) : null}
        </form>

        <p className="mt-4 text-[12px] text-[var(--color-muted)]">
          New here? Use any email. We create your account on first sign in.
        </p>
      </div>
    </div>
  );
}
