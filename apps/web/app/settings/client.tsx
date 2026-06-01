"use client";

import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import {
  Gear,
  FloppyDisk,
  DownloadSimple,
  Trash,
  Warning,
  CheckCircle,
  UserCircle,
  Bell,
  ShieldWarning,
  ShieldCheck,
  CaretRight,
  UserMinus,
  SignOut,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Button,
  Input,
  ErrorBox,
  Skeleton,
  Badge,
} from "@/components/ui/primitives";

type Settings = {
  version: 1;
  profile: {
    display_name: string;
    contact_email: string;
    org: string;
    timezone: string;
  };
  notifications: {
    email_on_high_risk: boolean;
    email_weekly_digest: boolean;
    webhook_on_run_created: boolean;
    toast_on_long_run: boolean;
  };
  updated_at: number;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function fmtTime(ms: number): string {
  if (!ms) return "never";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-2 md:gap-6 items-start py-3 border-b border-[var(--color-border)]/60 last:border-0">
      <div>
        <div className="text-[12px] font-medium">{label}</div>
        {hint ? (
          <div className="text-[11px] text-[var(--color-muted)] mt-0.5 leading-snug">
            {hint}
          </div>
        ) : null}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex items-start gap-3 py-2 cursor-pointer group">
      <span
        role="switch"
        aria-checked={checked}
        tabIndex={0}
        onClick={() => onChange(!checked)}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            onChange(!checked);
          }
        }}
        className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors mt-0.5 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40 ${
          checked
            ? "bg-[var(--color-accent)]"
            : "bg-[var(--color-border-strong)]"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13px]">{label}</span>
        {hint ? (
          <span className="block text-[11px] text-[var(--color-muted)] mt-0.5">
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export default function SettingsClient() {
  const { data, error, isLoading, mutate } = useSWR<Settings>(
    "/api/settings",
    fetcher,
  );
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // exporting
  const [exporting, setExporting] = useState(false);

  // wiping
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wipeConfirm, setWipeConfirm] = useState("");
  const [wiping, setWiping] = useState(false);
  const [wipeReport, setWipeReport] = useState<{
    removed: string[];
    missing: string[];
  } | null>(null);

  // erasing the signed-in account (GDPR / CCPA right to erasure)
  type ErasePreview = {
    user_id: string;
    email: string;
    can_erase: boolean;
    confirm_phrase: string;
    memberships: Array<{
      workspace_id: string;
      workspace_name: string;
      role: string;
      action: "leave" | "delete_workspace" | "blocked";
      reason?: string;
      other_member_count: number;
    }>;
    blockers: Array<{ workspace_name: string; reason?: string }>;
  };
  const [eraseOpen, setEraseOpen] = useState(false);
  const [erasePreview, setErasePreview] = useState<ErasePreview | null>(null);
  const [erasePreviewErr, setErasePreviewErr] = useState<string | null>(null);
  const [eraseConfirm, setEraseConfirm] = useState("");
  const [erasing, setErasing] = useState(false);
  const [eraseErr, setEraseErr] = useState<string | null>(null);
  const [eraseDone, setEraseDone] = useState(false);

  useEffect(() => {
    if (data && !draft) setDraft(data);
  }, [data, draft]);

  const dirty =
    draft && data && JSON.stringify(draft) !== JSON.stringify(data);

  const onSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile: draft.profile,
          notifications: draft.notifications,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setSaveErr(json?.detail ?? "failed to save");
        return;
      }
      setSavedAt(Date.now());
      mutate(json, false);
      setDraft(json);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "network error");
    } finally {
      setSaving(false);
    }
  }, [draft, mutate]);

  const onExport = useCallback(async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/settings/export");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `adherence-export-${new Date()
        .toISOString()
        .slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }, []);

  const onLoadErasePreview = useCallback(async () => {
    setEraseOpen(true);
    setEraseConfirm("");
    setEraseErr(null);
    setErasePreviewErr(null);
    setErasePreview(null);
    try {
      const res = await fetch("/api/auth/account", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setErasePreviewErr(json?.detail ?? "failed to load preview");
        return;
      }
      setErasePreview(json as ErasePreview);
    } catch (e) {
      setErasePreviewErr(e instanceof Error ? e.message : "network error");
    }
  }, []);

  const onErase = useCallback(async () => {
    if (!erasePreview) return;
    setErasing(true);
    setEraseErr(null);
    try {
      const res = await fetch("/api/auth/account", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: erasePreview.confirm_phrase }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEraseErr(json?.detail ?? `erase failed (${res.status})`);
        return;
      }
      setEraseDone(true);
      // Cookie was cleared server-side; bounce out of the dashboard.
      setTimeout(() => {
        window.location.href = "/login?erased=1";
      }, 1200);
    } catch (e) {
      setEraseErr(e instanceof Error ? e.message : "network error");
    } finally {
      setErasing(false);
    }
  }, [erasePreview]);

  const onWipe = useCallback(async () => {
    setWiping(true);
    try {
      const res = await fetch("/api/settings/wipe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE EVERYTHING" }),
      });
      const json = await res.json();
      if (res.ok) {
        setWipeReport({ removed: json.removed, missing: json.missing });
        setWipeOpen(false);
        setWipeConfirm("");
        mutate();
        setDraft(null);
      }
    } finally {
      setWiping(false);
    }
  }, [mutate]);

  return (
    <div className="min-h-screen">
      <PageHeader
        eyebrow="account"
        title="Settings"
        description="Workspace profile, notification preferences, and your data. Single-tenant by design: one workspace per deployment."
        actions={
          <Button
            variant="accent"
            disabled={!dirty || saving}
            onClick={onSave}
            aria-label="save settings"
          >
            <FloppyDisk weight="duotone" size={14} />
            {saving ? "saving..." : dirty ? "save changes" : "saved"}
          </Button>
        }
      />

      <div className="p-4 md:p-6 grid grid-cols-1 xl:grid-cols-3 gap-4 max-w-6xl">
        {/* PROFILE */}
        <Card className="xl:col-span-2">
          <CardHeader
            title="profile"
            hint="Shown in delivery emails and webhook payloads."
            right={
              <UserCircle
                weight="duotone"
                size={16}
                className="text-[var(--color-accent)]"
              />
            }
          />
          <div className="px-4 py-2">
            {error ? (
              <ErrorBox message="failed to load settings" />
            ) : isLoading || !draft ? (
              <div className="space-y-3 py-3">
                <Skeleton className="h-7 w-full" />
                <Skeleton className="h-7 w-full" />
                <Skeleton className="h-7 w-full" />
              </div>
            ) : (
              <>
                <Row label="Display name" hint="Used in greetings and notifications.">
                  <Input
                    value={draft.profile.display_name}
                    maxLength={80}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        profile: {
                          ...draft.profile,
                          display_name: e.target.value,
                        },
                      })
                    }
                  />
                </Row>
                <Row label="Contact email" hint="Where digest and high-risk emails would be sent.">
                  <Input
                    type="email"
                    placeholder="you@example.org"
                    value={draft.profile.contact_email}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        profile: {
                          ...draft.profile,
                          contact_email: e.target.value,
                        },
                      })
                    }
                  />
                </Row>
                <Row label="Organization">
                  <Input
                    value={draft.profile.org}
                    maxLength={80}
                    placeholder="optional"
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        profile: { ...draft.profile, org: e.target.value },
                      })
                    }
                  />
                </Row>
                <Row label="Timezone" hint="Used to bucket reports and the usage chart.">
                  <Input
                    value={draft.profile.timezone}
                    maxLength={64}
                    placeholder="UTC"
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        profile: {
                          ...draft.profile,
                          timezone: e.target.value,
                        },
                      })
                    }
                  />
                </Row>
              </>
            )}
          </div>
          {saveErr ? (
            <div className="px-4 pb-3">
              <ErrorBox message={saveErr} />
            </div>
          ) : null}
          {savedAt && !dirty ? (
            <div className="px-4 pb-3 flex items-center gap-1.5 text-[11px] text-[var(--color-low)] font-mono">
              <CheckCircle weight="duotone" size={12} />
              saved at {fmtTime(savedAt)}
            </div>
          ) : null}
        </Card>

        {/* SECURITY */}
        <Card>
          <CardHeader
            title="security"
            hint="Two-factor authentication and recovery codes."
            right={
              <ShieldCheck
                weight="duotone"
                size={16}
                className="text-[var(--color-accent)]"
              />
            }
          />
          <a
            href="/settings/security"
            className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-[var(--color-border)]/30 transition-colors group"
          >
            <div className="min-w-0">
              <div className="text-[13px]">Manage two-factor authentication</div>
              <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                Add a TOTP app, view recovery codes, or turn 2FA off.
              </div>
            </div>
            <CaretRight
              size={14}
              className="text-[var(--color-muted)] group-hover:text-[var(--color-text)] shrink-0"
            />
          </a>
          <a
            href="/settings/ip-allowlist"
            className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-border)] hover:bg-[var(--color-border)]/30 transition-colors group"
          >
            <div className="min-w-0">
              <div className="text-[13px]">IP allowlist</div>
              <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                Restrict workspace API and dashboard access to trusted IP and CIDR ranges.
              </div>
            </div>
            <CaretRight
              size={14}
              className="text-[var(--color-muted)] group-hover:text-[var(--color-text)] shrink-0"
            />
          </a>
          <a
            href="/settings/origin-allowlist"
            className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-border)] hover:bg-[var(--color-border)]/30 transition-colors group"
          >
            <div className="min-w-0">
              <div className="text-[13px]">Browser origin allowlist</div>
              <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                Restrict browser API traffic for this workspace to approved origins. Server to server callers are unaffected.
              </div>
            </div>
            <CaretRight
              size={14}
              className="text-[var(--color-muted)] group-hover:text-[var(--color-text)] shrink-0"
            />
          </a>
          <a
            href="/settings/origin-allowlist"
            className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-border)] hover:bg-[var(--color-border)]/30 transition-colors group"
          >
            <div className="min-w-0">
              <div className="text-[13px]">Origin allowlist</div>
              <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                Restrict workspace browser API traffic to a list of trusted Origins.
              </div>
            </div>
            <CaretRight
              size={14}
              className="text-[var(--color-muted)] group-hover:text-[var(--color-text)] shrink-0"
            />
          </a>
          <a
            href="/settings/outbound-host-allowlist"
            className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-border)] hover:bg-[var(--color-border)]/30 transition-colors group"
          >
            <div className="min-w-0">
              <div className="text-[13px]">Outbound webhook host allowlist</div>
              <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                Restrict outbound webhook destinations to a workspace approved list of hostnames.
              </div>
            </div>
            <CaretRight
              size={14}
              className="text-[var(--color-muted)] group-hover:text-[var(--color-text)] shrink-0"
            />
          </a>
          <a
            href="/settings/access-reviews"
            className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-border)] hover:bg-[var(--color-border)]/30 transition-colors group"
          >
            <div className="min-w-0">
              <div className="text-[13px]">Access reviews</div>
              <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                Periodically re-certify workspace members for SOC2 CC6.3 and ISO 27001 A.9.2.5. Snapshot, decide, apply.
              </div>
            </div>
            <CaretRight
              size={14}
              className="text-[var(--color-muted)] group-hover:text-[var(--color-text)] shrink-0"
            />
          </a>
          <a
            href="/settings/retention-policy"
            className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-border)] hover:bg-[var(--color-border)]/30 transition-colors group"
          >
            <div className="min-w-0">
              <div className="text-[13px]">Retention policy</div>
              <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                Per workspace TTLs for predictions, prediction audit, and admin audit log. Tenant scoped sweep with dry run preview.
              </div>
            </div>
            <CaretRight
              size={14}
              className="text-[var(--color-muted)] group-hover:text-[var(--color-text)] shrink-0"
            />
          </a>
          <a
            href="/settings/legal-hold"
            className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-border)] hover:bg-[var(--color-border)]/30 transition-colors group"
          >
            <div className="min-w-0">
              <div className="text-[13px]">Legal hold</div>
              <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                Freeze GDPR erasure and retention sweeps for this workspace during litigation or audit preservation orders.
              </div>
            </div>
            <CaretRight
              size={14}
              className="text-[var(--color-muted)] group-hover:text-[var(--color-text)] shrink-0"
            />
          </a>
          <a
            href="/settings/login-throttle"
            className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-border)] hover:bg-[var(--color-border)]/30 transition-colors group"
          >
            <div className="min-w-0">
              <div className="text-[13px]">Login throttle</div>
              <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                Review and clear active sign-in lockouts protecting magic-link and TOTP endpoints from brute force.
              </div>
            </div>
            <CaretRight
              size={14}
              className="text-[var(--color-muted)] group-hover:text-[var(--color-text)] shrink-0"
            />
          </a>
          <a
            href="/settings/sessions"
            className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-border)] hover:bg-[var(--color-border)]/30 transition-colors group"
          >
            <div className="min-w-0">
              <div className="text-[13px]">Active sessions</div>
              <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                Review every signed-in device and revoke any one of them.
              </div>
            </div>
            <CaretRight
              size={14}
              className="text-[var(--color-muted)] group-hover:text-[var(--color-text)] shrink-0"
            />
          </a>
          <a
            href="/settings/session-policy"
            className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-border)] hover:bg-[var(--color-border)]/30 transition-colors group"
          >
            <div className="min-w-0">
              <div className="text-[13px]">Session policy</div>
              <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                Cap how long a signed-in session is honoured inside this workspace.
              </div>
            </div>
            <CaretRight
              size={14}
              className="text-[var(--color-muted)] group-hover:text-[var(--color-text)] shrink-0"
            />
          </a>
          <a
            href="/settings/data-classification"
            className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-border)] hover:bg-[var(--color-border)]/30 transition-colors group"
          >
            <div className="min-w-0">
              <div className="text-[13px]">Data classification</div>
              <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                Pin this workspace to a sensitivity tier (public, internal, confidential, restricted) for audit, retention, and egress.
              </div>
            </div>
            <CaretRight
              size={14}
              className="text-[var(--color-muted)] group-hover:text-[var(--color-text)] shrink-0"
            />
          </a>
          <a
            href="/settings/model-approval"
            className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-border)] hover:bg-[var(--color-border)]/30 transition-colors group"
          >
            <div className="min-w-0">
              <div className="text-[13px]">Model approval policy</div>
              <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                Pin which model versions are approved for scoring this workspace. Optional enforce mode rejects unapproved versions at the API.
              </div>
            </div>
            <CaretRight
              size={14}
              className="text-[var(--color-muted)] group-hover:text-[var(--color-text)] shrink-0"
            />
          </a>
          <a
            href="/settings/sso-enforcement"
            className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-border)] hover:bg-[var(--color-border)]/30 transition-colors group"
          >
            <div className="min-w-0">
              <div className="text-[13px]">Enforce SSO</div>
              <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                Require corporate SSO sign-in for every human session in this workspace.
              </div>
            </div>
            <CaretRight
              size={14}
              className="text-[var(--color-muted)] group-hover:text-[var(--color-text)] shrink-0"
            />
          </a>
          <a
            href="/settings/sso-group-roles"
            className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-border)] hover:bg-[var(--color-border)]/30 transition-colors group"
          >
            <div className="min-w-0">
              <div className="text-[13px]">SSO group roles</div>
              <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                Map identity provider groups to admin, service, or viewer for this workspace.
              </div>
            </div>
            <CaretRight
              size={14}
              className="text-[var(--color-muted)] group-hover:text-[var(--color-text)] shrink-0"
            />
          </a>
          <a
            href="/settings/security-headers"
            className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-border)] hover:bg-[var(--color-border)]/30 transition-colors group"
          >
            <div className="min-w-0">
              <div className="text-[13px]">HTTP security headers</div>
              <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                Inspect the exact CSP, HSTS, and clickjacking headers we send for a procurement review.
              </div>
            </div>
            <CaretRight
              size={14}
              className="text-[var(--color-muted)] group-hover:text-[var(--color-text)] shrink-0"
            />
          </a>
          <a
            href="/settings/auth-events"
            className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-border)] hover:bg-[var(--color-border)]/30 transition-colors group"
          >
            <div className="min-w-0">
              <div className="text-[13px]">Authentication events</div>
              <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                Append-only sign-in, sign-out, MFA, SSO, and OAuth log. CSV export for SIEM.
              </div>
            </div>
            <CaretRight
              size={14}
              className="text-[var(--color-muted)] group-hover:text-[var(--color-text)] shrink-0"
            />
          </a>
        </Card>

        {/* NOTIFICATIONS */}
        <Card>
          <CardHeader
            title="notifications"
            hint="What we surface and where."
            right={
              <Bell
                weight="duotone"
                size={16}
                className="text-[var(--color-accent)]"
              />
            }
          />
          <div className="px-4 py-1">
            {!draft ? (
              <div className="space-y-3 py-3">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
              </div>
            ) : (
              <>
                <Toggle
                  checked={draft.notifications.email_on_high_risk}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      notifications: {
                        ...draft.notifications,
                        email_on_high_risk: v,
                      },
                    })
                  }
                  label="Email on high-risk score"
                  hint="When p(non-adherence) crosses the high tier."
                />
                <Toggle
                  checked={draft.notifications.email_weekly_digest}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      notifications: {
                        ...draft.notifications,
                        email_weekly_digest: v,
                      },
                    })
                  }
                  label="Weekly activity digest"
                  hint="Runs, errors, and top cohorts each Monday."
                />
                <Toggle
                  checked={draft.notifications.webhook_on_run_created}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      notifications: {
                        ...draft.notifications,
                        webhook_on_run_created: v,
                      },
                    })
                  }
                  label="Fire run.created webhooks"
                  hint="Master switch for all registered endpoints."
                />
                <Toggle
                  checked={draft.notifications.toast_on_long_run}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      notifications: {
                        ...draft.notifications,
                        toast_on_long_run: v,
                      },
                    })
                  }
                  label="In-app toast on slow runs"
                  hint="Heads-up when a batch takes over 2s."
                />
              </>
            )}
          </div>
        </Card>

        {/* DATA EXPORT */}
        <Card className="xl:col-span-2">
          <CardHeader
            title="your data"
            hint="Export or wipe everything this workspace has stored on disk."
          />
          <div className="px-4 py-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">
                Export workspace bundle
              </div>
              <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                One JSON file with runs, API keys (hashes only), usage, shares,
                webhooks, and delivery log.
              </div>
            </div>
            <Button onClick={onExport} disabled={exporting} variant="ghost">
              <DownloadSimple weight="duotone" size={14} />
              {exporting ? "preparing..." : "download .json"}
            </Button>
          </div>
        </Card>

        {/* DANGER ZONE */}
        <Card className="xl:col-span-3 border-[var(--color-danger)]/30">
          <CardHeader
            title="danger zone"
            hint="Irreversible. There is no soft-delete."
            right={
              <ShieldWarning
                weight="duotone"
                size={16}
                className="text-[var(--color-danger)]"
              />
            }
          />
          <div className="px-4 py-4">
            {wipeReport ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-[var(--color-low)]">
                  <CheckCircle weight="duotone" size={16} />
                  <span className="text-[13px]">
                    Wiped {wipeReport.removed.length} file(s).
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {wipeReport.removed.map((f) => (
                    <Badge key={f}>{f}</Badge>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setWipeReport(null)}
                  className="text-[11px] text-[var(--color-muted)] hover:text-[var(--color-fg)] underline"
                >
                  dismiss
                </button>
              </div>
            ) : !wipeOpen ? (
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">
                    Delete all workspace data
                  </div>
                  <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                    Removes runs, API keys, usage history, share links,
                    webhooks, and the delivery log. The web process keeps
                    running.
                  </div>
                </div>
                <Button variant="danger" onClick={() => setWipeOpen(true)}>
                  <Trash weight="duotone" size={14} />
                  delete everything
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-start gap-2 text-[var(--color-danger)]">
                  <Warning weight="duotone" size={18} className="mt-0.5" />
                  <div className="text-[13px]">
                    This cannot be undone. Type{" "}
                    <code className="font-mono px-1 py-0.5 rounded bg-[var(--color-danger)]/10">
                      DELETE EVERYTHING
                    </code>{" "}
                    to confirm.
                  </div>
                </div>
                <Input
                  value={wipeConfirm}
                  onChange={(e) => setWipeConfirm(e.target.value)}
                  placeholder="DELETE EVERYTHING"
                  aria-label="confirmation phrase"
                />
                <div className="flex gap-2">
                  <Button
                    variant="danger"
                    disabled={wipeConfirm !== "DELETE EVERYTHING" || wiping}
                    onClick={onWipe}
                  >
                    {wiping ? "deleting..." : "confirm delete"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setWipeOpen(false);
                      setWipeConfirm("");
                    }}
                  >
                    cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Card>

        {/* GDPR / CCPA: erase the signed-in account */}
        <Card className="xl:col-span-3 border-[var(--color-danger)]/30">
          <CardHeader
            title="delete your account"
            hint="Right to erasure (GDPR Art. 17 / CCPA). Removes you from every workspace and purges your user record."
            right={
              <UserMinus
                weight="duotone"
                size={16}
                className="text-[var(--color-danger)]"
              />
            }
          />
          <div className="px-4 py-4">
            {eraseDone ? (
              <div className="flex items-center gap-2 text-[var(--color-low)]">
                <CheckCircle weight="duotone" size={16} />
                <span className="text-[13px]">
                  Account erased. Redirecting to sign-in...
                </span>
              </div>
            ) : !eraseOpen ? (
              <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">
                    Permanently delete your account
                  </div>
                  <ul className="text-[11px] text-[var(--color-muted)] mt-1 space-y-0.5 list-disc list-inside">
                    <li>Removes your user record and every magic-link token.</li>
                    <li>
                      Removes you from every workspace you belong to (deletes
                      personal workspaces where you are the only member).
                    </li>
                    <li>
                      Tombstones every note you authored (run history stays).
                    </li>
                    <li>
                      Revokes every outstanding session and signs you out
                      everywhere.
                    </li>
                    <li>
                      Refuses if you are the sole owner of a shared workspace;
                      transfer ownership first.
                    </li>
                  </ul>
                </div>
                <Button variant="danger" onClick={onLoadErasePreview}>
                  <UserMinus weight="duotone" size={14} />
                  delete my account
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                {erasePreviewErr ? (
                  <ErrorBox message={erasePreviewErr} />
                ) : !erasePreview ? (
                  <Skeleton className="h-20 w-full" />
                ) : (
                  <>
                    <div className="text-[12px] text-[var(--color-muted)]">
                      Signed in as{" "}
                      <span className="font-mono text-[var(--color-fg)]">
                        {erasePreview.email}
                      </span>
                    </div>
                    {erasePreview.memberships.length === 0 ? (
                      <div className="text-[12px] text-[var(--color-muted)]">
                        No workspace memberships found.
                      </div>
                    ) : (
                      <div className="border border-[var(--color-border)] rounded">
                        <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--color-muted)] border-b border-[var(--color-border)]">
                          workspace impact
                        </div>
                        <ul className="divide-y divide-[var(--color-border)]">
                          {erasePreview.memberships.map((m) => (
                            <li
                              key={m.workspace_id}
                              className="px-3 py-2 flex items-start justify-between gap-3"
                            >
                              <div className="min-w-0">
                                <div className="text-[12px] font-medium truncate">
                                  {m.workspace_name}
                                </div>
                                <div className="text-[10px] text-[var(--color-muted)] mt-0.5">
                                  role {m.role} · {m.other_member_count}{" "}
                                  other member
                                  {m.other_member_count === 1 ? "" : "s"}
                                </div>
                                {m.reason ? (
                                  <div className="text-[10px] text-[var(--color-danger)] mt-1">
                                    {m.reason}
                                  </div>
                                ) : null}
                              </div>
                              <Badge>
                                {m.action === "delete_workspace"
                                  ? "delete workspace"
                                  : m.action === "blocked"
                                  ? "blocked"
                                  : "leave"}
                              </Badge>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {!erasePreview.can_erase ? (
                      <div className="flex items-start gap-2 text-[var(--color-danger)] text-[12px]">
                        <Warning weight="duotone" size={16} className="mt-0.5" />
                        <span>
                          You must transfer ownership of the workspaces above
                          before you can delete your account.
                        </span>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-start gap-2 text-[var(--color-danger)] text-[12px]">
                          <Warning weight="duotone" size={16} className="mt-0.5" />
                          <span>
                            This is irreversible. Type{" "}
                            <code className="font-mono px-1 py-0.5 rounded bg-[var(--color-danger)]/10">
                              {erasePreview.confirm_phrase}
                            </code>{" "}
                            to confirm.
                          </span>
                        </div>
                        <Input
                          value={eraseConfirm}
                          onChange={(e) => setEraseConfirm(e.target.value)}
                          placeholder={erasePreview.confirm_phrase}
                          aria-label="confirmation phrase"
                        />
                      </>
                    )}
                    {eraseErr ? <ErrorBox message={eraseErr} /> : null}
                    <div className="flex gap-2">
                      <Button
                        variant="danger"
                        disabled={
                          !erasePreview.can_erase ||
                          eraseConfirm !== erasePreview.confirm_phrase ||
                          erasing
                        }
                        onClick={onErase}
                      >
                        <SignOut weight="duotone" size={14} />
                        {erasing ? "erasing..." : "confirm and sign out"}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setEraseOpen(false);
                          setEraseConfirm("");
                          setErasePreview(null);
                          setEraseErr(null);
                          setErasePreviewErr(null);
                        }}
                      >
                        cancel
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </Card>

        {data ? (
          <div className="xl:col-span-3 text-[10px] font-mono text-[var(--color-muted)] flex items-center gap-2">
            <Gear weight="duotone" size={12} />
            settings.updated_at = {fmtTime(data.updated_at)}
          </div>
        ) : null}
      </div>
    </div>
  );
}
