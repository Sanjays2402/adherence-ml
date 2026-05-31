"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import {
  Key,
  Copy,
  Check,
  Trash,
  Plus,
  Terminal,
  Warning,
  ShieldCheck,
  ArrowsClockwise,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Button,
  Input,
  Empty,
  ErrorBox,
  Skeleton,
  Badge,
  MonoChip,
} from "@/components/ui/primitives";

type Scope = "predict" | "read" | "webhooks";

type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
  revoked: boolean;
  rotated_at: number | null;
  scopes: Scope[];
  expires_at: number | null;
  expired: boolean;
};

type ListResp = { keys: KeyRow[]; available_scopes: Scope[]; ttl_presets_days: number[] };

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function fmt(ms: number | null): string {
  if (!ms) return "never";
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function relativeFromNow(ms: number | null): string {
  if (!ms) return "never";
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  if (abs < hour) return diff >= 0 ? "<1h" : "expired";
  if (abs < day) {
    const h = Math.round(abs / hour);
    return diff >= 0 ? `in ${h}h` : `${h}h ago`;
  }
  const d = Math.round(abs / day);
  return diff >= 0 ? `in ${d}d` : `${d}d ago`;
}

function CopyBtn({ text, label = "copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* noop */
        }
      }}
      className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
      aria-label={label}
    >
      {done ? <Check weight="bold" size={12} /> : <Copy weight="duotone" size={12} />}
      {done ? "copied" : label}
    </button>
  );
}

export default function KeysClient() {
  const { data, error, isLoading, mutate } = useSWR<ListResp>("/api/keys", fetcher, {
    refreshInterval: 0,
  });
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["predict", "read"]);
  // null = never expires; number = days until expiry
  const [ttlDays, setTtlDays] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ name: string; key: string; scopes?: Scope[]; rotated?: boolean } | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [rotatingId, setRotatingId] = useState<string | null>(null);

  const onCreate = useCallback(async () => {
    setCreateErr(null);
    if (!name.trim()) {
      setCreateErr("name is required");
      return;
    }
    if (scopes.length === 0) {
      setCreateErr("pick at least one scope");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), scopes, ttl_days: ttlDays }),
      });
      const json = await res.json();
      if (!res.ok) {
        setCreateErr(json?.detail ?? "failed to create key");
        return;
      }
      setIssued({ name: json.name, key: json.key, scopes: json.scopes });
      setName("");
      mutate();
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : "network error");
    } finally {
      setCreating(false);
    }
  }, [name, scopes, ttlDays, mutate]);

  const onRevoke = useCallback(
    async (id: string) => {
      setRevokingId(id);
      try {
        // Enterprise dry-run: ask the API what would happen before we commit.
        // This proves the destructive call is reviewable and gives the
        // operator a final, server-authored summary to confirm against.
        let summary = "This will immediately invalidate the key.";
        try {
          const previewRes = await fetch(`/api/keys/${id}?dry_run=true`, {
            method: "DELETE",
          });
          if (previewRes.ok) {
            const preview = await previewRes.json();
            if (preview?.preview?.summary) summary = preview.preview.summary;
          }
        } catch {
          /* preview is advisory; fall through to confirmation */
        }
        if (!confirm(`Revoke this key?\n\n${summary}`)) {
          return;
        }
        await fetch(`/api/keys/${id}`, { method: "DELETE" });
        mutate();
      } finally {
        setRevokingId(null);
      }
    },
    [mutate],
  );

  const onRotate = useCallback(
    async (k: KeyRow) => {
      if (
        !confirm(
          `Rotate "${k.name}"? The old secret stops working immediately. Make sure you can update every client that uses it.`,
        )
      ) {
        return;
      }
      setRotatingId(k.id);
      try {
        const res = await fetch(`/api/keys/${k.id}/rotate`, { method: "POST" });
        const json = await res.json();
        if (!res.ok) {
          alert(json?.detail ?? "rotate failed");
          return;
        }
        setIssued({ name: json.name, key: json.key, scopes: json.scopes, rotated: true });
        mutate();
      } finally {
        setRotatingId(null);
      }
    },
    [mutate],
  );

  const keys = data?.keys ?? [];
  const active = keys.filter((k) => !k.revoked).length;

  const sampleKey = issued?.key ?? "adh_YOUR_KEY_HERE";
  const curlRuns = `curl http://localhost:3000/v1/runs?limit=10 \\
  -H "authorization: Bearer ${sampleKey}"`;

  const curlRunGet = `curl http://localhost:3000/v1/runs/RUN_ID \\
  -H "authorization: Bearer ${sampleKey}"`;

  const curlRunPatch = `curl -X PATCH http://localhost:3000/v1/runs/RUN_ID \\
  -H "authorization: Bearer ${sampleKey}" \\
  -H "content-type: application/json" \\
  -d '{"title":"october cohort","tags":["q4","retention"]}'`;

  const curlRunDelete = `curl -X DELETE http://localhost:3000/v1/runs/RUN_ID \\
  -H "authorization: Bearer ${sampleKey}"`;

  const curlRunShare = `curl -X POST http://localhost:3000/v1/runs/RUN_ID/share \\
  -H "authorization: Bearer ${sampleKey}" \\
  -H "content-type: application/json" \\
  -d '{"enabled":true}'`;

  const curlRunCreate = `curl -X POST http://localhost:3000/v1/runs \\
  -H "authorization: Bearer ${sampleKey}" \\
  -H "content-type: application/json" \\
  -d '{"kind":"predict","title":"manual ingest","summary":"from notebook","payload":{"any":"json"},"tags":["ingest"]}'`;

  const curlMe = `curl http://localhost:3000/v1/keys/me \\
  -H "authorization: Bearer ${sampleKey}"`;

  const curlExport = `curl -L 'http://localhost:3000/v1/runs/export?format=csv&kind=predict' \\
  -H "authorization: Bearer ${sampleKey}" \\
  -o runs.csv`;

  const curlBatch = `curl -X POST 'http://localhost:3000/v1/batch?format=csv' \\
  -H "authorization: Bearer ${sampleKey}" \\
  -H "content-type: text/csv" \\
  --data-binary $'user_id,dose_id,scheduled_at,dose_class,dose_strength_mg\\nu_1,d_1,2025-01-01T08:00:00Z,cardio,20\\nu_1,d_2,2025-01-01T20:00:00Z,cardio,20'`;

  const curl = `curl -X POST http://localhost:3000/v1/predict \\
  -H "authorization: Bearer ${sampleKey}" \\
  -H "content-type: application/json" \\
  -d '{
    "user_id": "u_123",
    "doses": [
      {
        "dose_id": "d1",
        "scheduled_at": "2025-01-01T08:00:00Z",
        "dose_class": "statin",
        "dose_strength_mg": 20
      }
    ]
  }'`;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="developer"
        title="API keys"
        description="Programmatic access to /v1: predict, create, read, rename, retag, share, and delete runs. Each key is shown once at creation."
      />

      {issued ? (
        <Card className="border-[var(--color-accent)]/40">
          <CardHeader
            title={`${issued.rotated ? "Key rotated" : "Key created"}: ${issued.name}`}
            hint={
              issued.rotated
                ? "The previous secret is now invalid. Copy the new one and update every client that uses it."
                : "Copy it now. We store only a hash, so you cannot view it again."
            }
            right={<ShieldCheck weight="duotone" size={16} className="text-[var(--color-accent)]" />}
          />
          <div className="p-4 pt-2 space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <code className="text-xs font-mono px-3 py-2 rounded bg-[var(--color-surface)] border border-[var(--color-border)] break-all flex-1 min-w-0">
                {issued.key}
              </code>
              <CopyBtn text={issued.key} label="copy key" />
            </div>
            {issued.scopes && issued.scopes.length > 0 ? (
              <div className="flex items-center gap-2 text-[11px] text-[var(--color-muted)]">
                <span>scopes</span>
                {issued.scopes.map((s) => (
                  <Badge key={s} tone="neutral">{s}</Badge>
                ))}
              </div>
            ) : null}
            <div className="flex items-start gap-2 text-[12px] text-[var(--color-muted)]">
              <Warning weight="duotone" size={14} className="mt-0.5 shrink-0" />
              <span>
                Treat this like a password. If you lose it, revoke this key and create a new one.
              </span>
            </div>
            <div className="pt-1">
              <Button onClick={() => setIssued(null)}>Got it</Button>
            </div>
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Create a key" hint="Give it a name you will recognise later." right={<Plus weight="duotone" size={16} />} />
        <div className="p-4 pt-2 space-y-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              placeholder="e.g. production backend"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onCreate();
              }}
              aria-label="key name"
            />
            <Button onClick={onCreate} disabled={creating}>
              {creating ? "Creating..." : "Create key"}
            </Button>
          </div>
          <fieldset className="flex flex-wrap items-center gap-3 text-[12px]">
            <legend className="sr-only">scopes</legend>
            <span className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">scopes</span>
            {([
              { value: "predict" as const, label: "predict", hint: "POST /v1/predict" },
              { value: "read" as const, label: "read", hint: "GET /v1/runs" },
              { value: "webhooks" as const, label: "webhooks", hint: "manage /v1/webhooks endpoints" },
            ]).map((s) => {
              const checked = scopes.includes(s.value);
              return (
                <label
                  key={s.value}
                  className={`inline-flex items-center gap-2 px-2 py-1 rounded border cursor-pointer select-none ${
                    checked
                      ? "border-[var(--color-accent)]/60 bg-[var(--color-surface)]"
                      : "border-[var(--color-border)]"
                  }`}
                  title={s.hint}
                >
                  <input
                    type="checkbox"
                    className="accent-[var(--color-accent)]"
                    checked={checked}
                    onChange={(e) =>
                      setScopes((prev) =>
                        e.target.checked
                          ? Array.from(new Set([...prev, s.value]))
                          : prev.filter((x) => x !== s.value),
                      )
                    }
                  />
                  <span className="font-mono">{s.label}</span>
                  <span className="text-[10px] text-[var(--color-muted)]">{s.hint}</span>
                </label>
              );
            })}
          </fieldset>
          <fieldset className="flex flex-wrap items-center gap-3 text-[12px]">
            <legend className="sr-only">expires</legend>
            <span className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">expires</span>
            {(data?.ttl_presets_days ?? [7, 30, 90, 365]).map((days) => {
              const checked = ttlDays === days;
              return (
                <label
                  key={days}
                  className={`inline-flex items-center gap-2 px-2 py-1 rounded border cursor-pointer select-none ${
                    checked
                      ? "border-[var(--color-accent)]/60 bg-[var(--color-surface)]"
                      : "border-[var(--color-border)]"
                  }`}
                >
                  <input
                    type="radio"
                    name="ttl"
                    className="accent-[var(--color-accent)]"
                    checked={checked}
                    onChange={() => setTtlDays(days)}
                  />
                  <span className="font-mono">{days}d</span>
                </label>
              );
            })}
            <label
              className={`inline-flex items-center gap-2 px-2 py-1 rounded border cursor-pointer select-none ${
                ttlDays === null
                  ? "border-[var(--color-accent)]/60 bg-[var(--color-surface)]"
                  : "border-[var(--color-border)]"
              }`}
              title="Key never expires. Rotate or revoke manually."
            >
              <input
                type="radio"
                name="ttl"
                className="accent-[var(--color-accent)]"
                checked={ttlDays === null}
                onChange={() => setTtlDays(null)}
              />
              <span className="font-mono">never</span>
            </label>
          </fieldset>
          <p className="text-[11px] text-[var(--color-muted)]">
            Short-lived keys are best practice. An expired key returns 401 from every /v1 endpoint until you rotate or create a new one.
          </p>
          {createErr ? <ErrorBox message={createErr} /> : null}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Your keys"
          hint={`${active} active / ${keys.length} total`}
          right={<Key weight="duotone" size={16} />}
        />
        <div className="p-4 pt-2">
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : error ? (
            <ErrorBox message="failed to load keys" />
          ) : keys.length === 0 ? (
            <Empty
              icon={<Key weight="duotone" size={24} />}
              title="No keys yet"
              hint="Create your first key above to start calling /v1/predict."
            />
          ) : (
            <div className="overflow-x-auto -mx-4">
              <table className="w-full text-[12px]">
                <thead className="text-left text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
                  <tr>
                    <th className="px-4 py-2 font-medium">Name</th>
                    <th className="px-4 py-2 font-medium">Prefix</th>
                    <th className="px-4 py-2 font-medium">Scopes</th>
                    <th className="px-4 py-2 font-medium">Created</th>
                    <th className="px-4 py-2 font-medium">Last used</th>
                    <th className="px-4 py-2 font-medium">Rotated</th>
                    <th className="px-4 py-2 font-medium">Expires</th>
                    <th className="px-4 py-2 font-medium text-right">Calls</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id} className="border-t border-[var(--color-border)]">
                      <td className="px-4 py-2 font-medium">{k.name}</td>
                      <td className="px-4 py-2"><MonoChip>{k.prefix}...</MonoChip></td>
                      <td className="px-4 py-2">
                        <div className="inline-flex flex-wrap gap-1">
                          {(k.scopes ?? []).map((s) => (
                            <Badge key={s} tone="neutral">{s}</Badge>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-2 font-mono text-[11px] text-[var(--color-muted)]">
                        {fmt(k.created_at)}
                      </td>
                      <td className="px-4 py-2 font-mono text-[11px] text-[var(--color-muted)]">
                        {fmt(k.last_used_at)}
                      </td>
                      <td className="px-4 py-2 font-mono text-[11px] text-[var(--color-muted)]">
                        {fmt(k.rotated_at)}
                      </td>
                      <td
                        className="px-4 py-2 font-mono text-[11px] text-[var(--color-muted)]"
                        title={k.expires_at ? fmt(k.expires_at) : "this key has no expiry"}
                      >
                        {k.expires_at == null ? (
                          <span>never</span>
                        ) : k.expired ? (
                          <Badge tone="danger">expired</Badge>
                        ) : (
                          <span>{relativeFromNow(k.expires_at)}</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">{k.use_count}</td>
                      <td className="px-4 py-2">
                        {k.revoked ? (
                          <Badge tone="danger">revoked</Badge>
                        ) : k.expired ? (
                          <Badge tone="danger">expired</Badge>
                        ) : (
                          <Badge tone="success">active</Badge>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="inline-flex items-center gap-1 justify-end">
                          <a
                            href={`/api-keys/${k.id}`}
                            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)] hover:border-[var(--color-accent)]/40 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                            aria-label={`view usage for ${k.name}`}
                            title="See recent requests and a 14-day call volume chart"
                          >
                            usage
                          </a>
                          {!k.revoked && !k.expired ? (
                            <>
                              <button
                                type="button"
                                onClick={() => onRotate(k)}
                                disabled={rotatingId === k.id}
                                className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)] hover:border-[var(--color-accent)]/40 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
                                aria-label={`rotate ${k.name}`}
                                title="Issue a new secret for this key without changing its name or history"
                              >
                                <ArrowsClockwise weight="duotone" size={12} />
                                {rotatingId === k.id ? "..." : "rotate"}
                              </button>
                              <button
                                type="button"
                                onClick={() => onRevoke(k.id)}
                                disabled={revokingId === k.id}
                                className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)] hover:border-[var(--color-high)]/40 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
                                aria-label={`revoke ${k.name}`}
                              >
                                <Trash weight="duotone" size={12} />
                                {revokingId === k.id ? "..." : "revoke"}
                              </button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Try it"
          hint="POST /v1/predict with your key."
          right={<Terminal weight="duotone" size={16} />}
        />
        <div className="p-4 pt-2 space-y-2">
          <div className="flex items-center justify-end">
            <CopyBtn text={curl} label="copy curl" />
          </div>
          <pre className="text-[11px] font-mono p-3 rounded bg-[var(--color-surface)] border border-[var(--color-border)] overflow-x-auto whitespace-pre">
{curl}
          </pre>
          <div className="flex items-center justify-between pt-2">
            <span className="text-[11px] text-[var(--color-muted)]">GET /v1/runs (requires read scope)</span>
            <CopyBtn text={curlRuns} label="copy curl" />
          </div>
          <pre className="text-[11px] font-mono p-3 rounded bg-[var(--color-surface)] border border-[var(--color-border)] overflow-x-auto whitespace-pre">
{curlRuns}
          </pre>
          <div className="flex items-center justify-between pt-2">
            <span className="text-[11px] text-[var(--color-muted)]">GET /v1/runs/&lt;id&gt; (fetch one run with full payload, requires read scope)</span>
            <CopyBtn text={curlRunGet} label="copy curl" />
          </div>
          <pre className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-[12px] leading-relaxed overflow-x-auto">
{curlRunGet}
          </pre>
          <div className="flex items-center justify-between pt-2">
            <span className="text-[11px] text-[var(--color-muted)]">POST /v1/runs (create a run from any external job, requires predict scope)</span>
            <CopyBtn text={curlRunCreate} label="copy curl" />
          </div>
          <pre className="text-[11px] font-mono p-3 rounded bg-[var(--color-surface)] border border-[var(--color-border)] overflow-x-auto whitespace-pre">
{curlRunCreate}
          </pre>
          <div className="flex items-center justify-between pt-2">
            <span className="text-[11px] text-[var(--color-muted)]">PATCH /v1/runs/&lt;id&gt; (rename or retag, requires predict scope)</span>
            <CopyBtn text={curlRunPatch} label="copy curl" />
          </div>
          <pre className="text-[11px] font-mono p-3 rounded bg-[var(--color-surface)] border border-[var(--color-border)] overflow-x-auto whitespace-pre">
{curlRunPatch}
          </pre>
          <div className="flex items-center justify-between pt-2">
            <span className="text-[11px] text-[var(--color-muted)]">DELETE /v1/runs/&lt;id&gt; (permanent, requires predict scope)</span>
            <CopyBtn text={curlRunDelete} label="copy curl" />
          </div>
          <pre className="text-[11px] font-mono p-3 rounded bg-[var(--color-surface)] border border-[var(--color-border)] overflow-x-auto whitespace-pre">
{curlRunDelete}
          </pre>
          <div className="flex items-center justify-between pt-2">
            <span className="text-[11px] text-[var(--color-muted)]">POST /v1/runs/&lt;id&gt;/share (mint or revoke a public /share/&lt;token&gt; link, requires predict scope)</span>
            <CopyBtn text={curlRunShare} label="copy curl" />
          </div>
          <pre className="text-[11px] font-mono p-3 rounded bg-[var(--color-surface)] border border-[var(--color-border)] overflow-x-auto whitespace-pre">
{curlRunShare}
          </pre>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[var(--color-muted)]">GET /v1/keys/me (verify a key, requires read scope, does not spend predict quota)</span>
            <CopyBtn text={curlMe} label="copy curl" />
          </div>
          <pre className="text-[11px] font-mono p-3 rounded bg-[var(--color-surface)] border border-[var(--color-border)] overflow-x-auto whitespace-pre">
{curlMe}
          </pre>
          <div className="flex items-center justify-between pt-2">
            <span className="text-[11px] text-[var(--color-muted)]">GET /v1/runs/export (CSV, JSON, or NDJSON dump of your run history, requires read scope)</span>
            <CopyBtn text={curlExport} label="copy curl" />
          </div>
          <pre className="text-[11px] font-mono p-3 rounded bg-[var(--color-surface)] border border-[var(--color-border)] overflow-x-auto whitespace-pre">
{curlExport}
          </pre>
          <div className="flex items-center justify-between pt-2">
            <span className="text-[11px] text-[var(--color-muted)]">POST /v1/batch (CSV in, CSV or JSON out, one prediction per row counts against quota)</span>
            <CopyBtn text={curlBatch} label="copy curl" />
          </div>
          <pre className="text-[11px] font-mono p-3 rounded bg-[var(--color-surface)] border border-[var(--color-border)] overflow-x-auto whitespace-pre">
{curlBatch}
          </pre>
          <p className="text-[11px] text-[var(--color-muted)]">
            Successful calls also appear in your <a href="/history" className="underline">history</a>.
          </p>
        </div>
      </Card>
    </div>
  );
}
