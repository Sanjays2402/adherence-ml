"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowsClockwise,
  CheckCircle,
  Copy,
  Key,
  ShieldCheck,
  ShieldWarning,
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
  PageHeader,
  Skeleton,
} from "@/components/ui/primitives";

type StatusOut = {
  principal: string;
  enrolled: boolean;
  confirmed: boolean;
  backup_codes_remaining: number;
  backup_codes_low: boolean;
  backup_codes_low_watermark: number;
  last_used_at: string | null;
  challenge_active: boolean;
};

type RegenerateOut = {
  principal: string;
  backup_codes: string[];
  issued_count: number;
};

const fetcher = async (url: string): Promise<StatusOut> => {
  const r = await fetch(url, { cache: "no-store" });
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

export default function AdminMfaClient() {
  const { data, error, isLoading, mutate } = useSWR<StatusOut>(
    "/api/admin-mfa/status",
    fetcher,
    { revalidateOnFocus: false },
  );

  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [issued, setIssued] = useState<RegenerateOut | null>(null);
  const [copied, setCopied] = useState(false);

  const regenerate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = code.trim().replace(/\s+/g, "");
      if (trimmed.length < 4 || trimmed.length > 16) {
        setSubmitError("Enter a 6 digit TOTP code or a 10 character backup code.");
        return;
      }
      setBusy(true);
      setSubmitError(null);
      try {
        const r = await fetch("/api/admin-mfa/backup-codes/regenerate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: trimmed }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(
            typeof body?.detail === "string"
              ? body.detail
              : `request failed (${r.status})`,
          );
        }
        setIssued(body as RegenerateOut);
        setCode("");
        setCopied(false);
        await mutate();
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : "request failed");
      } finally {
        setBusy(false);
      }
    },
    [code, mutate],
  );

  const copyAll = useCallback(async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.backup_codes.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }, [issued]);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <div>
        <Link
          href="/admin"
          className="inline-flex items-center gap-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          <ArrowLeft size={14} weight="duotone" /> admin
        </Link>
      </div>
      <PageHeader
        title="Admin MFA backup codes"
        description="Backend admin TOTP enrolment status and one-click rotation of the single-use backup codes that recover access when the authenticator app is lost. Every action is admin only and audit logged."
      />

      <StatusCard data={data} error={error} isLoading={isLoading} />

      <Card>
        <CardHeader
          title="Regenerate backup codes"
          right={
            data?.confirmed ? (
              <Badge tone={data.backup_codes_low ? "danger" : "neutral"}>
                {data.backup_codes_remaining} left
              </Badge>
            ) : null
          }
        />
        <div className="space-y-4 p-4">
          {!data?.confirmed ? (
            <Empty
              title="MFA not confirmed"
              hint="Enrol an authenticator app with POST /v1/admin/mfa/enroll before you can rotate backup codes."
            />
          ) : (
            <>
              <p className="text-sm text-[var(--color-muted)]">
                Authenticate with a fresh 6 digit code from your authenticator app
                (or an unused backup code) to mint a new set of {""}
                {data.backup_codes_remaining === 0 ? "10" : "10"} codes. The previous
                set is discarded immediately.
              </p>
              <form onSubmit={regenerate} className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <label htmlFor="mfa-code" className="sr-only">
                  TOTP or backup code
                </label>
                <Input
                  id="mfa-code"
                  type="text"
                  inputMode="text"
                  autoComplete="one-time-code"
                  placeholder="123456 or aaaaa-bbbbb"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  disabled={busy}
                  className="font-mono"
                  aria-describedby={submitError ? "mfa-code-error" : undefined}
                />
                <Button
                  type="submit"
                  disabled={busy || code.trim().length < 4}
                >
                  <ArrowsClockwise size={14} weight="duotone" />
                  {busy ? "Rotating" : "Regenerate"}
                </Button>
              </form>
              {submitError ? (
                <p
                  id="mfa-code-error"
                  className="flex items-center gap-1 text-sm text-[var(--color-danger)]"
                >
                  <Warning size={14} weight="duotone" /> {submitError}
                </p>
              ) : null}
            </>
          )}
        </div>
      </Card>

      {issued ? (
        <Card>
          <CardHeader
            title="New backup codes"
            right={
              <Button
                onClick={copyAll}
                variant="ghost"
              >
                <Copy size={14} weight="duotone" />
                {copied ? "Copied" : "Copy all"}
              </Button>
            }
          />
          <div className="space-y-3 p-4">
            <p className="flex items-start gap-2 rounded border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 p-3 text-sm">
              <ShieldWarning size={16} weight="duotone" className="mt-0.5 shrink-0" />
              <span>
                These codes are shown once. Store them in a password manager or a
                sealed envelope. The previous backup codes are no longer valid.
              </span>
            </p>
            <ul className="grid grid-cols-2 gap-2 font-mono text-sm sm:grid-cols-2">
              {issued.backup_codes.map((c) => (
                <li
                  key={c}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2"
                >
                  {c}
                </li>
              ))}
            </ul>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function StatusCard({
  data,
  error,
  isLoading,
}: {
  data: StatusOut | undefined;
  error: unknown;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader title="Enrolment status" />
        <div className="space-y-2 p-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/5" />
        </div>
      </Card>
    );
  }
  if (error) {
    return (
      <Card>
        <CardHeader title="Enrolment status" />
        <div className="p-4">
          <ErrorBox
            message={
              error instanceof Error ? error.message : "Failed to load status"
            }
          />
        </div>
      </Card>
    );
  }
  if (!data) return null;

  const tone: "ok" | "warn" | "danger" = !data.confirmed
    ? "warn"
    : data.backup_codes_low
      ? "danger"
      : "ok";
  const icon =
    tone === "ok" ? (
      <ShieldCheck size={16} weight="duotone" />
    ) : tone === "danger" ? (
      <ShieldWarning size={16} weight="duotone" />
    ) : (
      <Key size={16} weight="duotone" />
    );

  return (
    <Card>
      <CardHeader
        title="Enrolment status"
        right={
          <Badge tone={tone === "ok" ? "success" : tone === "danger" ? "danger" : "warn"}>
            {data.confirmed ? "confirmed" : data.enrolled ? "pending" : "not enrolled"}
          </Badge>
        }
      />
      <dl className="grid grid-cols-1 gap-3 p-4 text-sm sm:grid-cols-2">
        <Row label="Principal" value={data.principal} mono />
        <Row label="Active challenge" value={data.challenge_active ? "yes" : "no"} />
        <Row
          label="Backup codes left"
          value={`${data.backup_codes_remaining} of 10`}
          accent={data.backup_codes_low ? "danger" : undefined}
        />
        <Row
          label="Last verified"
          value={
            data.last_used_at
              ? new Date(data.last_used_at + "Z").toLocaleString()
              : "never"
          }
        />
      </dl>
      {data.confirmed && data.backup_codes_low ? (
        <div className="flex items-center gap-2 border-t border-[var(--color-border)] bg-[var(--color-warn)]/5 px-4 py-3 text-xs text-[var(--color-warn)]">
          {icon}
          <span>
            Backup pool at or below the {data.backup_codes_low_watermark} code
            watermark. Rotate to mint a fresh set before they run out.
          </span>
        </div>
      ) : null}
    </Card>
  );
}

function Row({
  label,
  value,
  mono = false,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: "danger";
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd
        className={[
          mono ? "font-mono text-xs" : "",
          accent === "danger" ? "text-[var(--color-danger)]" : "",
          "text-right",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}
