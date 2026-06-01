"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowClockwise,
  ShieldCheck,
  ShieldWarning,
  FloppyDisk,
  Trash,
  Info,
  Key,
  Plus,
  X,
} from "@phosphor-icons/react";
import {
  Button,
  Card,
  CardHeader,
  ErrorBox,
  Skeleton,
  Badge,
  Input,
} from "@/components/ui/primitives";

type Policy = {
  tenant_id: string;
  require_sso: boolean;
  break_glass_subjects: string[];
  updated_at: number | null;
  updated_by: string | null;
  max_break_glass_subjects: number;
  max_subject_len: number;
};

const fetcher = (url: string) =>
  fetch(url).then(async (r) => {
    if (!r.ok) {
      const d = (await r.json().catch(() => ({}))) as { detail?: unknown };
      const msg =
        typeof d.detail === "string"
          ? d.detail
          : typeof d.detail === "object" && d.detail !== null
            ? JSON.stringify(d.detail)
            : `HTTP ${r.status}`;
      throw new Error(msg);
    }
    return r.json();
  });

function fmtAbs(sec: number | null): string {
  if (!sec) return "never";
  const d = new Date(sec * 1000);
  return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export default function SsoEnforcementClient() {
  const { data, error, isLoading, mutate } = useSWR<Policy>(
    "/api/workspace/sso-enforcement",
    fetcher,
    { revalidateOnFocus: true },
  );

  const maxSubs = data?.max_break_glass_subjects ?? 5;
  const maxLen = data?.max_subject_len ?? 128;

  const initialRequire = !!data?.require_sso;
  const initialSubs = useMemo(
    () => (data?.break_glass_subjects ?? []).join(", "),
    [data?.break_glass_subjects],
  );

  const [requireSso, setRequireSso] = useState<boolean>(initialRequire);
  const [subsText, setSubsText] = useState<string>(initialSubs);
  const [mfa, setMfa] = useState<string>("");
  const [busy, setBusy] = useState<"save" | "clear" | "dry" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  const [preview, setPreview] = useState<unknown>(null);

  // Light one-shot seeding once the data resolves.
  const seeded = useMemo(() => {
    if (!data) return false;
    return true;
  }, [data]);
  void seeded;

  const subs = useMemo(
    () =>
      subsText
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    [subsText],
  );

  const tooMany = subs.length > maxSubs;
  const tooLong = subs.find((s) => s.length > maxLen);

  const headers = useCallback((): HeadersInit => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (mfa.trim()) h["x-mfa-code"] = mfa.trim();
    return h;
  }, [mfa]);

  const save = useCallback(
    async (mode: "save" | "dry") => {
      setMsg(null);
      setPreview(null);
      if (tooMany) {
        setMsg({
          kind: "err",
          text: `At most ${maxSubs} break-glass subjects allowed.`,
        });
        return;
      }
      if (tooLong) {
        setMsg({
          kind: "err",
          text: `Subject too long (>${maxLen} chars): ${tooLong.slice(0, 32)}...`,
        });
        return;
      }
      setBusy(mode);
      try {
        const qs = mode === "dry" ? "?dry_run=true" : "";
        const r = await fetch(`/api/workspace/sso-enforcement${qs}`, {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({
            require_sso: requireSso,
            break_glass_subjects: subs,
          }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          const detail =
            typeof (body as { detail?: unknown }).detail === "string"
              ? ((body as { detail: string }).detail)
              : `HTTP ${r.status}`;
          if (r.status === 401) {
            setMsg({
              kind: "err",
              text: "Admin MFA required. Enter your authenticator code.",
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
            text: requireSso
              ? "Saved. SSO is now required for this workspace."
              : "Saved. SSO is no longer required.",
          });
          await mutate();
        }
      } catch {
        setMsg({ kind: "err", text: "Network error." });
      } finally {
        setBusy(null);
      }
    },
    [headers, maxLen, maxSubs, mutate, requireSso, subs, tooLong, tooMany],
  );

  const clear = useCallback(async () => {
    if (
      !confirm(
        "Clear the enforce-SSO policy for this workspace? All credential types will be accepted again.",
      )
    ) {
      return;
    }
    setMsg(null);
    setPreview(null);
    setBusy("clear");
    try {
      const r = await fetch("/api/workspace/sso-enforcement", {
        method: "DELETE",
        headers: headers(),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail =
          typeof (body as { detail?: unknown }).detail === "string"
            ? ((body as { detail: string }).detail)
            : `HTTP ${r.status}`;
        if (r.status === 401) {
          setMsg({
            kind: "err",
            text: "Admin MFA required. Enter your authenticator code.",
          });
        } else {
          setMsg({ kind: "err", text: detail });
        }
        return;
      }
      setMsg({ kind: "ok", text: "Policy cleared." });
      setRequireSso(false);
      setSubsText("");
      await mutate();
    } catch {
      setMsg({ kind: "err", text: "Network error." });
    } finally {
      setBusy(null);
    }
  }, [headers, mutate]);

  const removeSubject = useCallback(
    (target: string) => {
      const next = subs.filter((s) => s !== target);
      setSubsText(next.join(", "));
    },
    [subs],
  );

  const addSubjectFromInput = useCallback(
    (raw: string) => {
      const v = raw.trim();
      if (!v) return;
      if (subs.includes(v)) return;
      const next = [...subs, v];
      setSubsText(next.join(", "));
    },
    [subs],
  );

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
          <span>enforce SSO</span>
        </div>

        <header className="space-y-1">
          <h1 className="text-[20px] tracking-tight">enforce SSO</h1>
          <p className="text-[13px] text-[var(--color-muted)]">
            Require corporate SSO sign-in (Okta, Azure AD, Google Workspace)
            for every human session in this workspace. Password and magic-link
            tokens are rejected once this is on. Service-account API keys keep
            working so your CI does not break. Changes are admin-only,
            MFA-gated, and audit-logged.
          </p>
        </header>

        {error ? (
          <ErrorBox message="Could not load the workspace policy." />
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
            title="current policy"
            hint={data ? data.tenant_id : "loading"}
            right={
              <button
                type="button"
                onClick={() => mutate()}
                className="inline-flex items-center gap-1 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)] transition"
                aria-label="Refresh policy"
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
            ) : (
              <>
                <div className="flex items-center gap-2">
                  {data?.require_sso ? (
                    <ShieldCheck
                      size={16}
                      weight="duotone"
                      className="text-[var(--color-accent)]"
                    />
                  ) : (
                    <ShieldWarning
                      size={16}
                      weight="duotone"
                      className="text-[var(--color-muted)]"
                    />
                  )}
                  <span className="text-[13px]">
                    {data?.require_sso
                      ? "SSO is required for this workspace."
                      : "SSO is not enforced. All credential types are accepted."}
                  </span>
                  {data?.require_sso ? (
                    <Badge>enforced</Badge>
                  ) : (
                    <Badge>off</Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[11px] text-[var(--color-muted)]">
                  last change {fmtAbs(data?.updated_at ?? null)} by{" "}
                  {data?.updated_by ?? "n/a"}
                </div>
                {data?.break_glass_subjects?.length ? (
                  <div className="flex items-start gap-2 text-[11px] text-[var(--color-muted)]">
                    <Key size={12} className="mt-0.5 shrink-0" />
                    <span>
                      Break-glass:{" "}
                      <span className="text-[var(--color-text)]">
                        {data.break_glass_subjects.length}
                      </span>{" "}
                      subject{data.break_glass_subjects.length === 1 ? "" : "s"}
                      . Every bypass is logged.
                    </span>
                  </div>
                ) : null}
                <div className="flex items-start gap-2 text-[11px] text-[var(--color-muted)]">
                  <Info size={12} className="mt-0.5 shrink-0" />
                  <span>
                    Enforcement bites on the very next request. Stand up SSO
                    via{" "}
                    <Link
                      href="/settings/security"
                      className="underline hover:text-[var(--color-text)]"
                    >
                      OIDC providers
                    </Link>{" "}
                    before flipping this on.
                  </span>
                </div>
              </>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="set policy" hint="admin + MFA" />
          <div className="px-4 py-4 space-y-4">
            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={requireSso}
                onChange={(e) => setRequireSso(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-[var(--color-border)] bg-transparent accent-[var(--color-accent)]"
                aria-label="Require SSO"
              />
              <span className="text-[13px]">
                Require SSO sign-in for this workspace.
                <span className="block text-[11px] text-[var(--color-muted)] mt-0.5">
                  Only JWTs minted from an OIDC exchange or DB-backed
                  service-account API keys may call the API.
                </span>
              </span>
            </label>

            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] text-[var(--color-muted)]">
                  Break-glass allow-list (up to {maxSubs})
                </span>
                <span className="text-[11px] text-[var(--color-muted)]">
                  {subs.length}/{maxSubs}
                </span>
              </div>
              <SubjectAdder
                disabled={subs.length >= maxSubs}
                onAdd={addSubjectFromInput}
              />
              {subs.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5 pt-1">
                  {subs.map((s) => (
                    <li
                      key={s}
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-border)]/20 px-2 py-1 text-[11px]"
                    >
                      <Key size={11} />
                      <span className="font-mono">{s}</span>
                      <button
                        type="button"
                        onClick={() => removeSubject(s)}
                        aria-label={`Remove ${s}`}
                        className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
                      >
                        <X size={11} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-[11px] text-[var(--color-muted)]">
                  No break-glass subjects. If your IdP goes down with this
                  policy on, the workspace will be locked out.
                </div>
              )}
              {tooMany ? (
                <div className="text-[11px] text-red-400">
                  At most {maxSubs} break-glass subjects allowed.
                </div>
              ) : null}
              {tooLong ? (
                <div className="text-[11px] text-red-400">
                  Subject too long (max {maxLen} chars).
                </div>
              ) : null}
            </div>

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
                disabled={busy !== null || tooMany || !!tooLong}
                aria-label="Save SSO enforcement policy"
              >
                <FloppyDisk size={14} weight="duotone" />
                {busy === "save" ? "saving" : "save policy"}
              </Button>
              <Button
                onClick={() => save("dry")}
                disabled={busy !== null || tooMany || !!tooLong}
                aria-label="Dry run the policy change"
              >
                {busy === "dry" ? "checking" : "dry run"}
              </Button>
              <Button
                onClick={clear}
                disabled={busy !== null}
                aria-label="Clear SSO enforcement policy"
              >
                <Trash size={14} weight="duotone" />
                {busy === "clear" ? "clearing" : "clear policy"}
              </Button>
              <button
                type="button"
                onClick={() => {
                  setRequireSso(!!data?.require_sso);
                  setSubsText((data?.break_glass_subjects ?? []).join(", "));
                }}
                className="text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)] transition px-2 py-1"
              >
                reset to current
              </button>
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

function SubjectAdder({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (s: string) => void;
}) {
  const [val, setVal] = useState("");
  const submit = () => {
    onAdd(val);
    setVal("");
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        disabled={disabled}
        aria-label="Add break-glass subject"
        placeholder="sso:okta:alice@acme.com or api-key:rescue"
      />
      <Button
        onClick={submit}
        disabled={disabled || !val.trim()}
        aria-label="Add subject"
      >
        <Plus size={14} weight="duotone" />
        add
      </Button>
    </div>
  );
}
