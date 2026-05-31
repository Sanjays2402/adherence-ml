import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "scim-groups-"));
  process.env.ADHERENCE_DATA_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

async function bearer(token: string) {
  return { authorization: `Bearer ${token}` } as Record<string, string>;
}

describe("SCIM Groups + cross-tenant isolation", () => {
  it("lists three role groups scoped to the workspace", async () => {
    const ws = await import("../lib/workspaces-store");
    const scim = await import("../lib/scim-store");
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    const token = await scim.createToken(wsA.id, "alice@example.com", "test");

    await ws.provisionMember(wsA.id, "bob@example.com", "editor");
    await ws.provisionMember(wsA.id, "carol@example.com", "viewer");

    const { GET } = await import("../app/scim/v2/Groups/route");
    const req = new Request("http://localhost/scim/v2/Groups", {
      headers: await bearer(token.plaintext),
    }) as unknown as import("next/server").NextRequest;
    const res = await GET(req);
    expect(res!.status).toBe(200);
    const body = await res.json();
    expect(body.totalResults).toBe(3);
    const names = body.Resources.map((g: { displayName: string }) => g.displayName).sort();
    expect(names).toEqual(["editors", "owners", "viewers"]);
    const editors = body.Resources.find(
      (g: { displayName: string }) => g.displayName === "editors",
    );
    expect(editors.members.map((m: { display: string }) => m.display)).toContain(
      "bob@example.com",
    );
    expect(editors.id).toBe(`${wsA.id}:editors`);
  });

  it("PATCH add on Group changes a member's role and writes an audit entry", async () => {
    const ws = await import("../lib/workspaces-store");
    const scim = await import("../lib/scim-store");
    const audit = await import("../lib/dashboard-audit");
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    const token = await scim.createToken(wsA.id, "alice@example.com", "test");

    const r = await ws.provisionMember(wsA.id, "bob@example.com", "viewer");
    expect((await ws.findMember(wsA.id, r.user_id))!.role).toBe("viewer");

    const { PATCH } = await import("../app/scim/v2/Groups/[id]/route");
    const req = new Request(`http://localhost/scim/v2/Groups/${wsA.id}:editors`, {
      method: "PATCH",
      headers: { ...(await bearer(token.plaintext)), "content-type": "application/scim+json" },
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "add", path: "members", value: [{ value: r.user_id }] }],
      }),
    }) as unknown as import("next/server").NextRequest;
    const res = await PATCH(req as any, {
      params: Promise.resolve({ id: `${wsA.id}:editors` }),
    });
    expect(res!.status).toBe(200);
    expect((await ws.findMember(wsA.id, r.user_id))!.role).toBe("editor");

    const entries = await audit.listAudit({ action: "scim.group.patch", limit: 5 });
    expect(entries.items.some((e) => e.action === "scim.group.patch")).toBe(true);
  });

  it("a token for workspace A cannot mutate groups in workspace B", async () => {
    const ws = await import("../lib/workspaces-store");
    const scim = await import("../lib/scim-store");
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    const [wsB] = await ws.listForUser("u_carol", "carol@example.com");
    expect(wsA.id).not.toBe(wsB.id);

    // Provision a viewer in B; A's token must not be able to promote them.
    const victim = await ws.provisionMember(wsB.id, "victim@example.com", "viewer");
    const tokenA = await scim.createToken(wsA.id, "alice@example.com", "evil");

    const { GET, PATCH } = await import("../app/scim/v2/Groups/[id]/route");

    // GET: cross-tenant id is 404 under A's token.
    const getReq = new Request(
      `http://localhost/scim/v2/Groups/${wsB.id}:editors`,
      { headers: await bearer(tokenA.plaintext) },
    ) as unknown as import("next/server").NextRequest;
    const getRes = await GET(getReq as any, {
      params: Promise.resolve({ id: `${wsB.id}:editors` }),
    });
    expect(getRes!.status).toBe(404);

    // PATCH: cross-tenant id is also 404; victim's role must stay viewer.
    const patchReq = new Request(
      `http://localhost/scim/v2/Groups/${wsB.id}:editors`,
      {
        method: "PATCH",
        headers: {
          ...(await bearer(tokenA.plaintext)),
          "content-type": "application/scim+json",
        },
        body: JSON.stringify({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "add", path: "members", value: [{ value: victim.user_id }] }],
        }),
      },
    ) as unknown as import("next/server").NextRequest;
    const patchRes = await PATCH(patchReq as any, {
      params: Promise.resolve({ id: `${wsB.id}:editors` }),
    });
    expect(patchRes!.status).toBe(404);

    const after = await ws.findMember(wsB.id, victim.user_id);
    expect(after!.role).toBe("viewer");
  });

  it("refuses to demote the last owner via Group remove", async () => {
    const ws = await import("../lib/workspaces-store");
    const scim = await import("../lib/scim-store");
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    const token = await scim.createToken(wsA.id, "alice@example.com", "test");
    const owner = (await ws.listMembers(wsA.id)).find((m) => m.role === "owner")!;

    const { PATCH } = await import("../app/scim/v2/Groups/[id]/route");
    const req = new Request(`http://localhost/scim/v2/Groups/${wsA.id}:owners`, {
      method: "PATCH",
      headers: { ...(await bearer(token.plaintext)), "content-type": "application/scim+json" },
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          { op: "remove", path: `members[value eq "${owner.user_id}"]` },
        ],
      }),
    }) as unknown as import("next/server").NextRequest;
    const res = await PATCH(req as any, {
      params: Promise.resolve({ id: `${wsA.id}:owners` }),
    });
    expect(res!.status).toBe(400);
    const after = await ws.findMember(wsA.id, owner.user_id);
    expect(after!.role).toBe("owner");
  });
});
