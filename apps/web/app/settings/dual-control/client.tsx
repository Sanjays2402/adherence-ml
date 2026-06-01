"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle,
  Clock,
  Hourglass,
  Plus,
  ShieldCheck,
  Trash,
  UsersThree,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorBox,
  Input,
  Skeleton,
} from "@/components/ui/primitives";

type Policy = {
  id: number;
  tenant_id: string;
  action_type: string;
  description: string | null;
  ttl_seconds: number;
  created_by: string;
  created_at: string;
};

type PolicyListResp = {
  tenant_id: string;
  entries: Policy[];
};

type DcRequest = {
  id: number;
  tenant_id: string;
  action_type: string;
  payload_hash: string;
  payload: unknown;
  summary: string | null;
  reason: string;
  status: string;
  requested_by: string;
  requested_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  executed_at: string | null;
  expired: boolean;
};

type RequestListResp = {
  tenant_id: string;
  pending_count: number;
  entries: DcRequest[];
};

const fetcher = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(
      typeof body?.detail === "string"
        ? body.detail
        : `request failed (${r.status})`,
    );
  }
  return r.json() as Promise<T>;
};

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z";
  } catch {
    return iso;
  }
}

function statusBadge(status: string, expired: boolean) {
  if (expired && status !== "executed" && status !== "approved") {
    return (
      <Badge tone="neutral">
        <Hourglass weight="duotone" className="size-3" /> expired
      </Badge>
    );
  }
  switch (status) {
    case "pending":
      return (
        <Badge tone="accent">
          <Clock weight="duotone" className="size-3" /> pending
        </Badge>
      );
    case "approved":
      return (
        <Badge tone="success">
          <CheckCircle weight="duotone" className="size-3" /> approved
        </Badge>
      );
    case "rejected":
      return (
        <Badge tone="danger">
          <XCircle weight="duotone" className="size-3" /> rejected
        </Badge>
      );
    case "executed":
      return (
        <Badge tone="success">
          <ShieldCheck weight="duotone" className="size-3" /> executed
        </Badge>
      );
    case "cancelled":
      return (
        <Badge tone="neutral">
          <XCircle weight="duotone" className="size-3" /> cancelled
        </Badge>
      );
    default:
      return <Badge tone="neutral">{status}</Badge>;
  }
}

export default function DualControlClient() {
  const policy = useSWR<PolicyListResp>("/api/dual-control/policy", fetcher);
  const requests = useSWR<RequestListResp>("/api/dual-control", fetcher, {
    refreshInterval: 30_000,
  });

  const [pActionType, setPActionType] = useState("");
  const [pDescription, setPDescription] = useState("");
  const [pTtlHours, setPTtlHours] = useState("24");
  const [pSubmitting, setPSubmitting] = useState(false);
  const [pError, setPError] = useState<string | null>(null);

  const [rActionType, setRActionType] = useState("");
  const [rPayload, setRPayload] = useState("{}");
  const [rReason, setRReason] = useState("");
  const [rSummary, setRSummary] = useState("");
  const [rSubmitting, setRSubmitting] = useState(false);
  const [rError, setRError] = useState<string | null>(null);

  const [decisionFor, setDecisionFor] = useState<number | null>(null);
  const [decisionReason, setDecisionReason] = useState("");
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionBusy, setDecisionBusy] = useState(false);

  const upsertPolicy = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setPError(null);
      setPSubmitting(true);
      try {
        const ttlHoursNum = Number(pTtlHours);
        const body: Record<string, unknown> = {
          action_type: pActionType.trim(),
        };
        if (pDescription.trim()) body.description = pDescription.trim();
        if (Number.isFinite(ttlHoursNum) && ttlHoursNum > 0) {
          body.ttl_seconds = Math.round(ttlHoursNum * 3600);
        }
        const r = await fetch("/api/dual-control/policy", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(
            typeof j?.detail === "string"
              ? j.detail
              : `request failed (${r.status})`,
          );
        }
        setPActionType("");
        setPDescription("");
        await policy.mutate();
      } catch (err) {
        setPError(err instanceof Error ? err.message : "failed");
      } finally {
        setPSubmitting(false);
      }
    },
    [pActionType, pDescription, pTtlHours, policy],
  );

  const deletePolicy = useCallback(
    async (actionType: string) => {
      try {
        const r = await fetch(
          `/api/dual-control/policy/${encodeURIComponent(actionType)}`,
          { method: "DELETE" },
        );
        if (!r.ok && r.status !== 204) {
          const j = await r.json().catch(() => ({}));
          throw new Error(
            typeof j?.detail === "string"
              ? j.detail
              : `request failed (${r.status})`,
          );
        }
        await policy.mutate();
      } catch (err) {
        setPError(err instanceof Error ? err.message : "failed");
      }
    },
    [policy],
  );

  const openRequest = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setRError(null);
      let payloadValue: unknown;
      try {
        payloadValue = rPayload.trim() ? JSON.parse(rPayload) : {};
      } catch {
        setRError("payload must be valid JSON");
        return;
      }
      setRSubmitting(true);
      try {
        const body: Record<string, unknown> = {
          action_type: rActionType.trim(),
          payload: payloadValue,
          reason: rReason.trim(),
        };
        if (rSummary.trim()) body.summary = rSummary.trim();
        const r = await fetch("/api/dual-control", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(
            typeof j?.detail === "string"
              ? j.detail
              : `request failed (${r.status})`,
          );
        }
        setRPayload("{}");
        setRReason("");
        setRSummary("");
        await requests.mutate();
      } catch (err) {
        setRError(err instanceof Error ? err.message : "failed");
      } finally {
        setRSubmitting(false);
      }
    },
    [rActionType, rPayload, rReason, rSummary, requests],
  );

  const decide = useCallback(
    async (id: number, action: "approve" | "reject" | "cancel") => {
      setDecisionError(null);
      setDecisionBusy(true);
      try {
        const body =
          action === "cancel"
            ? {}
            : { decision_reason: decisionReason.trim() || null };
        const r = await fetch(`/api/dual-control/${id}?action=${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(
            typeof j?.detail === "string"
              ? j.detail
              : `request failed (${r.status})`,
          );
        }
        setDecisionFor(null);
        setDecisionReason("");
        await requests.mutate();
      } catch (err) {
        setDecisionError(err instanceof Error ? err.message : "failed");
      } finally {
        setDecisionBusy(false);
      }
    },
    [decisionReason, requests],
  );

  const pendingEntries = useMemo(
    () =>
      (requests.data?.entries ?? []).filter(
        (e) => e.status === "pending" && !e.expired,
      ),
    [requests.data],
  );
  const historyEntries = useMemo(
    () =>
      (requests.data?.entries ?? []).filter(
        (e) => !(e.status === "pending" && !e.expired),
      ),
    [requests.data],
  );

  return (
    <main className="min-h-screen px-4 py-10 sm:px-8 sm:py-14">
      <div className="mx-auto w-full max-w-5xl space-y-8">
        <header className="flex flex-col gap-3">
          <Link
            href="/settings"
            className="inline-flex items-center gap-1 text-[12px] text-[var(--color-subtle)] hover:text-[var(--color-fg)]"
          >
            <ArrowLeft weight="duotone" className="size-3.5" /> settings
          </Link>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-tight">
                <UsersThree
                  weight="duotone"
                  className="size-5 text-[var(--color-accent)]"
                />
                dual control
              </h1>
              <p className="mt-1 max-w-2xl text-[13px] text-[var(--color-subtle)]">
                Require a second admin to approve sensitive actions. Once an
                action type is gated, the API rejects single-admin attempts
                with HTTP 428 until a peer approves the exact request payload.
              </p>
            </div>
            <Badge tone="accent">
              <Clock weight="duotone" className="size-3" />
              {requests.data?.pending_count ?? 0} pending
            </Badge>
          </div>
        </header>

        <Card>
          <CardHeader
            title="Gated action types"
            hint="Each entry below requires a second admin's approval before the action will execute. Remove an entry to revert to single control."
          />
          <div className="space-y-4">
            <form
              onSubmit={upsertPolicy}
              className="grid gap-2 sm:grid-cols-[1fr_1fr_120px_auto]"
            >
              <Input
                placeholder="action_type (e.g. legal_hold.release)"
                value={pActionType}
                onChange={(e) => setPActionType(e.target.value)}
                required
                aria-label="action type"
              />
              <Input
                placeholder="description (optional)"
                value={pDescription}
                onChange={(e) => setPDescription(e.target.value)}
                aria-label="description"
              />
              <Input
                type="number"
                min={0.1}
                step={0.1}
                value={pTtlHours}
                onChange={(e) => setPTtlHours(e.target.value)}
                aria-label="ttl hours"
                title="Pending request TTL in hours"
              />
              <Button
                type="submit"
                variant="accent"
                disabled={pSubmitting || !pActionType.trim()}
              >
                <Plus weight="duotone" className="size-3.5" />
                {pSubmitting ? "saving" : "add"}
              </Button>
            </form>
            {pError && <ErrorBox message={pError} />}

            {policy.isLoading ? (
              <Skeleton className="h-20" />
            ) : policy.error ? (
              <ErrorBox message={(policy.error as Error).message} />
            ) : (policy.data?.entries ?? []).length === 0 ? (
              <Empty
                title="No gated actions"
                hint="Add an action type above (for example legal_hold.release) to require a second admin's approval."
              />
            ) : (
              <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
                {(policy.data?.entries ?? []).map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[13px] text-[var(--color-fg)]">
                        {p.action_type}
                      </div>
                      {p.description && (
                        <div className="text-[12px] text-[var(--color-subtle)]">
                          {p.description}
                        </div>
                      )}
                      <div className="mt-1 text-[11px] text-[var(--color-subtle)]">
                        TTL {Math.round(p.ttl_seconds / 3600)}h · added by{" "}
                        {p.created_by} · {fmtTime(p.created_at)}
                      </div>
                    </div>
                    <Button
                      variant="danger"
                      onClick={() => deletePolicy(p.action_type)}
                      aria-label={`remove ${p.action_type}`}
                    >
                      <Trash weight="duotone" className="size-3.5" />
                      remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Open a new approval request"
            hint="The payload must exactly match what the action will receive. Tampering between request and execution invalidates the approval."
          />
          <form onSubmit={openRequest} className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                placeholder="action_type"
                value={rActionType}
                onChange={(e) => setRActionType(e.target.value)}
                required
                aria-label="request action type"
              />
              <Input
                placeholder="short summary (optional)"
                value={rSummary}
                onChange={(e) => setRSummary(e.target.value)}
                aria-label="summary"
              />
            </div>
            <textarea
              value={rPayload}
              onChange={(e) => setRPayload(e.target.value)}
              rows={4}
              spellCheck={false}
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-[var(--color-accent)]/70 focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
              aria-label="payload json"
              placeholder='{"hold_id": 42, "release_reason": "matter SUP-9 closed"}'
            />
            <textarea
              value={rReason}
              onChange={(e) => setRReason(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--color-accent)]/70 focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
              required
              minLength={10}
              maxLength={4096}
              aria-label="reason"
              placeholder="why this action is needed (min 10 chars, recorded immutably)"
            />
            {rError && <ErrorBox message={rError} />}
            <div className="flex justify-end">
              <Button
                type="submit"
                variant="accent"
                disabled={
                  rSubmitting ||
                  !rActionType.trim() ||
                  rReason.trim().length < 10
                }
              >
                <Plus weight="duotone" className="size-3.5" />
                {rSubmitting ? "opening" : "open request"}
              </Button>
            </div>
          </form>
        </Card>

        <Card>
          <CardHeader
            title="Pending approvals"
            hint="A second admin must approve. The original requester cannot self approve."
          />
          {requests.isLoading ? (
            <Skeleton className="h-24" />
          ) : requests.error ? (
            <ErrorBox message={(requests.error as Error).message} />
          ) : pendingEntries.length === 0 ? (
            <Empty
              title="No pending requests"
              hint="When an admin opens a sensitive-action request it will appear here for a peer to review."
            />
          ) : (
            <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
              {pendingEntries.map((r) => (
                <li key={r.id} className="space-y-2 px-3 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[13px]">
                        {r.action_type}
                      </span>
                      {statusBadge(r.status, r.expired)}
                      <span className="text-[11px] text-[var(--color-subtle)]">
                        expires {fmtTime(r.expires_at)}
                      </span>
                    </div>
                    <span className="text-[11px] text-[var(--color-subtle)]">
                      #{r.id} · requested by {r.requested_by} ·{" "}
                      {fmtTime(r.requested_at)}
                    </span>
                  </div>
                  {r.summary && (
                    <div className="text-[13px] text-[var(--color-fg)]">
                      {r.summary}
                    </div>
                  )}
                  <div className="text-[12px] text-[var(--color-subtle)]">
                    {r.reason}
                  </div>
                  <details className="text-[12px]">
                    <summary className="cursor-pointer text-[var(--color-subtle)] hover:text-[var(--color-fg)]">
                      payload + hash
                    </summary>
                    <pre className="mt-1 overflow-x-auto rounded border border-[var(--color-border)] p-2 font-mono text-[11px]">
{JSON.stringify(r.payload, null, 2)}
                    </pre>
                    <div className="mt-1 break-all font-mono text-[11px] text-[var(--color-subtle)]">
                      sha256: {r.payload_hash}
                    </div>
                  </details>

                  {decisionFor === r.id ? (
                    <div className="space-y-2 rounded-md border border-[var(--color-border)] p-2">
                      <Input
                        placeholder="decision note (optional)"
                        value={decisionReason}
                        onChange={(e) => setDecisionReason(e.target.value)}
                        aria-label="decision reason"
                      />
                      {decisionError && <ErrorBox message={decisionError} />}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="accent"
                          disabled={decisionBusy}
                          onClick={() => decide(r.id, "approve")}
                        >
                          <CheckCircle
                            weight="duotone"
                            className="size-3.5"
                          />
                          approve
                        </Button>
                        <Button
                          variant="danger"
                          disabled={decisionBusy}
                          onClick={() => decide(r.id, "reject")}
                        >
                          <XCircle weight="duotone" className="size-3.5" />
                          reject
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={decisionBusy}
                          onClick={() => decide(r.id, "cancel")}
                          title="Only the original requester can cancel"
                        >
                          <Trash weight="duotone" className="size-3.5" />
                          cancel
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={decisionBusy}
                          onClick={() => {
                            setDecisionFor(null);
                            setDecisionReason("");
                            setDecisionError(null);
                          }}
                        >
                          dismiss
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setDecisionFor(r.id);
                          setDecisionReason("");
                          setDecisionError(null);
                        }}
                      >
                        decide
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="History"
            hint="Every decided, executed, cancelled, or expired request, newest first."
          />
          {requests.isLoading ? (
            <Skeleton className="h-24" />
          ) : historyEntries.length === 0 ? (
            <Empty
              title="No historical requests yet"
              hint="Approved and rejected requests will be listed here."
            />
          ) : (
            <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
              {historyEntries.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[13px]">
                        {r.action_type}
                      </span>
                      {statusBadge(r.status, r.expired)}
                    </div>
                    {r.summary && (
                      <div className="text-[12px] text-[var(--color-fg)]">
                        {r.summary}
                      </div>
                    )}
                    <div className="text-[11px] text-[var(--color-subtle)]">
                      #{r.id} · {r.requested_by} to{" "}
                      {r.decided_by ?? "no decision"} ·{" "}
                      {fmtTime(r.decided_at ?? r.requested_at)}
                    </div>
                    {r.decision_reason && (
                      <div className="text-[12px] text-[var(--color-subtle)]">
                        note: {r.decision_reason}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="rounded-md border border-[var(--color-border)] p-3 text-[12px] text-[var(--color-subtle)]">
          <div className="flex items-center gap-1.5 font-medium text-[var(--color-fg)]">
            <WarningCircle weight="duotone" className="size-4" />
            How it wires in
          </div>
          <p className="mt-1">
            Once an action_type is gated, the API route enforcing that
            action rejects single-admin calls with HTTP 428 and a
            <code className="font-mono">dual_control_required</code>
            error code. The route binds the approval to a SHA-256 hash of
            the exact payload; changing the payload between request and
            execution invalidates the approval. The first action wired
            through this gate is <code className="font-mono">legal_hold.release</code>.
          </p>
        </div>
      </div>
    </main>
  );
}
