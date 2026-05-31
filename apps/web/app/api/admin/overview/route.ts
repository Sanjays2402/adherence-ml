/**
 * Admin console aggregate endpoint.
 *
 * Owner-only. Returns workspace members, pending invites, active sessions
 * (per-member, last 90 days), API keys (workspace-wide), recent audit log
 * (last 50), usage summary, workspace security policy + SSO config in a
 * single payload so the owner gets a single pane of glass for SOC2-style
 * reviews without round-tripping six different endpoints.
 *
 * Denies non-owner callers with 403 and writes a denied audit entry so
 * misuse is observable. Cross-tenant isolation is enforced by routing all
 * member/session/key lookups through workspaces-store helpers that already
 * scope by workspace_id.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import {
  getWorkspaceForUser,
  listInvites,
  publicSso,
  publicPolicy,
} from "@/lib/workspaces-store";
import { listSessionsForUser } from "@/lib/sessions-store";
import { listKeys, publicView } from "@/lib/api-keys-store";
import { listAudit } from "@/lib/dashboard-audit";
import { summary as usageSummary } from "@/lib/usage-store";
import { recordAudit } from "@/lib/dashboard-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ctx = await getSession(req);
  if (!ctx) {
    return NextResponse.json({ detail: "auth required" }, { status: 401 });
  }

  const url = new URL(req.url);
  const wsId = url.searchParams.get("workspace_id");
  if (!wsId) {
    return NextResponse.json(
      { detail: "workspace_id required" },
      { status: 400 },
    );
  }

  const ws = await getWorkspaceForUser(wsId, ctx.user.id);
  if (!ws) {
    return NextResponse.json({ detail: "not found" }, { status: 404 });
  }

  if (ws.role !== "owner") {
    await recordAudit({
      action: "admin.console.view",
      target: wsId,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
      request: req,
      metadata: { reason: "not_owner", caller_role: ws.role },
    });
    return NextResponse.json({ detail: "owner only" }, { status: 403 });
  }

  // Aggregate. Each helper here already filters by user/workspace so there is
  // no cross-tenant leakage at the query layer.
  const invites = await listInvites(wsId);

  const memberSessions = await Promise.all(
    ws.members.map(async (m) => {
      const sessions = await listSessionsForUser(m.user_id);
      const now = Date.now();
      const active = sessions
        .filter((s) => s.expires_at > now && s.revoked_at === null)
        .map((s) => ({
          sid: s.sid,
          created_at: s.created_at,
          last_seen_at: s.last_seen_at,
          expires_at: s.expires_at,
          ip: s.ip,
          user_agent: s.user_agent ?? null,
        }));
      return { user_id: m.user_id, email: m.email, role: m.role, sessions: active };
    }),
  );

  const allKeys = await listKeys();
  const keys = allKeys.map(publicView);

  const audit = await listAudit({ limit: 50 });
  const usage = await usageSummary();

  await recordAudit({
    action: "admin.console.view",
    target: wsId,
    outcome: "success",
    actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
    request: req,
    metadata: { workspace_id: wsId, member_count: ws.members.length },
  });

  return NextResponse.json({
    workspace: {
      id: ws.workspace.id,
      name: ws.workspace.name,
      created_at: ws.workspace.created_at,
    },
    role: ws.role,
    members: ws.members,
    invites: invites
      .filter((i) => !i.revoked_at && !i.accepted_at)
      .map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        created_at: i.created_at,
        expires_at: i.expires_at,
      })),
    sessions: memberSessions,
    api_keys: keys,
    audit: {
      items: audit.items,
      chain_valid: audit.chain_valid,
      tip_hash: audit.tip_hash,
    },
    usage: {
      quota: usage.quota,
      used_today: usage.used_today,
      remaining_today: usage.remaining_today,
      pct_today: usage.pct_today,
      used_30d: usage.used_30d,
    },
    policy: publicPolicy(ws.workspace.security_policy),
    sso: publicSso(ws.workspace.sso),
  });
}
