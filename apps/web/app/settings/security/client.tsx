"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ShieldCheck,
  ShieldWarning,
  Copy,
  CheckCircle,
  Warning,
  Key,
  ArrowClockwise,
  ArrowLeft,
  DownloadSimple,
} from "@phosphor-icons/react";
import {
  Button,
  Card,
  CardHeader,
  ErrorBox,
  Input,
  Skeleton,
  Badge,
} from "@/components/ui/primitives";

type Status = {
  enabled: boolean;
  setup_in_progress: boolean;
  recovery_codes_remaining: number;
  updated_at: number | null;
};

type SetupResp = {
  secret: string;
  secret_pretty: string;
  otpauth_uri: string;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function fmtTime(ms: number | null): string {
  if (!ms) return "never";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* ignore */
        }
      }}
      className="inline-flex items-center gap-1 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)] transition"
    >
      {copied ? <CheckCircle className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "copied" : label ?? "copy"}
    </button>
  );
}

export default function SecurityClient() {
  const { data: status, mutate, isLoading } = useSWR<Status>(
    "/api/auth/2fa/status",
    fetcher,
    { revalidateOnFocus: true },
  );

  const [setup, setSetup] = useState<SetupResp | null>(null);
  const [setupErr, setSetupErr] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const [disableCode, setDisableCode] = useState("");
  const [disableErr, setDisableErr] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);

  const startSetup = useCallback(async () => {
    setSetupErr(null);
    setRecoveryCodes(null);
    try {
      const r = await fetch("/api/auth/2fa/setup", { method: "POST" });
      const d = (await r.json()) as SetupResp & { error?: { message?: string } };
      if (!r.ok) {
        setSetupErr(d.error?.message ?? "Could not start setup.");
        return;
      }
      setSetup(d);
    } catch {
      setSetupErr("Network error.");
    }
  }, []);

  const confirmEnable = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setVerifyErr(null);
      setVerifying(true);
      try {
        const r = await fetch("/api/auth/2fa/enable", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: code.trim() }),
        });
        const d = (await r.json()) as {
          ok?: boolean;
          recovery_codes?: string[];
          error?: { message?: string };
        };
        if (!r.ok || !d.ok) {
          setVerifyErr(d.error?.message ?? "Verification failed.");
          setVerifying(false);
          return;
        }
        setRecoveryCodes(d.recovery_codes ?? []);
        setSetup(null);
        setCode("");
        await mutate();
      } catch {
        setVerifyErr("Network error.");
      } finally {
        setVerifying(false);
      }
    },
    [code, mutate],
  );

  const disable = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setDisableErr(null);
      setDisabling(true);
      try {
        const body: { code?: string; recovery?: string } = /^\d{6}$/.test(
          disableCode.trim(),
        )
          ? { code: disableCode.trim() }
          : { recovery: disableCode.trim() };
        const r = await fetch("/api/auth/2fa/disable", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const d = (await r.json()) as { ok?: boolean; error?: { message?: string } };
        if (!r.ok || !d.ok) {
          setDisableErr(d.error?.message ?? "Could not disable.");
          setDisabling(false);
          return;
        }
        setDisableCode("");
        setRecoveryCodes(null);
        await mutate();
      } catch {
        setDisableErr("Network error.");
      } finally {
        setDisabling(false);
      }
    },
    [disableCode, mutate],
  );

  const downloadRecovery = useCallback(() => {
    if (!recoveryCodes?.length) return;
    const body =
      [
        "adherence.ml two-factor recovery codes",
        `generated: ${new Date().toISOString()}`,
        "Each code works exactly once. Store somewhere safe.",
        "",
        ...recoveryCodes,
      ].join("\n") + "\n";
    const blob = new Blob([body], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "adherence-ml-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }, [recoveryCodes]);

  return (
    <main className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Link
            href="/settings"
            className="inline-flex items-center gap-1 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            <ArrowLeft className="size-3" /> Settings
          </Link>
          <h1 className="text-xl font-semibold mt-1 flex items-center gap-2">
            <ShieldCheck className="size-5" weight="duotone" /> Security
          </h1>
          <p className="text-[12px] text-[var(--color-muted)] mt-1">
            Two-factor authentication adds a one-time code from your phone on top of your magic link or OAuth sign-in.
          </p>
        </div>
        {isLoading ? null : status?.enabled ? (
          <Badge tone="success">2FA on</Badge>
        ) : (
          <Badge tone="warn">2FA off</Badge>
        )}
      </div>

      {recoveryCodes ? (
        <Card>
          <CardHeader
            title="save your recovery codes"
            hint="Each code works once. Use one if you ever lose your phone. We will not show these again."
            right={<Key className="size-5" weight="duotone" />}
          />
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-2 font-mono text-[13px]">
              {recoveryCodes.map((c) => (
                <div
                  key={c}
                  className="px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg-soft)] text-center"
                >
                  {c}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button onClick={downloadRecovery}>
                <DownloadSimple className="size-4" /> Download .txt
              </Button>
              <CopyButton text={recoveryCodes.join("\n")} label="copy all" />
              <button
                type="button"
                onClick={() => setRecoveryCodes(null)}
                className="text-[11px] underline text-[var(--color-muted)] ml-auto"
              >
                I have saved them
              </button>
            </div>
          </div>
        </Card>
      ) : null}

      {isLoading ? (
        <Card>
          <div className="p-4 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </Card>
      ) : status?.enabled ? (
        <>
          <Card>
            <CardHeader
              title="2fa is active"
              hint={`Last updated ${fmtTime(status.updated_at)}. ${status.recovery_codes_remaining} recovery code${status.recovery_codes_remaining === 1 ? "" : "s"} remaining.`}
              right={<ShieldCheck className="size-5 text-emerald-500" weight="duotone" />}
            />
            <div className="p-4 text-[12px] text-[var(--color-muted)] space-y-2">
              <p>
                The next time you sign in, you will be asked for a 6-digit code from your authenticator app after the magic link or GitHub OAuth step.
              </p>
              {status.recovery_codes_remaining <= 2 ? (
                <p className="text-amber-500 inline-flex items-center gap-1">
                  <Warning className="size-3.5" /> You are running low on recovery codes. Disable and re-enable 2FA to mint a fresh set.
                </p>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="disable two-factor"
              hint="Enter a current code or one of your recovery codes to confirm."
              right={<ShieldWarning className="size-5 text-amber-500" weight="duotone" />}
            />
            <form onSubmit={disable} className="p-4 space-y-3">
              <Input
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                placeholder="123456 or abcd-efgh"
                autoComplete="one-time-code"
                spellCheck={false}
                disabled={disabling}
              />
              {disableErr ? <ErrorBox message={disableErr} /> : null}
              <Button
                type="submit"
                variant="ghost"
                disabled={disabling || disableCode.trim().length < 4}
              >
                {disabling ? "Disabling" : "Disable 2FA"}
              </Button>
            </form>
          </Card>
        </>
      ) : setup ? (
        <Card>
          <CardHeader
            title="step 2 of 2 // confirm"
            hint="Open your authenticator app and enter the 6-digit code it shows for adherence.ml."
            right={<ArrowClockwise className="size-5" weight="duotone" />}
          />
          <div className="p-4 space-y-4">
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">
                Add this to your authenticator
              </div>
              <a
                href={setup.otpauth_uri}
                className="block rounded border border-[var(--color-border)] bg-[var(--color-bg-soft)] px-3 py-2 text-[11px] font-mono break-all hover:border-[var(--color-accent)]/70"
              >
                {setup.otpauth_uri}
              </a>
              <div className="text-[11px] text-[var(--color-muted)]">
                On mobile this opens 1Password / Authy / Google Authenticator. On desktop, paste it into your authenticator, or enter the secret below by hand.
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] flex items-center justify-between">
                <span>Manual entry secret</span>
                <CopyButton text={setup.secret} />
              </div>
              <div className="font-mono text-[13px] px-3 py-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-soft)] tracking-widest">
                {setup.secret_pretty}
              </div>
            </div>

            <form onSubmit={confirmEnable} className="space-y-3 pt-2">
              <label className="text-[12px] font-medium block">Code from your app</label>
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
                disabled={verifying}
                className="tracking-[0.4em] text-center text-lg"
              />
              {verifyErr ? <ErrorBox message={verifyErr} /> : null}
              <div className="flex items-center gap-2">
                <Button type="submit" disabled={verifying || code.length !== 6}>
                  {verifying ? "Verifying" : "Turn on 2FA"}
                </Button>
                <button
                  type="button"
                  onClick={() => {
                    setSetup(null);
                    setCode("");
                    setVerifyErr(null);
                  }}
                  className="text-[11px] underline text-[var(--color-muted)]"
                  disabled={verifying}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="add two-factor authentication"
            hint="One extra layer between someone with your inbox and your account."
            right={<ShieldWarning className="size-5 text-amber-500" weight="duotone" />}
          />
          <div className="p-4 space-y-3">
            <ol className="text-[12px] text-[var(--color-muted)] space-y-1 list-decimal pl-4">
              <li>Install an authenticator app (1Password, Authy, Google Authenticator, Bitwarden).</li>
              <li>Click below to generate a new secret and add it to the app.</li>
              <li>Enter the 6-digit code to confirm, then save your recovery codes.</li>
            </ol>
            {setupErr ? <ErrorBox message={setupErr} /> : null}
            <Button onClick={startSetup}>
              <ShieldCheck className="size-4" weight="duotone" /> Set up 2FA
            </Button>
          </div>
        </Card>
      )}
    </main>
  );
}
