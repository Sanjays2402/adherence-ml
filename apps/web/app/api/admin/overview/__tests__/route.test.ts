/**
 * Admin overview route: enforces owner-only access and cross-tenant isolation.
 *
 * Proves:
 *   - Anonymous caller gets 401
 *   - Editor (non-owner) caller gets 403 and a denied audit entry is written
 *   - Owner of workspace A cannot view workspace B (404, no leak)
 *   - Owner gets a complete payload (members, sessions, keys, audit, usage, policy)
 *
 * Run with: pnpm tsx app/api/admin/overview/__tests__/route.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(path.join(tmpdir(), "admin-overview-"));
process.env.ADHERENCE_DATA_DIR = tmp;
process.env.ADHERENCE_SESSION_SECRET = "test-secret-do-not-use-in-prod-0123456789";

function fail(msg: string): never {
  console.error("FAIL:", msg);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
function ok(cond: unknown, msg: string) {
  if (!cond) fail(msg);
}

async function makeReq(
  url: string,
  cookie?: string,
): Promise<import("next/server").NextRequest> {
  const { NextRequest } = await import("next/server");
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  headers.set("x-forwarded-for", "10.1.2.3");
  return new NextRequest(url, { headers });
}

async function makeSessionCookie(uid: string, email: string): Promise<string> {
  const { signSession, SESSION_COOKIE } = await import("../../../../../lib/session");
  const now = Date.now();
  const raw = signSession({
    uid,
    eml: email,
    iat: now,
    exp: now + 3600_000,
    gen: 1,
  } as unknown as Parameters<typeof signSession>[0]);
  return `${SESSION_COOKIE}=${encodeURIComponent(raw)}`;
}

async function main() {
  const { getOrCreateUserByEmail } = await import("../../../../../lib/users-store");
  const {
    createWorkspace,
    provisionMember,
  } = await import("../../../../../lib/workspaces-store");
  const { GET } = await import("../route");
  const { listAudit, _resetForTests: resetAudit } = await import(
    "../../../../../lib/dashboard-audit"
  );

  resetAudit();

  // Two owners, two workspaces, one editor on workspace A.
  const alice = await getOrCreateUserByEmail("alice@acme.test");
  const bob = await getOrCreateUserByEmail("bob@acme.test");
  const eve = await getOrCreateUserByEmail("eve@acme.test");

  const wsA = await createWorkspace(alice.id, alice.email, "acme");
  const wsB = await createWorkspace(bob.id, bob.email, "globex");

  await provisionMember(wsA.id, eve.email, "editor");

  // 1. Anonymous = 401
  {
    const req = await makeReq(
      `http://localhost/api/admin/overview?workspace_id=${wsA.id}`,
    );
    const res = await GET(req);
    ok(res.status === 401, `anon should be 401, got ${res.status}`);
  }

  // 2. Editor on workspace A = 403 and a denied audit entry is written
  {
    const cookie = await makeSessionCookie(eve.id, eve.email);
    const req = await makeReq(
      `http://localhost/api/admin/overview?workspace_id=${wsA.id}`,
      cookie,
    );
    const res = await GET(req);
    ok(res.status === 403, `editor should be 403, got ${res.status}`);
    const audit = await listAudit({ action: "admin.console.view", limit: 10 });
    const denied = audit.items.find(
      (e) => e.outcome === "denied" && e.actor_user_id === eve.id,
    );
    ok(!!denied, "denied audit entry should be written for editor");
    ok(audit.chain_valid, "audit chain must remain valid");
  }

  // 3. Alice (owner of A) asking for B = 404 (no cross-tenant leak)
  {
    const cookie = await makeSessionCookie(alice.id, alice.email);
    const req = await makeReq(
      `http://localhost/api/admin/overview?workspace_id=${wsB.id}`,
      cookie,
    );
    const res = await GET(req);
    ok(
      res.status === 404,
      `cross-tenant owner should be 404, got ${res.status}`,
    );
  }

  // 4. Missing workspace_id = 400
  {
    const cookie = await makeSessionCookie(alice.id, alice.email);
    const req = await makeReq(`http://localhost/api/admin/overview`, cookie);
    const res = await GET(req);
    ok(res.status === 400, `missing param should be 400, got ${res.status}`);
  }

  // 5. Alice (owner of A) gets a full payload
  {
    const cookie = await makeSessionCookie(alice.id, alice.email);
    const req = await makeReq(
      `http://localhost/api/admin/overview?workspace_id=${wsA.id}`,
      cookie,
    );
    const res = await GET(req);
    ok(res.status === 200, `owner should be 200, got ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    ok(body.role === "owner", `expected role=owner, got ${String(body.role)}`);
    ok(
      Array.isArray(body.members) && (body.members as unknown[]).length === 2,
      `expected 2 members (alice + eve), got ${JSON.stringify(body.members)}`,
    );
    ok(
      typeof body.usage === "object" && body.usage !== null,
      "usage block present",
    );
    ok(
      typeof body.audit === "object" && body.audit !== null,
      "audit block present",
    );
    ok(Array.isArray(body.api_keys), "api_keys array present");
    ok(Array.isArray(body.sessions), "sessions array present");
    const wsObj = body.workspace as Record<string, unknown>;
    ok(wsObj?.id === wsA.id, "returned workspace id matches");
  }

  console.log("OK: admin overview route owner-gating + isolation");
  rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
