"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  Globe,
  CheckCircle,
  Warning,
  Copy,
  TrashSimple,
  Plus,
  ShieldCheck,
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

interface PublicVerifiedDomain {
  domain: string;
  status: "pending" | "verified";
  default_role: "editor" | "viewer";
  auto_join: boolean;
  created_at: number;
  verified_at: number | null;
  verification_record: { host: string; type: "TXT"; value: string };
}

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (r.status === 401) throw new Error("Sign in to manage verified domains.");
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

function fmtDate(ts: number | null): string {
  if (!ts) return "never";
  return new Date(ts).toLocaleString();
}

export default function DomainsClient() {
  const list = useSWR<{ items: WorkspaceListItem[] }>("/api/workspaces", fetcher);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (list.data?.items?.length && !selected) {
      const owned = list.data.items.find((w) => w.role === "owner") ?? list.data.items[0];
      setSelected(owned.id);
    }
  }, [list.data, selected]);

  const domSwr = useSWR<{ role: Role; domains: PublicVerifiedDomain[] }>(
    selected ? `/api/workspaces/${selected}/domains` : null,
    fetcher,
  );
  const role = domSwr.data?.role ?? null;
  const isOwner = role === "owner";
  const domains = domSwr.data?.domains ?? [];

  const [newDomain, setNewDomain] = useState("");
  const [newRole, setNewRole] = useState<"editor" | "viewer">("viewer");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function claim(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !newDomain.trim()) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/workspaces/${selected}/domains`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: newDomain.trim(), default_role: newRole }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.detail ?? `request failed (${r.status})`);
      }
      setNewDomain("");
      await domSwr.mutate();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function patch(domain: string, body: Record<string, unknown>) {
    if (!selected) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(
        `/api/workspaces/${selected}/domains/${encodeURIComponent(domain)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.detail ?? `request failed (${r.status})`);
      }
      await domSwr.mutate();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function unclaim(domain: string) {
    if (!selected) return;
    if (!confirm(`Unclaim ${domain}? New sign-ins from this domain will stop auto-joining.`)) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(
        `/api/workspaces/${selected}/domains/${encodeURIComponent(domain)}`,
        { method: "DELETE" },
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.detail ?? `request failed (${r.status})`);
      }
      await domSwr.mutate();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1400);
    } catch {
      // ignore
    }
  }

  const wsItems = list.data?.items ?? [];

  return (
    <div className="flex flex-col">
      <PageHeader
        eyebrow="team"
        title="Verified domains"
        description="Claim your company email domain and new sign-ins from that domain land in your workspace at the role you pick. No more sending one invite at a time."
        actions={
          <Link
            href="/workspace"
            className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-surface-2)]"
          >
            <ShieldCheck weight="duotone" size={13} /> Back to workspace
          </Link>
        }
      />

      <div className="px-4 md:px-6 pb-10 mx-auto w-full max-w-4xl flex flex-col gap-4">
        <Card>
          <CardHeader title="Workspace" hint="Pick which workspace these domains belong to." />
          <div className="p-4">
            {list.isLoading ? (
              <Skeleton className="h-9 w-64" />
            ) : wsItems.length === 0 ? (
              <Empty title="No workspaces yet" hint="Create one from the workspace page first." />
            ) : (
              <Select
                value={selected ?? ""}
                onChange={(e) => setSelected(e.target.value)}
                className="min-w-[260px]"
              >
                {wsItems.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.role})
                  </option>
                ))}
              </Select>
            )}
          </div>
        </Card>

        {err && <ErrorBox message={err} />}

        <Card>
          <CardHeader
            title="Claimed domains"
            hint={isOwner
              ? "Publish the TXT record we generate, then click Verify. Only verified domains can auto-join."
              : "Read only. Only the workspace owner can change verified domains."}
          />
          <div className="p-4 flex flex-col gap-3">
            {domSwr.isLoading ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : domains.length === 0 ? (
              <Empty
                title="No domains claimed yet"
                hint="Claim your company email domain below to onboard your team in one step."
              />
            ) : (
              domains.map((d) => (
                <div
                  key={d.domain}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 flex flex-col gap-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Globe weight="duotone" size={16} />
                    <span className="font-mono text-[13px]">{d.domain}</span>
                    {d.status === "verified" ? (
                      <Badge tone="success">
                        <CheckCircle weight="duotone" size={11} /> verified
                      </Badge>
                    ) : (
                      <Badge tone="warn">
                        <Warning weight="duotone" size={11} /> pending
                      </Badge>
                    )}
                    {d.auto_join && d.status === "verified" && (
                      <Badge tone="accent">auto-join: {d.default_role}</Badge>
                    )}
                    <span className="ml-auto text-[11px] text-[var(--color-muted)]">
                      claimed {fmtDate(d.created_at)}
                      {d.verified_at ? ` · verified ${fmtDate(d.verified_at)}` : ""}
                    </span>
                  </div>

                  {d.status === "pending" && (
                    <div className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5">
                      <Label>DNS verification record</Label>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[12px]">
                        <div className="flex flex-col gap-1">
                          <span className="text-[var(--color-muted)]">host</span>
                          <MonoChip>{d.verification_record.host}</MonoChip>
                        </div>
                        <div className="flex flex-col gap-1">
                          <span className="text-[var(--color-muted)]">type</span>
                          <MonoChip>TXT</MonoChip>
                        </div>
                        <div className="flex flex-col gap-1">
                          <span className="text-[var(--color-muted)]">value</span>
                          <button
                            type="button"
                            onClick={() => copy(d.verification_record.value, d.domain)}
                            className="inline-flex items-center gap-1 text-left"
                            aria-label="copy TXT value"
                          >
                            <MonoChip>{d.verification_record.value}</MonoChip>
                            <Copy weight="duotone" size={12} />
                          </button>
                        </div>
                      </div>
                      {copied === d.domain && (
                        <div className="text-[11px] text-[var(--color-muted)] mt-1">copied</div>
                      )}
                    </div>
                  )}

                  {isOwner && (
                    <div className="flex flex-wrap items-center gap-2">
                      {d.status === "pending" ? (
                        <Button
                          type="button"
                          disabled={busy}
                          onClick={() => patch(d.domain, {
                            action: "verify",
                            presented_token: d.verification_record.value.split("=")[1],
                          })}
                        >
                          <CheckCircle weight="duotone" size={13} /> Verify ownership
                        </Button>
                      ) : (
                        <>
                          <label className="inline-flex items-center gap-2 text-[12px]">
                            <input
                              type="checkbox"
                              checked={d.auto_join}
                              disabled={busy}
                              onChange={(e) => patch(d.domain, {
                                action: "update",
                                auto_join: e.target.checked,
                              })}
                            />
                            auto-join new sign-ins
                          </label>
                          <Select
                            value={d.default_role}
                            disabled={busy || !d.auto_join}
                            onChange={(e) => patch(d.domain, {
                              action: "update",
                              default_role: e.target.value,
                            })}
                            className="min-w-[120px]"
                          >
                            <option value="viewer">viewer</option>
                            <option value="editor">editor</option>
                          </Select>
                        </>
                      )}
                      <Button
                        type="button"
                        variant="danger"
                        disabled={busy}
                        onClick={() => unclaim(d.domain)}
                        className="ml-auto"
                      >
                        <TrashSimple weight="duotone" size={13} /> Unclaim
                      </Button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </Card>

        {isOwner && (
          <Card>
            <CardHeader title="Claim a domain" hint="Use a domain you control (no gmail.com, outlook.com, etc)." />
            <form onSubmit={claim} className="p-4 flex flex-col gap-3">
              <div className="grid grid-cols-1 md:grid-cols-[1fr_180px_auto] gap-2 items-end">
                <div>
                  <Label>Domain</Label>
                  <Input
                    type="text"
                    value={newDomain}
                    onChange={(e) => setNewDomain(e.target.value)}
                    placeholder="acme.com"
                    autoComplete="off"
                    required
                  />
                </div>
                <div>
                  <Label>Default role for auto-joined users</Label>
                  <Select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as "editor" | "viewer")}
                  >
                    <option value="viewer">viewer</option>
                    <option value="editor">editor</option>
                  </Select>
                </div>
                <Button type="submit" disabled={busy || !newDomain.trim()}>
                  <Plus weight="duotone" size={13} /> Claim
                </Button>
              </div>
              <p className="text-[11px] text-[var(--color-muted)]">
                Claiming a domain creates a TXT record you publish at your DNS provider. We never auto-join anyone until you verify the record AND turn auto-join on.
              </p>
            </form>
          </Card>
        )}
      </div>
    </div>
  );
}
