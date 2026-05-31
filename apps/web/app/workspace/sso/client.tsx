"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  Key,
  Lock,
  ArrowSquareOut,
  TrashSimple,
  FloppyDisk,
  Warning,
  CheckCircle,
  Plus,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Empty,
  Button,
  Input,
  Select,
  Skeleton,
  ErrorBox,
  MonoChip,
  Badge,
} from "@/components/ui/primitives";

type Role = "owner" | "editor" | "viewer";
type WorkspaceListItem = { id: string; name: string; role: Role };

interface PublicSso {
  provider: "oidc";
  label: string;
  issuer: string;
  client_id: string;
  allowed_email_domains: string[];
  enforce: boolean;
  updated_at: number;
  has_client_secret: boolean;
}

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (r.status === 401) throw new Error("Sign in to manage SSO.");
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.detail ?? `request failed (${r.status})`);
  }
  return r.json();
};

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)] mb-1.5">
      {children}
    </div>
  );
}

export default function SsoClient() {
  const list = useSWR<{ items: WorkspaceListItem[] }>("/api/workspaces", fetcher);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (list.data?.items?.length && !selected) {
      const owned = list.data.items.find((w) => w.role === "owner") ?? list.data.items[0];
      setSelected(owned.id);
    }
  }, [list.data, selected]);

  const ssoSwr = useSWR<{ sso: PublicSso | null; role: Role }>(
    selected ? `/api/workspaces/${selected}/sso` : null,
    fetcher,
  );

  const role = ssoSwr.data?.role ?? null;
  const sso = ssoSwr.data?.sso ?? null;
  const isOwner = role === "owner";

  const [label, setLabel] = useState("");
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [domains, setDomains] = useState("");
  const [enforce, setEnforce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    setErr(null);
    setOk(null);
    if (sso) {
      setLabelState(sso);
    } else {
      setLabel("");
      setIssuer("");
      setClientId("");
      setClientSecret("");
      setDomains("");
      setEnforce(false);
    }
    function setLabelState(s: PublicSso) {
      setLabel(s.label);
      setIssuer(s.issuer);
      setClientId(s.client_id);
      setClientSecret("");
      setDomains(s.allowed_email_domains.join(", "));
      setEnforce(s.enforce);
    }
  }, [sso, selected]);

  const startUrl = useMemo(
    () => (selected ? `/api/auth/sso/start?workspace=${encodeURIComponent(selected)}` : null),
    [selected],
  );

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      if (!clientSecret.trim()) {
        throw new Error("Client secret is required. Re-enter it to save changes.");
      }
      const body = {
        label: label.trim(),
        issuer: issuer.trim(),
        client_id: clientId.trim(),
        client_secret: clientSecret.trim(),
        allowed_email_domains: domains
          .split(/[\s,]+/)
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean),
        enforce,
      };
      const r = await fetch(`/api/workspaces/${selected}/sso`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail ?? `save failed (${r.status})`);
      setOk("SSO configuration saved.");
      setClientSecret("");
      ssoSwr.mutate();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!selected) return;
    if (!confirm("Remove SSO configuration? Members will fall back to magic link.")) return;
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const r = await fetch(`/api/workspaces/${selected}/sso`, { method: "DELETE" });
      if (!r.ok) throw new Error("delete failed");
      setOk("SSO configuration removed.");
      ssoSwr.mutate();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="security // single sign-on"
        title="Single sign-on (OIDC)"
        description="Route your workspace through Google Workspace, Okta, Azure AD, or any OIDC provider. Enforce mode blocks magic link and OAuth for your email domains."
        actions={
          <Link
            href="/workspace"
            className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-surface-2)]"
          >
            <Plus weight="duotone" size={13} /> Members and invites
          </Link>
        }
      />

      <div className="mx-auto grid w-full max-w-[820px] gap-4 p-4 md:p-6">
        <Card>
          <CardHeader title="workspace" hint="Only the owner can change SSO." />
          <div className="p-4">
            {list.isLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : list.error ? (
              <ErrorBox message={(list.error as Error).message} />
            ) : (list.data?.items?.length ?? 0) === 0 ? (
              <Empty
                title="No workspaces yet"
                hint="Create one from the workspace page to set up SSO."
              />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={selected ?? ""}
                  onChange={(e) => setSelected(e.target.value)}
                  aria-label="Workspace"
                >
                  {list.data!.items.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.role})
                    </option>
                  ))}
                </Select>
                {role ? (
                  <Badge tone={isOwner ? "accent" : "neutral"}>{role}</Badge>
                ) : null}
                {sso ? (
                  <Badge tone={sso.enforce ? "danger" : "warn"}>
                    {sso.enforce ? "enforce on" : "optional"}
                  </Badge>
                ) : (
                  <Badge tone="neutral">not configured</Badge>
                )}
              </div>
            )}
          </div>
        </Card>

        {selected ? (
          <Card>
            <CardHeader
              title="oidc provider"
              hint="Discovery via {issuer}/.well-known/openid-configuration."
              right={
                sso ? (
                  <MonoChip>updated {new Date(sso.updated_at).toLocaleString()}</MonoChip>
                ) : null
              }
            />
            <div className="p-4">
              {ssoSwr.isLoading ? (
                <div className="grid gap-2">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : ssoSwr.error ? (
                <ErrorBox message={(ssoSwr.error as Error).message} />
              ) : (
                <form onSubmit={save} className="grid gap-3">
                  <div>
                    <Label>Label</Label>
                    <Input
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      disabled={!isOwner || busy}
                      placeholder="Acme Okta"
                    />
                  </div>
                  <div>
                    <Label>
                      Issuer URL <span className="text-[var(--color-muted)]">(https://...)</span>
                    </Label>
                    <Input
                      value={issuer}
                      onChange={(e) => setIssuer(e.target.value)}
                      disabled={!isOwner || busy}
                      placeholder="https://accounts.google.com"
                      inputMode="url"
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <Label>Client ID</Label>
                      <Input
                        value={clientId}
                        onChange={(e) => setClientId(e.target.value)}
                        disabled={!isOwner || busy}
                        autoComplete="off"
                      />
                    </div>
                    <div>
                      <Label>
                        Client secret{" "}
                        {sso?.has_client_secret ? (
                          <span className="text-[var(--color-muted)]">(re-enter to update)</span>
                        ) : null}
                      </Label>
                      <Input
                        type="password"
                        value={clientSecret}
                        onChange={(e) => setClientSecret(e.target.value)}
                        disabled={!isOwner || busy}
                        autoComplete="new-password"
                        placeholder={sso?.has_client_secret ? "stored, hidden" : ""}
                      />
                    </div>
                  </div>
                  <div>
                    <Label>
                      Allowed email domains{" "}
                      <span className="text-[var(--color-muted)]">(comma or space separated)</span>
                    </Label>
                    <Input
                      value={domains}
                      onChange={(e) => setDomains(e.target.value)}
                      disabled={!isOwner || busy}
                      placeholder="acme.com, acme.io"
                    />
                  </div>
                  <label className="flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
                    <input
                      type="checkbox"
                      checked={enforce}
                      onChange={(e) => setEnforce(e.target.checked)}
                      disabled={!isOwner || busy}
                      className="mt-0.5"
                    />
                    <span className="flex-1">
                      <span className="block text-[13px] font-medium">
                        <Lock
                          weight="duotone"
                          size={13}
                          className="mr-1 inline align-[-1px] text-[var(--color-warn)]"
                        />
                        Enforce SSO for these domains
                      </span>
                      <span className="block text-[12px] text-[var(--color-muted)]">
                        Magic link and GitHub OAuth will be refused for users whose email matches. Verify the SSO flow end to end before turning this on.
                      </span>
                    </span>
                  </label>

                  {err ? <ErrorBox message={err} /> : null}
                  {ok ? (
                    <div
                      role="status"
                      className="flex items-center gap-2 rounded-md border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 px-3 py-2 text-[12px]"
                    >
                      <CheckCircle
                        weight="duotone"
                        size={14}
                        className="text-[var(--color-success)]"
                      />
                      {ok}
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="submit" disabled={!isOwner || busy}>
                      <FloppyDisk weight="duotone" size={13} /> Save SSO config
                    </Button>
                    {sso ? (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={remove}
                        disabled={!isOwner || busy}
                      >
                        <TrashSimple weight="duotone" size={13} /> Remove
                      </Button>
                    ) : null}
                    {startUrl ? (
                      <a
                        href={startUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-auto inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-surface-2)]"
                      >
                        <ArrowSquareOut weight="duotone" size={13} /> Test login
                      </a>
                    ) : null}
                  </div>
                  {!isOwner ? (
                    <p className="flex items-center gap-1 text-[12px] text-[var(--color-muted)]">
                      <Warning weight="duotone" size={13} /> Only the workspace owner can change SSO.
                    </p>
                  ) : null}
                </form>
              )}
            </div>
          </Card>
        ) : null}

        <Card>
          <CardHeader title="provider quick reference" hint="Always trust your IdP admin console." />
          <div className="p-4">
            <ul className="grid gap-1.5 text-[12px] font-mono text-[var(--color-fg)]">
              <li>
                <span className="text-[var(--color-muted)]">Google Workspace</span>{" "}
                https://accounts.google.com
              </li>
              <li>
                <span className="text-[var(--color-muted)]">Okta</span>{" "}
                https://&lt;tenant&gt;.okta.com/oauth2/default
              </li>
              <li>
                <span className="text-[var(--color-muted)]">Azure AD</span>{" "}
                https://login.microsoftonline.com/&lt;tenant-id&gt;/v2.0
              </li>
              <li>
                <span className="text-[var(--color-muted)]">Auth0</span>{" "}
                https://&lt;tenant&gt;.auth0.com/
              </li>
            </ul>
            <p className="mt-3 flex items-center gap-1 text-[12px] text-[var(--color-muted)]">
              <Key weight="duotone" size={13} />
              Set the redirect URI in your IdP to{" "}
              <MonoChip>/api/auth/sso/callback</MonoChip>
              under this app's origin.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
