"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ShieldCheck, Spinner, Warning, Key } from "@phosphor-icons/react";
import { Button, Card, CardHeader, ErrorBox, Input } from "@/components/ui/primitives";

type PendingInfo =
  | { pending: true; email: string; expires_at: number; next: string }
  | { pending: false };

export default function VerifyTwoFactorClient({ next }: { next: string | null }) {
  const router = useRouter();
  const [info, setInfo] = useState<PendingInfo | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // (refs intentionally omitted; Input primitive does not forward refs)

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/auth/2fa/verify", { cache: "no-store" });
        const data = (await r.json()) as PendingInfo;
        if (!cancelled) setInfo(data);
      } catch {
        if (!cancelled) setInfo({ pending: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const body = useRecovery
        ? { recovery: recovery.trim() }
        : { code: code.trim() };
      const res = await fetch("/api/auth/2fa/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        next?: string;
        error?: { message?: string };
      };
      if (!res.ok || !data.ok) {
        setError(data.error?.message ?? "Verification failed.");
        setSubmitting(false);
        return;
      }
      const dest = next || data.next || "/";
      router.push(dest);
      router.refresh();
    } catch {
      setError("Network error. Try again.");
      setSubmitting(false);
    }
  }

  if (info === null) {
    return (
      <main className="min-h-[60vh] flex items-center justify-center px-4">
        <Spinner className="size-5 animate-spin text-[var(--color-muted)]" />
      </main>
    );
  }

  if (!info.pending) {
    return (
      <main className="min-h-[60vh] flex items-center justify-center px-4">
        <div className="max-w-md w-full">
          <Card>
            <CardHeader
              title="no sign-in in progress"
              hint="Your verification link expired. Start over from the login page."
              right={<Warning className="size-5 text-amber-500" weight="duotone" />}
            />
            <div className="p-4">
              <Link href="/login" className="text-[12px] underline">
                Back to login
              </Link>
            </div>
          </Card>
        </div>
      </main>
    );
  }

  const minsLeft = Math.max(0, Math.floor((info.expires_at - Date.now()) / 60000));

  return (
    <main className="min-h-[60vh] flex items-center justify-center px-4 py-10">
      <div className="max-w-md w-full">
        <Card>
          <CardHeader
            title="two-factor authentication"
            hint={`Enter the 6-digit code for ${info.email}.`}
            right={<ShieldCheck className="size-5" weight="duotone" />}
          />
          <form onSubmit={submit} className="p-4 space-y-4">
            {useRecovery ? (
              <div>
                <label className="text-[12px] font-medium mb-1 block">Recovery code</label>
                <Input
                  autoFocus
                  value={recovery}
                  onChange={(e) => setRecovery(e.target.value)}
                  placeholder="abcd-efgh"
                  autoComplete="one-time-code"
                  spellCheck={false}
                  disabled={submitting}
                />
              </div>
            ) : (
              <div>
                <label className="text-[12px] font-medium mb-1 block">Authenticator code</label>
                <Input
                  autoFocus
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  placeholder="123456"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  disabled={submitting}
                  className="tracking-[0.4em] text-center text-lg"
                />
              </div>
            )}

            {error ? <ErrorBox message={error} /> : null}

            <Button
              type="submit"
              disabled={
                submitting || (useRecovery ? recovery.length < 4 : code.length !== 6)
              }
              className="w-full justify-center"
            >
              {submitting ? <Spinner className="size-4 animate-spin" /> : null}
              {submitting ? "Verifying" : "Verify and sign in"}
            </Button>

            <div className="flex items-center justify-between text-[11px] text-[var(--color-muted)]">
              <button
                type="button"
                onClick={() => {
                  setUseRecovery((v) => !v);
                  setError(null);
                }}
                className="inline-flex items-center gap-1 underline hover:text-[var(--color-text)]"
              >
                <Key className="size-3" />
                {useRecovery ? "Use authenticator code" : "Use a recovery code"}
              </button>
              <span>Expires in {minsLeft}m</span>
            </div>
          </form>
        </Card>
      </div>
    </main>
  );
}
