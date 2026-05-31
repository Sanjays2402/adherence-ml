"use client";

import { useState } from "react";
import { Envelope, GithubLogo, Key, PaperPlaneTilt, ShieldCheck, Spinner, Warning } from "@phosphor-icons/react";

interface SsoHint {
  workspace_id: string;
  workspace_name: string;
  label: string;
  start_url: string;
  enforce?: boolean;
}

interface SendResponse {
  ok?: boolean;
  message?: string;
  dev_link?: string;
  error?: { code: string; message: string };
  sso?: SsoHint;
}

const ERROR_COPY: Record<string, string> = {
  missing_token: "That sign-in link is missing its token. Request a new one.",
  invalid_or_expired:
    "That link is invalid or has expired. Request a new one and use it within 15 minutes.",
  oauth_state:
    "GitHub sign-in could not be verified (state mismatch or expired). Try again.",
  oauth_exchange:
    "GitHub rejected the sign-in handshake. Try again in a moment.",
  oauth_no_email:
    "GitHub did not return a verified email. Add a verified email to your GitHub account and try again.",
  oauth_unconfigured:
    "GitHub sign-in is not configured on this server. Use the email link instead.",
  sso_required:
    "Your workspace requires single sign-on. Use the Continue with SSO button.",
  sso_state: "SSO sign-in could not be verified (state mismatch or expired). Try again.",
  sso_exchange: "Your identity provider rejected the sign-in. Try again.",
  sso_verify: "The identity provider returned an invalid token. Contact your admin.",
  sso_no_email: "Your identity provider did not return an email. Contact your admin.",
  sso_unverified_email: "Your identity provider has not verified that email. Verify it and try again.",
  sso_domain_mismatch:
    "That email's domain is not allowed on this workspace's SSO. Contact your admin.",
  sso_discovery: "Could not reach the identity provider's discovery URL. Try again.",
  sso_not_configured: "SSO is not configured for this workspace.",
  sso_missing_workspace: "SSO sign-in needs a workspace id. Use the SSO button on the login page.",
};

export default function LoginClient({
  error,
  next,
  githubEnabled,
}: {
  error: string | null;
  next: string | null;
  githubEnabled: boolean;
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [sso, setSso] = useState<SsoHint | null>(null);
  const [ssoChecking, setSsoChecking] = useState(false);

  async function checkSso(candidate: string) {
    const trimmed = candidate.trim().toLowerCase();
    if (!trimmed.includes("@") || trimmed.length < 5) {
      setSso(null);
      return;
    }
    setSsoChecking(true);
    try {
      const r = await fetch("/api/auth/sso/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      const j = (await r.json()) as { ok: boolean; sso: SsoHint | null };
      setSso(j.sso ?? null);
    } catch {
      setSso(null);
    } finally {
      setSsoChecking(false);
    }
  }

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
      if (res.status === 403 && data.error?.code === "sso_required" && data.sso) {
        setSso(data.sso);
        setStatus("error");
        setMessage(data.error.message);
        return;
      }
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
              onChange={(e) => {
                setEmail(e.target.value);
                setSso(null);
              }}
              onBlur={(e) => checkSso(e.target.value)}
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

          {sso ? (
            <div className="mt-4 rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5 px-3 py-3">
              <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted)]">
                {sso.enforce ? "single sign-on required" : "single sign-on available"}
              </div>
              <a
                href={`${sso.start_url}${next ? `&next=${encodeURIComponent(next)}` : ""}`}
                className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-md border border-[var(--color-accent)]/60 bg-[var(--color-accent)]/10 px-3 py-2 text-[13px] font-medium text-[var(--color-fg)] transition-colors hover:bg-[var(--color-accent)]/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                <Key weight="duotone" size={16} />
                Continue with {sso.label}
              </a>
              <p className="mt-2 text-[11px] text-[var(--color-subtle)]">
                Workspace: {sso.workspace_name}
              </p>
            </div>
          ) : ssoChecking ? (
            <p className="mt-3 text-[11px] font-mono uppercase tracking-widest text-[var(--color-subtle)]">
              checking single sign-on...
            </p>
          ) : null}

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

        {githubEnabled ? (
          <>
            <div className="my-5 flex items-center gap-3" aria-hidden="true">
              <div className="h-px flex-1 bg-[var(--color-border)]" />
              <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-subtle)]">
                or
              </span>
              <div className="h-px flex-1 bg-[var(--color-border)]" />
            </div>
            <a
              href={`/api/auth/github${next ? `?next=${encodeURIComponent(next)}` : ""}`}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] font-medium text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            >
              <GithubLogo weight="duotone" size={16} />
              Continue with GitHub
            </a>
            <p className="mt-2 text-[11px] text-[var(--color-subtle)]">
              We only read your verified primary email. No repos, no writes.
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}
