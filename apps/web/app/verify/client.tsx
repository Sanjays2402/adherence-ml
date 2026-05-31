"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CheckCircle, Spinner, Warning } from "@phosphor-icons/react";

type State =
  | { kind: "idle" }
  | { kind: "verifying" }
  | { kind: "ok"; email: string; next: string }
  | { kind: "error"; message: string };

export default function VerifyClient({
  token,
  next,
}: {
  token: string | null;
  next: string | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<State>(token ? { kind: "verifying" } : {
    kind: "error",
    message: "Missing token. Request a new sign-in link.",
  });

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, next }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          user?: { email: string };
          next?: string;
          error?: { message: string };
        };
        if (cancelled) return;
        if (!res.ok || !data.ok || !data.user) {
          setState({
            kind: "error",
            message: data.error?.message ?? "Could not verify this link.",
          });
          return;
        }
        const dest = data.next || "/";
        setState({ kind: "ok", email: data.user.email, next: dest });
        // Tiny pause so the success state is visible before the redirect.
        setTimeout(() => router.replace(dest), 600);
      } catch {
        if (!cancelled) {
          setState({ kind: "error", message: "Network error. Please retry." });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, next, router]);

  return (
    <div className="min-h-screen flex items-center justify-center px-5 py-10">
      <div className="w-full max-w-[420px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]/60 p-6 backdrop-blur">
        {state.kind === "verifying" && (
          <div className="flex items-center gap-3 text-[14px]">
            <Spinner weight="duotone" size={20} className="animate-spin text-[var(--color-accent)]" />
            <span>Verifying your sign-in link...</span>
          </div>
        )}
        {state.kind === "ok" && (
          <div className="flex items-start gap-3">
            <CheckCircle weight="duotone" size={22} className="text-[var(--color-low)]" />
            <div>
              <div className="text-[14px] font-medium">Signed in as {state.email}</div>
              <div className="text-[12px] text-[var(--color-muted)]">
                Redirecting to {state.next}...
              </div>
            </div>
          </div>
        )}
        {state.kind === "error" && (
          <div>
            <div className="flex items-start gap-3">
              <Warning weight="duotone" size={22} className="text-[var(--color-danger)]" />
              <div>
                <div className="text-[14px] font-medium">Verification failed</div>
                <div className="text-[12px] text-[var(--color-muted)]">{state.message}</div>
              </div>
            </div>
            <Link
              href="/login"
              className="mt-4 inline-flex items-center gap-2 rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-[12px] hover:border-[var(--color-accent)]"
            >
              Back to sign in
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
