"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import {
  Download,
  FileText,
  Table,
  Package,
  Warning,
  Clock,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Empty,
  Button,
  Select,
  Skeleton,
  ErrorBox,
  Badge,
  MonoChip,
  Stat,
} from "@/components/ui/primitives";

type Role = "owner" | "editor" | "viewer";
type WorkspaceListItem = { id: string; name: string; role: Role };

interface Manifest {
  schema_version: number;
  generated_at: number;
  workspace_id: string;
  workspace_name: string;
  counts: {
    members: number;
    invites: number;
    verified_domains: number;
    audit_entries: number;
    runs: number;
    notes: number;
  };
}

interface PreviewResp {
  dry_run: boolean;
  manifest: Manifest;
}

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (r.status === 401) throw new Error("Sign in to export workspace data.");
  if (r.status === 403) throw new Error("Only workspace owners can export.");
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.detail ?? `request failed (${r.status})`);
  }
  return r.json();
};

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

export default function ExportClient() {
  const list = useSWR<{ items: WorkspaceListItem[] }>("/api/workspaces", fetcher);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<"json" | "csv" | null>(null);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);

  useEffect(() => {
    if (list.data?.items?.length && !selected) {
      const owned = list.data.items.find((w) => w.role === "owner");
      setSelected((owned ?? list.data.items[0]!).id);
    }
  }, [list.data, selected]);

  const preview = useSWR<PreviewResp>(
    selected ? `/api/workspaces/${selected}/export?dry_run=1` : null,
    fetcher,
  );

  const selectedItem = list.data?.items.find((w) => w.id === selected) ?? null;
  const isOwner = selectedItem?.role === "owner";

  async function download(format: "json" | "csv") {
    if (!selected) return;
    setBusy(format);
    setDownloadErr(null);
    try {
      const r = await fetch(
        `/api/workspaces/${selected}/export?format=${format}`,
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.detail ?? `download failed (${r.status})`);
      }
      const blob = await r.blob();
      const cd = r.headers.get("content-disposition") ?? "";
      const m = /filename="([^"]+)"/.exec(cd);
      const filename =
        m?.[1] ?? `workspace-export.${format === "csv" ? "csv" : "json"}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setDownloadErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        eyebrow="workspace"
        title="data export"
        description="Download every workspace record, member, invite, audit entry, run, and note. Owner only. Supports GDPR Article 20 and CCPA portability requests."
      />

      <div className="px-6 py-6 space-y-6">
        {list.error ? <ErrorBox message={(list.error as Error).message} /> : null}

        <Card>
          <CardHeader title="select workspace" />
          <div className="px-4 py-4">
            {!list.data && !list.error ? (
              <Skeleton className="h-10 w-full" />
            ) : list.data && list.data.items.length === 0 ? (
              <Empty
                icon={<Package weight="duotone" className="h-5 w-5" />}
                title="no workspaces yet"
                hint="Create or accept an invite, then come back."
              />
            ) : (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <Select
                  value={selected ?? ""}
                  onChange={(e) => setSelected(e.target.value)}
                  aria-label="Workspace"
                  className="sm:w-72"
                >
                  {(list.data?.items ?? []).map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.role})
                    </option>
                  ))}
                </Select>
                {selectedItem ? (
                  <Badge tone={isOwner ? "success" : "neutral"}>
                    {isOwner ? "owner" : `${selectedItem.role}, read only`}
                  </Badge>
                ) : null}
              </div>
            )}
          </div>
        </Card>

        {selected && !isOwner ? (
          <Card>
            <CardHeader title="permission" />
            <div className="px-4 py-4 flex items-start gap-2 text-sm text-[var(--color-muted)]">
              <Warning weight="duotone" className="h-4 w-4 mt-0.5" />
              <p>
                Workspace export is restricted to owners. Ask an owner to
                download on your behalf, or have your role upgraded.
              </p>
            </div>
          </Card>
        ) : null}

        {selected && isOwner ? (
          <>
            <Card>
              <CardHeader title="contents preview" />
              <div className="px-4 py-4">
                {preview.error ? (
                  <ErrorBox message={(preview.error as Error).message} />
                ) : !preview.data ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <Skeleton key={i} className="h-16 w-full" />
                    ))}
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      <Stat
                        label="members"
                        value={preview.data.manifest.counts.members}
                      />
                      <Stat
                        label="invites"
                        value={preview.data.manifest.counts.invites}
                      />
                      <Stat
                        label="verified domains"
                        value={preview.data.manifest.counts.verified_domains}
                      />
                      <Stat
                        label="audit entries"
                        value={preview.data.manifest.counts.audit_entries}
                      />
                      <Stat
                        label="runs"
                        value={preview.data.manifest.counts.runs}
                      />
                      <Stat
                        label="notes"
                        value={preview.data.manifest.counts.notes}
                      />
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
                      <Clock weight="duotone" className="h-3.5 w-3.5" />
                      preview generated {fmtTs(preview.data.manifest.generated_at)}
                      <MonoChip>
                        schema v{preview.data.manifest.schema_version}
                      </MonoChip>
                    </div>
                  </>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="download" />
              <div className="px-4 py-4">
                <p className="text-sm text-[var(--color-muted)] mb-4">
                  JSON contains the full bundle. CSV is a flat runs export for
                  spreadsheets. Both downloads are logged to the workspace
                  audit trail.
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    onClick={() => download("json")}
                    disabled={busy !== null}
                  >
                    <FileText weight="duotone" className="h-3.5 w-3.5" />
                    {busy === "json" ? "preparing..." : "download json bundle"}
                  </Button>
                  <Button
                    onClick={() => download("csv")}
                    disabled={busy !== null}
                    variant="ghost"
                  >
                    <Table weight="duotone" className="h-3.5 w-3.5" />
                    {busy === "csv" ? "preparing..." : "download runs csv"}
                  </Button>
                  <a
                    href={
                      selected
                        ? `/api/workspaces/${selected}/export?dry_run=1`
                        : "#"
                    }
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium border border-[var(--color-border-strong)] text-[var(--color-fg)] hover:bg-[var(--color-border)]/40"
                  >
                    <Download weight="duotone" className="h-3.5 w-3.5" />
                    view manifest json
                  </a>
                </div>
                {downloadErr ? (
                  <div className="mt-3">
                    <ErrorBox message={downloadErr} />
                  </div>
                ) : null}
              </div>
            </Card>

            <Card>
              <CardHeader title="notes" />
              <ul className="px-4 py-4 space-y-2 text-sm text-[var(--color-muted)]">
                <li>
                  Bundle covers data the workspace owns: members, invites,
                  verified domains, SSO config (public projection), security
                  policy, audit entries scoped to the workspace, and runs and
                  notes authored by current members.
                </li>
                <li>
                  Install-scoped resources (API keys, webhooks, schedules)
                  belong to the deployment, not the workspace, and are not
                  included. Use the install admin console for those.
                </li>
                <li>
                  For destructive workflows (right to be forgotten), see the
                  account erase action under settings.
                </li>
              </ul>
            </Card>
          </>
        ) : null}
      </div>
    </div>
  );
}
