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
  Hourglass,
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

type Scope = "predict" | "read" | "webhooks" | "audit";

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
  daily_quota: number | null;
  allowed_cidrs: string[] | null;
  last_used_ip?: string | null;
  last_used_user_agent?: string | null;
  revoked_reason?: RevokeReason | null;
  revoked_note?: string | null;
  revoked_at?: number | null;
  revoked_by_email?: string | null;
};

type RevokeReason =
  | "compromised"
  | "rotated"
  | "employee_offboarded"
  | "unused"
  | "vendor_offboarded"
  | "policy_violation"
  | "other"
  | "unspecified";

const REVOKE_REASON_LABELS: Record<RevokeReason, string> = {
  compromised: "Compromised / leaked",
  rotated: "Rotated to new key",
  employee_offboarded: "Employee offboarded",
  unused: "No longer used",
  vendor_offboarded: "Vendor offboarded",
  policy_violation: "Policy violation",
  other: "Other (see note)",
  unspecified: "Unspecified",
};

const DEFAULT_SELECTABLE_REASONS: RevokeReason[] = [
  "compromised",
  "rotated",
  "employee_offboarded",
  "unused",
  "vendor_offboarded",
  "policy_violation",
  "other",
];

const REVOKE_NOTE_MAX = 280;

type RevokeTarget = { id: string; name: string; prefix: string; summary: string };

type ListResp = {
  keys: KeyRow[];
  available_scopes: Scope[];
  ttl_presets_days: number[];
  revoke_reasons?: RevokeReason[];
};

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

function QuotaCell({
  k,
  disabled,
  onSaved,
}: {
  k: KeyRow;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState<string>(
    k.daily_quota == null ? "" : String(k.daily_quota),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const trimmed = val.trim();
      let daily_quota: number | null = null;
      if (trimmed) {
        const n = Math.floor(Number(trimmed));
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error("enter a positive whole number, or leave blank for no cap");
        }
        daily_quota = n;
      }
      const res = await fetch(`/api/keys/${k.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ daily_quota }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.detail ?? `update failed (${res.status})`);
      }
      setEditing(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [k.id, val, onSaved]);

  if (!editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setVal(k.daily_quota == null ? "" : String(k.daily_quota));
          setErr(null);
          setEditing(true);
        }}
        className="text-[11px] font-mono px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)] hover:border-[var(--color-accent)]/40 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50 disabled:cursor-not-allowed"
        aria-label={`edit daily cap for ${k.name}`}
        title={
          k.daily_quota == null
            ? "No per-key cap. Click to set one."
            : `Per-key cap: ${k.daily_quota} calls/day. Click to edit.`
        }
      >
        {k.daily_quota == null ? "none" : k.daily_quota.toLocaleString()}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 justify-end">
      <input
        type="number"
        min={1}
        step={1}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="none"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-20 text-[11px] font-mono px-2 py-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-soft)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
        aria-label="daily quota in calls per day, blank for none"
      />
      <button
        type="button"
        onClick={() => void save()}
        disabled={busy}
        className="text-[11px] px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)] hover:border-[var(--color-accent)]/40 disabled:opacity-50"
      >
        {busy ? "..." : "save"}
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        disabled={busy}
        className="text-[11px] px-2 py-1 rounded text-[var(--color-muted)] hover:text-[var(--color-text)] disabled:opacity-50"
      >
        cancel
      </button>
      {err ? (
        <span
          className="text-[10px] text-[var(--color-high)]"
          role="alert"
        >
          {err}
        </span>
      ) : null}
    </span>
  );
}

function CidrsCell({
  k,
  disabled,
  onSaved,
}: {
  k: KeyRow;
  disabled: boolean;
  onSaved: () => void;
}) {
  const current = (k.allowed_cidrs ?? []).join(", ");
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState<string>(current);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const trimmed = val.trim();
      const list = trimmed
        ? trimmed.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
        : null;
      const res = await fetch(`/api/keys/${k.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowed_cidrs: list }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.detail ?? `update failed (${res.status})`);
      }
      setEditing(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [k.id, val, onSaved]);

  if (!editing) {
    const list = k.allowed_cidrs ?? [];
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setVal(current);
          setErr(null);
          setEditing(true);
        }}
        className="text-[11px] font-mono px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)] hover:border-[var(--color-accent)]/40 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50 disabled:cursor-not-allowed max-w-[12rem] truncate"
        aria-label={`edit ip allowlist for ${k.name}`}
        title={
          list.length === 0
            ? "No source-IP restriction. Click to pin this key to one or more CIDRs."
            : `Pinned to ${list.length} CIDR${list.length === 1 ? "" : "s"}: ${list.join(", ")}. Click to edit.`
        }
      >
        {list.length === 0 ? "any" : list.length === 1 ? list[0] : `${list.length} CIDRs`}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 justify-end">
      <input
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="any"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-56 text-[11px] font-mono px-2 py-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-soft)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
        aria-label="comma-separated CIDR list, blank to allow any source IP"
      />
      <button
        type="button"
        onClick={() => void save()}
        disabled={busy}
        className="text-[11px] px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)] hover:border-[var(--color-accent)]/40 disabled:opacity-50"
      >
        {busy ? "..." : "save"}
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        disabled={busy}
        className="text-[11px] px-2 py-1 rounded text-[var(--color-muted)] hover:text-[var(--color-text)] disabled:opacity-50"
      >
        cancel
      </button>
      {err ? (
        <span className="text-[10px] text-[var(--color-high)]" role="alert">
          {err}
        </span>
      ) : null}
    </span>
  );
}

type ExpiringKeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  expires_at: number;
  days_remaining: number;
  last_used_at: number | null;
  last_used_ip: string | null;
};

type ExpiringResp = {
  now: number;
  within_days: number;
  count: number;
  keys: ExpiringKeyRow[];
};

function ExpiringSoonBanner() {
  const { data, error, isLoading } = useSWR<ExpiringResp>(
    "/api/keys/expiring?within=14",
    fetcher,
    { refreshInterval: 0 },
  );

  if (isLoading) {
    return (
      <Card aria-busy>
        <CardHeader
          title="Expiring soon"
          hint="Checking which keys cross their TTL in the next 14 days."
          right={<Hourglass weight="duotone" size={16} />}
        />
        <div className="p-4 pt-2 space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader
          title="Expiring soon"
          hint="Could not load the upcoming expiry list. Other key operations still work."
          right={<Warning weight="duotone" size={16} className="text-[var(--color-high)]" />}
        />
        <div className="p-4 pt-2">
          <ErrorBox message="Failed to fetch /api/keys/expiring" />
        </div>
      </Card>
    );
  }

  const keys = data?.keys ?? [];
  const within = data?.within_days ?? 14;

  if (keys.length === 0) {
    return (
      <Card>
        <CardHeader
          title="Expiring soon"
          hint={`No keys expire in the next ${within} days. You will be warned here before any silent 401.`}
          right={<Hourglass weight="duotone" size={16} className="text-[var(--color-muted)]" />}
        />
      </Card>
    );
  }

  return (
    <Card className="border-[var(--color-warn)]/40">
      <CardHeader
        title={`${keys.length} key${keys.length === 1 ? "" : "s"} expire within ${within} days`}
        hint="Rotate before the TTL boundary or your integrations will start failing with 401 unauthorized."
        right={<Hourglass weight="duotone" size={16} className="text-[var(--color-warn)]" />}
      />
      <ul className="p-4 pt-2 space-y-2" role="list">
        {keys.map((k) => {
          const urgent = k.days_remaining <= 3;
          return (
            <li
              key={k.id}
              className="flex flex-wrap items-center gap-2 text-[12px]"
            >
              <Badge tone={urgent ? "danger" : "warn"}>
                {k.days_remaining === 0
                  ? "<1d"
                  : `${k.days_remaining}d`}
              </Badge>
              <span className="font-medium text-[var(--color-fg)]">
                {k.name}
              </span>
              <MonoChip>{k.prefix}</MonoChip>
              <span className="text-[var(--color-muted)]">
                expires {fmt(k.expires_at)}
              </span>
              <span className="text-[var(--color-muted)]">
                last used {k.last_used_at ? relativeFromNow(k.last_used_at) : "never"}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
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
  const [allowedCidrs, setAllowedCidrs] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ name: string; key: string; scopes?: Scope[]; rotated?: boolean } | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null);
  const [revokeReason, setRevokeReason] = useState<RevokeReason>("compromised");
  const [revokeNote, setRevokeNote] = useState("");
  const [revokeErr, setRevokeErr] = useState<string | null>(null);
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
      const trimmedCidrs = allowedCidrs.trim();
      const cidrList = trimmedCidrs
        ? trimmedCidrs.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
        : null;
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          scopes,
          ttl_days: ttlDays,
          allowed_cidrs: cidrList,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setCreateErr(json?.detail ?? "failed to create key");
        return;
      }
      setIssued({ name: json.name, key: json.key, scopes: json.scopes });
      setName("");
      setAllowedCidrs("");
      mutate();
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : "network error");
    } finally {
      setCreating(false);
    }
  }, [name, scopes, ttlDays, allowedCidrs, mutate]);

  const onRevoke = useCallback(
    async (id: string) => {
      const k = (data?.keys ?? []).find((kk) => kk.id === id);
      if (!k) return;
      // Build a server-authored summary first; falls back to a local one if
      // the dry-run endpoint is unreachable for any reason.
      let summary = `This will immediately invalidate ${k.name} (prefix ${k.prefix}).`;
      try {
        const previewRes = await fetch(`/api/keys/${id}?dry_run=true`, {
          method: "DELETE",
        });
        if (previewRes.ok) {
          const preview = await previewRes.json();
          if (preview?.preview?.summary) summary = preview.preview.summary;
        }
      } catch {
        /* preview is advisory; modal still opens */
      }
      setRevokeTarget({ id, name: k.name, prefix: k.prefix, summary });
      setRevokeReason("compromised");
      setRevokeNote("");
      setRevokeErr(null);
    },
    [data],
  );

  const confirmRevoke = useCallback(async () => {
    if (!revokeTarget) return;
    setRevokingId(revokeTarget.id);
    setRevokeErr(null);
    try {
      const res = await fetch(`/api/keys/${revokeTarget.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: revokeReason,
          note: revokeNote.trim() ? revokeNote.trim().slice(0, REVOKE_NOTE_MAX) : undefined,
        }),
      });
      if (!res.ok) {
        let detail = `revoke failed (${res.status})`;
        try {
          const j = await res.json();
          if (j?.detail) detail = j.detail;
        } catch {
          /* keep status text */
        }
        setRevokeErr(detail);
        return;
      }
      setRevokeTarget(null);
      mutate();
    } finally {
      setRevokingId(null);
    }
  }, [revokeTarget, revokeReason, revokeNote, mutate]);

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
  const selectableReasons: RevokeReason[] = data?.revoke_reasons?.length
    ? data.revoke_reasons
    : DEFAULT_SELECTABLE_REASONS;

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

      <ExpiringSoonBanner />

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
              { value: "audit" as const, label: "audit", hint: "GET /v1/audit (SIEM export)" },
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
          <div className="flex flex-col gap-1">
            <label
              htmlFor="new-key-cidrs"
              className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]"
            >
              Source IP allowlist
            </label>
            <input
              id="new-key-cidrs"
              type="text"
              value={allowedCidrs}
              onChange={(e) => setAllowedCidrs(e.target.value)}
              placeholder="any (leave blank), or 10.0.0.0/8, 203.0.113.42/32"
              autoComplete="off"
              spellCheck={false}
              className="w-full text-[12px] font-mono px-3 py-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-soft)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              aria-describedby="new-key-cidrs-help"
            />
            <p
              id="new-key-cidrs-help"
              className="text-[11px] text-[var(--color-muted)]"
            >
              Comma or space separated CIDRs (IPv4 or IPv6). When set, the key only authenticates requests from these networks. A bare IP becomes a /32 or /128 host route. Leave blank to allow any source IP.
            </p>
          </div>
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
                    <th className="px-4 py-2 font-medium text-right">Cap/day</th>
                    <th className="px-4 py-2 font-medium text-right">IPs</th>
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
                        <div className="flex flex-col gap-0.5">
                          <span>{fmt(k.last_used_at)}</span>
                          {k.last_used_ip || k.last_used_user_agent ? (
                            <span
                              className="text-[10px] text-[var(--color-muted)] truncate max-w-[260px]"
                              title={[k.last_used_ip || "", k.last_used_user_agent || ""]
                                .filter(Boolean)
                                .join(" • ")}
                            >
                              {k.last_used_ip ? <MonoChip>{k.last_used_ip}</MonoChip> : null}
                              {k.last_used_user_agent ? (
                                <span className="ml-1">{k.last_used_user_agent.slice(0, 48)}{k.last_used_user_agent.length > 48 ? "…" : ""}</span>
                              ) : null}
                            </span>
                          ) : null}
                        </div>
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
                      <td className="px-4 py-2 text-right">
                        <QuotaCell
                          k={k}
                          disabled={k.revoked || k.expired}
                          onSaved={() => mutate()}
                        />
                      </td>
                      <td className="px-4 py-2 text-right">
                        <CidrsCell
                          k={k}
                          disabled={k.revoked || k.expired}
                          onSaved={() => mutate()}
                        />
                      </td>
                      <td className="px-4 py-2">
                        {k.revoked ? (
                          <span
                            title={
                              k.revoked_reason
                                ? `${REVOKE_REASON_LABELS[k.revoked_reason] ?? k.revoked_reason}` +
                                  (k.revoked_at ? ` on ${fmt(k.revoked_at)}` : "") +
                                  (k.revoked_by_email ? ` by ${k.revoked_by_email}` : "") +
                                  (k.revoked_note ? ` - ${k.revoked_note}` : "")
                                : "Revoked"
                            }
                          >
                            <Badge tone="danger">
                              revoked{k.revoked_reason && k.revoked_reason !== "unspecified" ? `: ${k.revoked_reason.replace(/_/g, " ")}` : ""}
                            </Badge>
                          </span>
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
      {revokeTarget ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="revoke-key-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onKeyDown={(e) => {
            if (e.key === "Escape") setRevokeTarget(null);
          }}
        >
          <div className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-5 shadow-xl">
            <div className="flex items-start gap-3">
              <Warning weight="duotone" size={22} className="text-[var(--color-high)] mt-0.5" />
              <div className="flex-1">
                <h2 id="revoke-key-title" className="text-sm font-medium">
                  Revoke {revokeTarget.name}
                </h2>
                <p className="mt-1 text-[12px] text-[var(--color-muted)]">{revokeTarget.summary}</p>
              </div>
            </div>
            <label className="mt-4 block text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
              Reason
            </label>
            <select
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value as RevokeReason)}
              className="mt-1 w-full rounded border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              aria-label="revocation reason"
            >
              {selectableReasons.map((r) => (
                <option key={r} value={r}>
                  {REVOKE_REASON_LABELS[r] ?? r}
                </option>
              ))}
            </select>
            <label className="mt-3 block text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
              Note <span className="normal-case">(optional, {REVOKE_NOTE_MAX} chars max)</span>
            </label>
            <textarea
              value={revokeNote}
              onChange={(e) => setRevokeNote(e.target.value.slice(0, REVOKE_NOTE_MAX))}
              rows={3}
              placeholder="e.g. found in a public gist, rotating to new vendor account"
              className="mt-1 w-full rounded border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              aria-label="revocation note"
            />
            <div className="mt-1 text-right text-[10px] text-[var(--color-muted)]">
              {revokeNote.length}/{REVOKE_NOTE_MAX}
            </div>
            {revokeErr ? (
              <div className="mt-2 text-[12px] text-[var(--color-high)]">{revokeErr}</div>
            ) : null}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setRevokeTarget(null)}
                disabled={revokingId === revokeTarget.id}
                className="text-[12px] px-3 py-1.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)] disabled:opacity-50"
              >
                cancel
              </button>
              <button
                type="button"
                onClick={confirmRevoke}
                disabled={revokingId === revokeTarget.id}
                className="text-[12px] px-3 py-1.5 rounded bg-[var(--color-high)] text-white hover:opacity-90 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
              >
                {revokingId === revokeTarget.id ? "revoking..." : "revoke key"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
