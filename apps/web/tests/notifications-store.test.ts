import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-notif-"));
process.env.ADHERENCE_DATA_DIR = tmp;

const store = await import("../lib/notifications-store");

beforeEach(async () => {
  await store.__resetForTests();
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("notifications-store", () => {
  it("creates and lists per-user notifications", async () => {
    await store.createNotification({
      user_id: "u1",
      kind: "run.completed",
      title: "First run",
      body: "done",
    });
    await store.createNotification({
      user_id: "u2",
      kind: "run.completed",
      title: "Other user run",
      body: "done",
    });

    const u1 = await store.listForUser("u1");
    expect(u1).toHaveLength(1);
    expect(u1[0].title).toBe("First run");
    expect(u1[0].read_for_user).toBe(false);

    const u2 = await store.listForUser("u2");
    expect(u2).toHaveLength(1);
    expect(u2[0].title).toBe("Other user run");
  });

  it("broadcasts (user_id null) are visible to everyone but read-state is per user", async () => {
    const b = await store.createNotification({
      user_id: null,
      kind: "system",
      title: "Maintenance window",
      body: "tonight",
    });
    const u1 = await store.listForUser("u1");
    const u2 = await store.listForUser("u2");
    expect(u1.find((n) => n.id === b.id)?.read_for_user).toBe(false);
    expect(u2.find((n) => n.id === b.id)?.read_for_user).toBe(false);

    await store.markRead("u1", b.id);
    const u1after = await store.listForUser("u1");
    const u2after = await store.listForUser("u2");
    expect(u1after.find((n) => n.id === b.id)?.read_for_user).toBe(true);
    expect(u2after.find((n) => n.id === b.id)?.read_for_user).toBe(false);
  });

  it("markRead refuses to flip another user's targeted record", async () => {
    const n = await store.createNotification({
      user_id: "owner",
      kind: "run.completed",
      title: "Private",
      body: "",
    });
    const ok = await store.markRead("intruder", n.id);
    expect(ok).toBe(false);
    const fromOwner = await store.listForUser("owner");
    expect(fromOwner[0].read_for_user).toBe(false);
  });

  it("markAllRead clears every unread targeted + broadcast notification for a user", async () => {
    await store.createNotification({ user_id: "u1", kind: "run.completed", title: "a", body: "" });
    await store.createNotification({ user_id: "u1", kind: "batch.completed", title: "b", body: "" });
    await store.createNotification({ user_id: null, kind: "system", title: "c", body: "" });
    await store.createNotification({ user_id: "u2", kind: "run.completed", title: "d", body: "" });

    expect(await store.unreadCountForUser("u1")).toBe(3);
    const marked = await store.markAllRead("u1");
    expect(marked).toBeGreaterThanOrEqual(3);
    expect(await store.unreadCountForUser("u1")).toBe(0);
    // u2 is untouched
    expect(await store.unreadCountForUser("u2")).toBe(2); // their own + the broadcast
  });

  it("unreadOnly filter excludes already-read items", async () => {
    const a = await store.createNotification({ user_id: "u1", kind: "run.completed", title: "a", body: "" });
    await store.createNotification({ user_id: "u1", kind: "run.completed", title: "b", body: "" });
    await store.markRead("u1", a.id);
    const all = await store.listForUser("u1");
    const unread = await store.listForUser("u1", { unreadOnly: true });
    expect(all).toHaveLength(2);
    expect(unread).toHaveLength(1);
    expect(unread[0].title).toBe("b");
  });
});
