"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowClockwise,
  Key,
  FloppyDisk,
  Trash,
  ShieldCheck,
  WarningCircle,
  CheckCircle,
  Info,
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorBox,
  Input,
  SectionLabel,
  Select,
  Skeleton,
} from "@/components/ui/primitives";

type Registration = {
  tenant_id: string;
  declared: boolean;
  provider: string | null;
  key_reference: string | null;
  rotation_period_days: number | null;
  state: string | null;
  description: string | null;
  contact: string | null;
  registered_at: number | null;
  registered_by: string | null;
  last_rotated_at: number | null;
  last_rotated_by: string | null;
  rotation_count: number;
  updated_at: number | null;
  updated_by: string | null;
  rotation_due_at: number | null;
  rotation_overdue: boolean;
  allowed_providers: string[];
  allowed_states: string[];
  min_rotation_days: number;
  max_rotation_days: number;
};

const PROVIDER_LABEL: Record<string, string> = {
  aws_kms: "AWS KMS",
  gcp_kms: "Google Cloud KMS",
  azure_keyvault: "Azure Key Vault",
  hashicorp_vault: "HashiCorp Vault",
  other: "Other",
};

const fetcher = (url: string) =>
  fetch(url).then(async (r) => {
    if (!r.ok) {
      const d = (await r.json().catch(() => ({}))) as { detail?: string };
      throw new Error(d.detail ?? `HTTP ${r.status}`);
    }
    return r.json();
  });

function fmtAbs(ts: number | null): string {
  if (!ts) return "never";
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

type Draft = {
  provider: string;
  key_reference: string;
  rotation_period_days: number;
  state: string;
  description: string;
  contact: string;
};

function regToDraft(r: Registration): Draft {
  return {
    provider: r.provider ?? "aws_kms",
    key_reference: r.key_reference ?? "",
    rotation_period_days: r.rotation_period_days ?? 90,
    state: r.state ?? "pending",
    description: r.description ?? "",
    contact: r.contact ?? "",
  };
}

const BLANK_DRAFT: Draft = {
  provider: "aws_kms",
  key_reference: "",
  rotation_period_days: 90,
  state: "pending",
  description: "",
  contact: "",
};

export default function CmekClient() {
  const { data, error, isLoading, mutate } = useSWR<Registration>(
    "/api/workspace/cmek",
    fetcher,
    { revalidateOnFocus: true },
  );

  const seed = useMemo<Draft | null>(
    () => (data ? (data.declared ? regToDraft(data) : BLANK_DRAFT) : null),
    [data],
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [seededFor, setSeededFor] = useState<string>("");

  const seedKey = seed
    ? `${data?.declared ? "y" : "n"}|${seed.provider}|${seed.key_reference}|${seed.rotation_period_days}|${seed.state}|${seed.description}|${seed.contact}`
    : "";
  if (seed && draft === null && seedKey && seededFor !== seedKey) {
    setSeededFor(seedKey);
    setDraft(seed);
  }
  const current: Draft | null = draft ?? seed;

  const [mfa, setMfa] = useState("");
  const [rotateRef, setRotateRef] = useState("");
  const [rotateNote, setRotateNote] = useState("");
  const [busy, setBusy] = useState<
    "save" | "clear" | "dry" | "rotate" | null
  >(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...(d ?? BLANK_DRAFT), [key]: value }));
  }

  async function callPut(dry: boolean) {
    if (!current) return;
    setBusy(dry ? "dry" : "save");
    setMsg(null);
    try {
      const url = `/api/workspace/cmek${dry ? "?dry_run=true" : ""}`;
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...(mfa ? { "x-mfa-code": mfa } : {}),
        },
        body: JSON.stringify({
          provider: current.provider,
          key_reference: current.key_reference.trim(),
          rotation_period_days: Number(current.rotation_period_days),
          state: current.state,
          description: current.description.trim() || null,
          contact: current.contact.trim() || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ kind: "err", text: body?.detail ?? `HTTP ${res.status}` });
        return;
      }
      if (dry) {
        setMsg({
          kind: "ok",
          text: `Dry run: would ${body?.would ?? "apply"} this registration.`,
        });
      } else {
        setMsg({ kind: "ok", text: "Registration saved." });
        await mutate();
        setSeededFor("");
        setDraft(null);
      }
    } catch (e: unknown) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "failed" });
    } finally {
      setBusy(null);
    }
  }

  async function callRotate() {
    setBusy("rotate");
    setMsg(null);
    try {
      const res = await fetch("/api/workspace/cmek/rotate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(mfa ? { "x-mfa-code": mfa } : {}),
        },
        body: JSON.stringify({
          new_key_reference: rotateRef.trim() ? rotateRef.trim() : null,
          note: rotateNote.trim() ? rotateNote.trim() : null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ kind: "err", text: body?.detail ?? `HTTP ${res.status}` });
        return;
      }
      setMsg({ kind: "ok", text: "Rotation recorded." });
      setRotateRef("");
      setRotateNote("");
      await mutate();
      setSeededFor("");
      setDraft(null);
    } catch (e: unknown) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "failed" });
    } finally {
      setBusy(null);
    }
  }

  async function callClear() {
    if (!confirm("Remove the CMEK registration for this workspace?")) return;
    setBusy("clear");
    setMsg(null);
    try {
      const res = await fetch("/api/workspace/cmek", {
        method: "DELETE",
        headers: { ...(mfa ? { "x-mfa-code": mfa } : {}) },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ kind: "err", text: body?.detail ?? `HTTP ${res.status}` });
        return;
      }
      setMsg({ kind: "ok", text: "Registration cleared." });
      await mutate();
      setSeededFor("");
      setDraft(null);
    } catch (e: unknown) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "failed" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6 sm:py-10 space-y-5">
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/settings"
            className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            <ArrowLeft size={14} weight="duotone" /> back to settings
          </Link>
          <button
            onClick={() => mutate()}
            className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
            aria-label="Refresh registration"
          >
            <ArrowClockwise size={14} weight="duotone" /> refresh
          </button>
        </div>

        <header className="space-y-1">
          <div className="flex items-center gap-2">
            <Key size={20} weight="duotone" />
            <h1 className="text-[20px] font-medium tracking-tight">
              Customer-managed encryption key
            </h1>
          </div>
          <p className="text-[13px] text-[var(--color-muted)] max-w-xl">
            Declare the customer-supplied KMS key used for envelope
            encryption in this workspace. Purely a record of intent and
            cadence; mutations are admin-only, MFA-gated, and audit-logged.
          </p>
        </header>

        {error && <ErrorBox message={(error as Error).message} />}

        {isLoading || !data || !current ? (
          <div className="space-y-3">
            <Skeleton className="h-24" />
            <Skeleton className="h-48" />
          </div>
        ) : (
          <>
            <Card>
              <CardHeader
                title="Current registration"
                right={
                  <div className="flex items-center gap-2">
                    {data.declared ? (
                      <Badge tone={data.state === "active" ? "success" : "accent"}>
                        {data.state}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">not declared</Badge>
                    )}
                    {data.rotation_overdue && (
                      <Badge tone="danger">rotation overdue</Badge>
                    )}
                  </div>
                }
              />
              <div className="px-4 py-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-[12.5px]">
                <Row
                  label="Provider"
                  value={
                    data.provider
                      ? PROVIDER_LABEL[data.provider] ?? data.provider
                      : "(none)"
                  }
                />
                <Row
                  label="Rotation cadence"
                  value={
                    data.rotation_period_days
                      ? `${data.rotation_period_days} days`
                      : "(none)"
                  }
                />
                <Row
                  label="Last rotated"
                  value={fmtAbs(data.last_rotated_at)}
                />
                <Row
                  label="Next rotation due"
                  value={fmtAbs(data.rotation_due_at)}
                />
                <Row
                  label="Rotation count"
                  value={String(data.rotation_count)}
                />
                <Row
                  label="Registered by"
                  value={data.registered_by ?? "(unknown)"}
                />
              </div>
              {data.declared && (
                <div className="px-4 pb-3">
                  <SectionLabel>Key reference</SectionLabel>
                  <div className="mt-1 font-mono text-[12px] break-all rounded-md border border-[var(--color-border)] bg-[var(--color-border)]/20 px-2.5 py-2">
                    {data.key_reference}
                  </div>
                </div>
              )}
            </Card>

            <Card>
              <CardHeader
                title={data.declared ? "Update registration" : "Declare a key"}
                right={
                  <span className="text-[11px] text-[var(--color-muted)] inline-flex items-center gap-1">
                    <ShieldCheck size={12} weight="duotone" /> admin + MFA
                  </span>
                }
              />
              <div className="px-4 py-4 space-y-3">
                <Field label="Provider">
                  <Select
                    value={current.provider}
                    onChange={(e) => set("provider", e.target.value)}
                  >
                    {data.allowed_providers.map((p) => (
                      <option key={p} value={p}>
                        {PROVIDER_LABEL[p] ?? p}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Key reference"
                  hint="ARN, resource name, or vault URI. Single line. Never paste raw key material."
                >
                  <Input
                    value={current.key_reference}
                    onChange={(e) => set("key_reference", e.target.value)}
                    placeholder="arn:aws:kms:us-east-1:111122223333:key/abcd..."
                  />
                </Field>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field
                    label="Rotation cadence (days)"
                    hint={`${data.min_rotation_days} to ${data.max_rotation_days} days.`}
                  >
                    <Input
                      type="number"
                      min={data.min_rotation_days}
                      max={data.max_rotation_days}
                      value={current.rotation_period_days}
                      onChange={(e) =>
                        set(
                          "rotation_period_days",
                          Math.max(1, Number(e.target.value) || 0),
                        )
                      }
                    />
                  </Field>
                  <Field label="Lifecycle state">
                    <Select
                      value={current.state}
                      onChange={(e) => set("state", e.target.value)}
                    >
                      {data.allowed_states.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Field
                  label="Description (optional)"
                  hint="Free text shown in this console."
                >
                  <Input
                    value={current.description}
                    onChange={(e) => set("description", e.target.value)}
                  />
                </Field>
                <Field label="Point of contact (optional)">
                  <Input
                    value={current.contact}
                    onChange={(e) => set("contact", e.target.value)}
                    placeholder="security@your-org.example"
                  />
                </Field>
                <Field
                  label="Admin MFA code"
                  hint="Required for any mutation. 6 digits."
                >
                  <Input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={8}
                    value={mfa}
                    onChange={(e) =>
                      setMfa(e.target.value.replace(/\D/g, ""))
                    }
                    placeholder="123456"
                  />
                </Field>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    onClick={() => callPut(false)}
                    disabled={busy !== null || !current.key_reference.trim()}
                  >
                    <FloppyDisk size={14} weight="duotone" />
                    {busy === "save" ? "Saving..." : "Save"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => callPut(true)}
                    disabled={busy !== null || !current.key_reference.trim()}
                  >
                    <Info size={14} weight="duotone" />
                    {busy === "dry" ? "Checking..." : "Dry run"}
                  </Button>
                  {data.declared && (
                    <Button
                      variant="danger"
                      onClick={callClear}
                      disabled={busy !== null}
                    >
                      <Trash size={14} weight="duotone" />
                      {busy === "clear" ? "Clearing..." : "Clear"}
                    </Button>
                  )}
                </div>
              </div>
            </Card>

            {data.declared && data.state === "active" && (
              <Card>
                <CardHeader title="Record a rotation" />
                <div className="px-4 py-4 space-y-3">
                  <p className="text-[12px] text-[var(--color-muted)]">
                    Stamps a rotation event against the audit log. Optionally
                    swap in a new key reference when the rotation produced a
                    fresh key id.
                  </p>
                  <Field label="New key reference (optional)">
                    <Input
                      value={rotateRef}
                      onChange={(e) => setRotateRef(e.target.value)}
                      placeholder="leave blank to keep the same reference"
                    />
                  </Field>
                  <Field label="Note (optional)">
                    <Input
                      value={rotateNote}
                      onChange={(e) => setRotateNote(e.target.value)}
                      placeholder="SEC-1234, change-window 2026-06-15"
                    />
                  </Field>
                  <div>
                    <Button
                      onClick={callRotate}
                      disabled={busy !== null}
                    >
                      <ArrowClockwise size={14} weight="duotone" />
                      {busy === "rotate" ? "Recording..." : "Record rotation"}
                    </Button>
                  </div>
                </div>
              </Card>
            )}

            {msg && (
              <div
                className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[12.5px] ${
                  msg.kind === "ok"
                    ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"
                    : "border-red-500/30 bg-red-500/5 text-red-300"
                }`}
                role="status"
              >
                {msg.kind === "ok" ? (
                  <CheckCircle size={14} weight="duotone" />
                ) : (
                  <WarningCircle size={14} weight="duotone" />
                )}
                <span>{msg.text}</span>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-[var(--color-muted)] min-w-[7rem]">{label}</span>
      <span className="font-mono text-[12px] break-all">{value}</span>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] text-[var(--color-muted)]">{label}</span>
      {children}
      {hint && (
        <span className="block text-[11px] text-[var(--color-muted)]/80">
          {hint}
        </span>
      )}
    </label>
  );
}
