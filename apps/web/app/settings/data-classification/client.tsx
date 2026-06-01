"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowClockwise,
  ShieldCheck,
  Clock,
  FloppyDisk,
  Trash,
  Info,
  Tag,
} from "@phosphor-icons/react";
import {
  Button,
  Card,
  CardHeader,
  ErrorBox,
  Skeleton,
  Badge,
  Input,
  Select,
} from "@/components/ui/primitives";

type Classification = {
  tenant_id: string;
  label: string;
  pinned: boolean;
  justification: string | null;
  updated_at: number | null;
  updated_by: string | null;
  default_label: string;
  allowed_labels: string[];
  min_retention_days: number;
};

const fetcher = (url: string) =>
  fetch(url).then(async (r) => {
    if (!r.ok) {
      const d = (await r.json().catch(() => ({}))) as { detail?: string };
      throw new Error(d.detail ?? `HTTP ${r.status}`);
    }
    return r.json();
  });

const LABEL_HINT: Record<string, string> = {
  public: "Non-sensitive demo or marketing data.",
  internal: "Business data with no regulatory carve-out.",
  confidential: "PII or business-sensitive data (GDPR Art. 4(1)).",
  restricted: "PHI, payment data, or other regulated workloads.",
};

function fmtAbs(sec: number | null): string {
  if (!sec) return "never";
  return new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export default function DataClassificationClient() {
  const { data, error, isLoading, mutate } = useSWR<Classification>(
    "/api/workspace/data-classification",
    fetcher,
    { revalidateOnFocus: true },
  );

  const [label, setLabel] = useState<string>("");
  const [justification, setJustification] = useState<string>("");
  const [mfa, setMfa] = useState<string>("");
  const [busy, setBusy] = useState<"save" | "clear" | "dry" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  const [preview, setPreview] = useState<unknown>(null);

  const allowed = data?.allowed_labels ?? [
    "public",
    "internal",
    "confidential",
    "restricted",
  ];
  const effectiveLabel = label || data?.label || "";

  const headers = useCallback((): HeadersInit => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (mfa.trim()) h["x-mfa-code"] = mfa.trim();
    return h;
  }, [mfa]);

  const save = useCallback(
    async (mode: "save" | "dry") => {
      setMsg(null);
      setPreview(null);
      if (!effectiveLabel || !allowed.includes(effectiveLabel)) {
        setMsg({ kind: "err", text: "Choose a sensitivity label." });
        return;
      }
      setBusy(mode);
      try {
        const qs = mode === "dry" ? "?dry_run=true" : "";
        const r = await fetch(`/api/workspace/data-classification${qs}`, {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({
            label: effectiveLabel,
            justification: justification.trim() || null,
          }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          const detail =
            (body as { detail?: string }).detail ?? `HTTP ${r.status}`;
          if (r.status === 401) {
            setMsg({
              kind: "err",
              text: "Admin MFA required. Enter your authenticator code.",
            });
          } else if (r.status === 403) {
            setMsg({
              kind: "err",
              text: "Admin role required to change the workspace label.",
            });
          } else {
            setMsg({ kind: "err", text: detail });
          }
          return;
        }
        if (mode === "dry") {
          setPreview(body);
          setMsg({ kind: "ok", text: "Dry run only. Nothing was saved." });
        } else {
          setMsg({
            kind: "ok",
            text: `Saved. Workspace is now labelled ${effectiveLabel}.`,
          });
          setLabel("");
          setJustification("");
          await mutate();
        }
      } catch {
        setMsg({ kind: "err", text: "Network error." });
      } finally {
        setBusy(null);
      }
    },
    [allowed, effectiveLabel, headers, justification, mutate],
  );

  const clear = useCallback(async () => {
    if (
      !confirm(
        "Clear the workspace label and fall back to the deployment default?",
      )
    ) {
      return;
    }
    setMsg(null);
    setPreview(null);
    setBusy("clear");
    try {
      const r = await fetch("/api/workspace/data-classification", {
        method: "DELETE",
        headers: headers(),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail =
          (body as { detail?: string }).detail ?? `HTTP ${r.status}`;
        if (r.status === 401) {
          setMsg({
            kind: "err",
            text: "Admin MFA required. Enter your authenticator code.",
          });
        } else if (r.status === 403) {
          setMsg({
            kind: "err",
            text: "Admin role required to clear the workspace label.",
          });
        } else {
          setMsg({ kind: "err", text: detail });
        }
        return;
      }
      setMsg({
        kind: "ok",
        text: "Label cleared. Using the deployment default.",
      });
      await mutate();
    } catch {
      setMsg({ kind: "err", text: "Network error." });
    } finally {
      setBusy(null);
    }
  }, [headers, mutate]);

  return (
    <main className="min-h-dvh bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-10 space-y-6">
        <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
          <Link
            href="/settings"
            className="inline-flex items-center gap-1 hover:text-[var(--color-text)] transition-colors"
          >
            <ArrowLeft size={12} />
            settings
          </Link>
          <span aria-hidden>/</span>
          <span>data classification</span>
        </div>

        <header className="space-y-1">
          <h1 className="text-[20px] tracking-tight">data classification</h1>
          <p className="text-[13px] text-[var(--color-muted)]">
            Pin this workspace to a sensitivity tier so audit, retention, and
            egress controls agree on how its data must be handled. The active
            label is surfaced on every tenant-bound response as the
            {" "}
            <span className="font-mono text-[12px]">x-data-classification</span>{" "}
            header. Changes are admin-only, MFA-gated, and written to the audit
            log.
          </p>
        </header>

        {error ? (
          <ErrorBox message="Could not load the workspace label." />
        ) : null}
        {msg ? (
          msg.kind === "err" ? (
            <ErrorBox message={msg.text} />
          ) : (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-border)]/20 px-3 py-2 text-[12px] text-[var(--color-text)]">
              {msg.text}
            </div>
          )
        ) : null}

        <Card>
          <CardHeader
            title="current label"
            hint={data ? data.tenant_id : "loading"}
            right={
              <button
                type="button"
                onClick={() => mutate()}
                className="inline-flex items-center gap-1 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)] transition"
                aria-label="Refresh label"
              >
                <ArrowClockwise size={12} />
                refresh
              </button>
            }
          />
          <div className="px-4 py-4 space-y-3">
            {isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-64" />
              </div>
            ) : data ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <ShieldCheck
                    size={16}
                    weight="duotone"
                    className="text-[var(--color-muted)]"
                  />
                  <span className="text-[13px] font-mono">{data.label}</span>
                  {data.pinned ? (
                    <Badge>tenant pin</Badge>
                  ) : (
                    <Badge>default</Badge>
                  )}
                  <span className="text-[11px] text-[var(--color-muted)]">
                    retention floor {data.min_retention_days}d
                  </span>
                </div>
                {data.justification ? (
                  <div className="text-[12px] text-[var(--color-text)] border-l-2 border-[var(--color-border)] pl-3">
                    {data.justification}
                  </div>
                ) : null}
                <div className="flex items-center gap-2 text-[11px] text-[var(--color-muted)]">
                  <Clock size={12} />
                  last change {fmtAbs(data.updated_at)} by{" "}
                  {data.updated_by ?? "n/a"}
                </div>
                <div className="flex items-start gap-2 text-[11px] text-[var(--color-muted)]">
                  <Info size={12} className="mt-0.5 shrink-0" />
                  <span>
                    Deployment default is{" "}
                    <span className="font-mono">{data.default_label}</span>.
                    Downstream PII redaction, retention, and webhook egress
                    filters read this label at runtime.
                  </span>
                </div>
              </>
            ) : null}
          </div>
        </Card>

        <Card>
          <CardHeader title="change label" hint="admin + MFA" />
          <div className="px-4 py-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_180px] gap-3">
              <label className="block">
                <span className="block text-[11px] text-[var(--color-muted)] mb-1">
                  Justification (optional)
                </span>
                <Input
                  type="text"
                  placeholder="e.g. data inventory ID or DPIA reference"
                  value={justification}
                  onChange={(e) => setJustification(e.target.value)}
                  aria-label="Justification"
                  maxLength={1024}
                />
              </label>
              <label className="block">
                <span className="block text-[11px] text-[var(--color-muted)] mb-1">
                  Label
                </span>
                <Select
                  value={label || data?.label || ""}
                  onChange={(e) => setLabel(e.target.value)}
                  aria-label="Sensitivity label"
                >
                  {allowed.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </Select>
              </label>
            </div>

            {effectiveLabel && LABEL_HINT[effectiveLabel] ? (
              <div className="flex items-start gap-2 text-[11px] text-[var(--color-muted)]">
                <Tag size={12} className="mt-0.5 shrink-0" />
                <span>{LABEL_HINT[effectiveLabel]}</span>
              </div>
            ) : null}

            <label className="block">
              <span className="block text-[11px] text-[var(--color-muted)] mb-1">
                Admin MFA code (if enrolled)
              </span>
              <Input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={mfa}
                onChange={(e) => setMfa(e.target.value)}
                aria-label="Admin MFA code"
                maxLength={8}
              />
            </label>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                onClick={() => save("save")}
                disabled={busy !== null}
                aria-label="Save workspace label"
              >
                <FloppyDisk size={14} weight="duotone" />
                {busy === "save" ? "saving" : "save label"}
              </Button>
              <Button
                onClick={() => save("dry")}
                disabled={busy !== null}
                aria-label="Dry run the label change"
              >
                {busy === "dry" ? "checking" : "dry run"}
              </Button>
              <Button
                onClick={clear}
                disabled={busy !== null || !data?.pinned}
                aria-label="Clear workspace label"
              >
                <Trash size={14} weight="duotone" />
                {busy === "clear" ? "clearing" : "clear pin"}
              </Button>
            </div>

            {preview ? (
              <pre className="text-[11px] bg-black/30 border border-[var(--color-border)] rounded-md p-3 overflow-x-auto">
                {JSON.stringify(preview, null, 2)}
              </pre>
            ) : null}
          </div>
        </Card>
      </div>
    </main>
  );
}
