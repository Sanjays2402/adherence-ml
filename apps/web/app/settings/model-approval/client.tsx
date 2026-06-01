"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  ShieldCheck,
  CheckCircle,
  XCircle,
  FloppyDisk,
  Trash,
  Plus,
  Info,
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

type Mode = {
  tenant_id: string;
  mode: "disabled" | "audit" | "enforce";
  pinned: boolean;
  updated_at: number | null;
  updated_by: string | null;
  default_mode: string;
  allowed_modes: string[];
  approved_versions: number;
  max_approved_versions: number;
};

type Version = {
  id: number;
  tenant_id: string;
  model_name: string;
  model_version: string;
  approved_at: number;
  approved_by: string | null;
  note: string | null;
};

type VersionList = {
  tenant_id: string;
  n: number;
  items: Version[];
};

const fetcher = (url: string) =>
  fetch(url).then(async (r) => {
    if (!r.ok) {
      const d = (await r.json().catch(() => ({}))) as { detail?: string };
      throw new Error(
        typeof d.detail === "string" ? d.detail : `HTTP ${r.status}`,
      );
    }
    return r.json();
  });

const MODE_HINT: Record<string, string> = {
  disabled:
    "Any registered version may score. Useful for new tenants or demos.",
  audit:
    "Predictions go through. Unapproved versions are recorded in the admin audit log so you can build a change ticket before enforcing.",
  enforce:
    "Predictions are rejected with HTTP 422 when the resolved model version is not on the approved list for this workspace.",
};

function fmtAbs(sec: number | null): string {
  if (!sec) return "never";
  return new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export default function ModelApprovalClient() {
  const mode = useSWR<Mode>("/api/workspace/model-approval", fetcher, {
    revalidateOnFocus: true,
  });
  const versions = useSWR<VersionList>(
    "/api/workspace/model-approval/versions",
    fetcher,
    { revalidateOnFocus: true },
  );

  const [selectedMode, setSelectedMode] = useState<string>("");
  const [mfa, setMfa] = useState<string>("");
  const [newName, setNewName] = useState<string>("default");
  const [newVersion, setNewVersion] = useState<string>("");
  const [newNote, setNewNote] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  const data = mode.data;
  const allowed = data?.allowed_modes ?? ["disabled", "audit", "enforce"];
  const effectiveMode = selectedMode || data?.mode || "disabled";

  const authHeaders = useCallback((): HeadersInit => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (mfa.trim()) h["x-mfa-code"] = mfa.trim();
    return h;
  }, [mfa]);

  const handle401_403 = (status: number, detail: string) => {
    if (status === 401) {
      setMsg({
        kind: "err",
        text: "Admin MFA required. Enter your authenticator code above.",
      });
    } else if (status === 403) {
      setMsg({
        kind: "err",
        text: "Admin role required to change this policy.",
      });
    } else {
      setMsg({ kind: "err", text: detail });
    }
  };

  const saveMode = useCallback(
    async (dry: boolean) => {
      setMsg(null);
      setBusy(dry ? "dry" : "save");
      try {
        const qs = dry ? "?dry_run=true" : "";
        const r = await fetch(`/api/workspace/model-approval${qs}`, {
          method: "PUT",
          headers: authHeaders(),
          body: JSON.stringify({ mode: effectiveMode }),
        });
        const body = (await r.json().catch(() => ({}))) as {
          detail?: string;
          dry_run?: boolean;
        };
        if (!r.ok) {
          handle401_403(
            r.status,
            typeof body.detail === "string" ? body.detail : `HTTP ${r.status}`,
          );
          return;
        }
        if (dry) {
          setMsg({
            kind: "ok",
            text: `Dry run only. Would set mode to ${effectiveMode}.`,
          });
        } else {
          setMsg({ kind: "ok", text: `Saved. Mode is now ${effectiveMode}.` });
          setSelectedMode("");
          await mode.mutate();
        }
      } catch {
        setMsg({ kind: "err", text: "Network error." });
      } finally {
        setBusy(null);
      }
    },
    [authHeaders, effectiveMode, mode],
  );

  const approveVersion = useCallback(async () => {
    setMsg(null);
    if (!newName.trim() || !newVersion.trim()) {
      setMsg({
        kind: "err",
        text: "Model name and model version are required.",
      });
      return;
    }
    setBusy("approve");
    try {
      const r = await fetch("/api/workspace/model-approval/versions", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model_name: newName.trim(),
          model_version: newVersion.trim(),
          note: newNote.trim() || null,
        }),
      });
      const body = (await r.json().catch(() => ({}))) as { detail?: string };
      if (!r.ok) {
        handle401_403(
          r.status,
          typeof body.detail === "string" ? body.detail : `HTTP ${r.status}`,
        );
        return;
      }
      setMsg({
        kind: "ok",
        text: `Approved ${newName.trim()} ${newVersion.trim()}.`,
      });
      setNewVersion("");
      setNewNote("");
      await Promise.all([versions.mutate(), mode.mutate()]);
    } catch {
      setMsg({ kind: "err", text: "Network error." });
    } finally {
      setBusy(null);
    }
  }, [authHeaders, mode, newName, newNote, newVersion, versions]);

  const revokeVersion = useCallback(
    async (v: Version) => {
      if (
        !confirm(
          `Revoke approval for ${v.model_name} ${v.model_version}? Predictions on this version will be blocked while enforce mode is on.`,
        )
      ) {
        return;
      }
      setMsg(null);
      setBusy(`rev-${v.id}`);
      try {
        const path = `/api/workspace/model-approval/versions/${encodeURIComponent(v.model_name)}/${encodeURIComponent(v.model_version)}`;
        const r = await fetch(path, {
          method: "DELETE",
          headers: authHeaders(),
        });
        const body = (await r.json().catch(() => ({}))) as { detail?: string };
        if (!r.ok) {
          handle401_403(
            r.status,
            typeof body.detail === "string" ? body.detail : `HTTP ${r.status}`,
          );
          return;
        }
        setMsg({
          kind: "ok",
          text: `Revoked ${v.model_name} ${v.model_version}.`,
        });
        await Promise.all([versions.mutate(), mode.mutate()]);
      } catch {
        setMsg({ kind: "err", text: "Network error." });
      } finally {
        setBusy(null);
      }
    },
    [authHeaders, mode, versions],
  );

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      <div>
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
        >
          <ArrowLeft size={14} weight="duotone" />
          back to settings
        </Link>
        <h1 className="mt-3 text-[20px] font-semibold tracking-tight flex items-center gap-2">
          <ShieldCheck size={20} weight="duotone" />
          Model approval policy
        </h1>
        <p className="mt-1 text-[13px] text-[var(--color-muted)] max-w-2xl">
          Govern which model versions may score this workspace. Buyers under
          HIPAA, SOC2, or ISO 27001 change control require an enforceable
          allowlist. Optional enforce mode rejects unapproved versions at the
          predict API.
        </p>
      </div>

      {mode.error ? <ErrorBox message={String(mode.error)} /> : null}
      {msg ? (
        <div
          role="status"
          className={`text-[12px] rounded-md border px-3 py-2 ${
            msg.kind === "ok"
              ? "border-emerald-700/40 bg-emerald-500/10 text-emerald-200"
              : "border-rose-700/40 bg-rose-500/10 text-rose-200"
          }`}
        >
          {msg.text}
        </div>
      ) : null}

      <Card>
        <CardHeader title="Enforcement mode" />
        <div className="p-4 space-y-4">
          {mode.isLoading || !data ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className="text-[var(--color-muted)]">
                  Current mode:
                </span>
                <Badge
                  tone={
                    data.mode === "enforce"
                      ? "danger"
                      : data.mode === "audit"
                        ? "warn"
                        : "neutral"
                  }
                >
                  {data.mode}
                </Badge>
                {data.pinned ? (
                  <span className="text-[11px] text-[var(--color-muted)]">
                    set by {data.updated_by ?? "unknown"} on{" "}
                    {fmtAbs(data.updated_at)}
                  </span>
                ) : (
                  <span className="text-[11px] text-[var(--color-muted)]">
                    deployment default
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-3 items-start">
                <div>
                  <label className="text-[12px] font-medium">Mode</label>
                  <Select
                    value={effectiveMode}
                    onChange={(e) => setSelectedMode(e.target.value)}
                    aria-label="Enforcement mode"
                  >
                    {allowed.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </Select>
                  <p className="mt-2 text-[11px] text-[var(--color-muted)] leading-snug">
                    <Info
                      size={12}
                      weight="duotone"
                      className="inline mr-1 -mt-0.5"
                    />
                    {MODE_HINT[effectiveMode] ?? ""}
                  </p>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="text-[12px] font-medium">
                      Admin MFA code
                    </label>
                    <Input
                      value={mfa}
                      onChange={(e) => setMfa(e.target.value)}
                      inputMode="numeric"
                      placeholder="6-digit code"
                      autoComplete="one-time-code"
                      aria-label="Admin MFA code"
                    />
                    <p className="mt-1 text-[11px] text-[var(--color-muted)]">
                      Required for any mutation when your account has MFA
                      enrolled.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => saveMode(false)}
                      disabled={busy !== null || effectiveMode === data.mode}
                    >
                      <FloppyDisk size={14} weight="duotone" />
                      {busy === "save" ? "Saving…" : "Save mode"}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => saveMode(true)}
                      disabled={busy !== null}
                    >
                      {busy === "dry" ? "Checking…" : "Dry run"}
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Approved model versions"
          right={
            data ? (
              <span className="text-[11px] text-[var(--color-muted)]">
                {data.approved_versions} / {data.max_approved_versions}
              </span>
            ) : null
          }
        />
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_2fr_auto] gap-2 items-end">
            <div>
              <label className="text-[12px] font-medium">Model name</label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="default"
                aria-label="Model name"
              />
            </div>
            <div>
              <label className="text-[12px] font-medium">Model version</label>
              <Input
                value={newVersion}
                onChange={(e) => setNewVersion(e.target.value)}
                placeholder="e.g. v1.2.3"
                aria-label="Model version"
              />
            </div>
            <div>
              <label className="text-[12px] font-medium">
                Note (optional)
              </label>
              <Input
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                placeholder="CAB ticket or justification"
                aria-label="Approval note"
              />
            </div>
            <Button
              onClick={approveVersion}
              disabled={busy !== null}
            >
              <Plus size={14} weight="duotone" />
              {busy === "approve" ? "Approving…" : "Approve"}
            </Button>
          </div>

          {versions.error ? (
            <ErrorBox message={String(versions.error)} />
          ) : versions.isLoading || !versions.data ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : versions.data.items.length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--color-border)] px-4 py-8 text-center">
              <XCircle
                size={20}
                weight="duotone"
                className="mx-auto text-[var(--color-muted)]"
              />
              <div className="mt-2 text-[13px]">No approved versions yet.</div>
              <div className="mt-1 text-[11px] text-[var(--color-muted)]">
                With enforce mode on, every predict call will be rejected
                until you approve at least one version.
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead className="text-left text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Model</th>
                    <th className="py-2 pr-3 font-medium">Version</th>
                    <th className="py-2 pr-3 font-medium">Approved</th>
                    <th className="py-2 pr-3 font-medium">By</th>
                    <th className="py-2 pr-3 font-medium">Note</th>
                    <th className="py-2 pr-3 font-medium text-right">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {versions.data.items.map((v) => (
                    <tr
                      key={v.id}
                      className="border-t border-[var(--color-border)]/60"
                    >
                      <td className="py-2 pr-3 font-mono">{v.model_name}</td>
                      <td className="py-2 pr-3 font-mono">
                        <span className="inline-flex items-center gap-1">
                          <CheckCircle
                            size={12}
                            weight="duotone"
                            className="text-emerald-400"
                          />
                          {v.model_version}
                        </span>
                      </td>
                      <td className="py-2 pr-3">{fmtAbs(v.approved_at)}</td>
                      <td className="py-2 pr-3 truncate max-w-[160px]">
                        {v.approved_by ?? "unknown"}
                      </td>
                      <td className="py-2 pr-3 truncate max-w-[240px]">
                        {v.note ?? ""}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        <Button
                          variant="ghost"
                          onClick={() => revokeVersion(v)}
                          disabled={busy !== null}
                        >
                          <Trash size={14} weight="duotone" />
                          {busy === `rev-${v.id}` ? "Revoking…" : "Revoke"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </main>
  );
}
