/**
 * Smoke test for the share store: round-trip a record through the
 * filesystem-backed store and verify retrieval + validation.
 *
 * Run with:  pnpm tsx app/api/shares/__tests__/shares.test.ts
 * or:        node --import tsx app/api/shares/__tests__/shares.test.ts
 *
 * No test runner required; exits non-zero on failure.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

async function main() {
  // Sandbox cwd to a tmp dir so the real .data/shares.json isn't touched.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "adh-shares-"));
  const origCwd = process.cwd();
  process.chdir(tmp);
  try {
    const mod = await import("../../../../lib/shares.ts");
    const { createShare, getShare, newShareId, listShares, deleteShare } = mod;

    const id = newShareId();
    if (!/^[a-z0-9]{10}$/.test(id)) {
      throw new Error(`bad id shape: ${id}`);
    }

    const rec = await createShare({
      user_id: "test-user",
      top_k: 3,
      rows: [
        { dose_id: "d1", scheduled_at: "2025-01-01T00:00:00Z", dose_class: "cardio", dose_strength_mg: 10 },
      ],
      result: {
        user_id: "test-user",
        model_version: "test-v1",
        predictions: [
          {
            dose_id: "d1",
            scheduled_at: "2025-01-01T00:00:00Z",
            miss_probability: 0.42,
            risk_tier: "medium",
            reasons: [],
          },
        ],
      },
      latency_ms: 17,
    });

    if (!rec.id || rec.id.length < 6) throw new Error("created share missing id");
    if (rec.user_id !== "test-user") throw new Error("user_id round-trip failed");

    const fetched = await getShare(rec.id);
    if (!fetched) throw new Error("getShare returned null for known id");
    if (fetched.result.predictions[0].miss_probability !== 0.42) {
      throw new Error("prediction payload corrupted");
    }
    if (fetched.latency_ms !== 17) throw new Error("latency_ms round-trip failed");

    const missing = await getShare("doesnotexist1");
    if (missing !== null) throw new Error("getShare should return null for unknown id");

    const invalid = await getShare("BAD!ID");
    if (invalid !== null) throw new Error("getShare should reject malformed id");

    const onDisk = JSON.parse(
      await fs.readFile(path.join(tmp, ".data", "shares.json"), "utf8"),
    );
    if (onDisk.version !== 1 || onDisk.shares.length !== 1) {
      throw new Error("on-disk store malformed");
    }

    // listShares: scope to user, search, pagination
    await createShare({
      user_id: "other-user",
      top_k: 1,
      rows: [
        { dose_id: "d2", scheduled_at: "2025-02-01T00:00:00Z", dose_class: "neuro", dose_strength_mg: 5 },
      ],
      result: {
        user_id: "other-user",
        model_version: "test-v1",
        predictions: [
          {
            dose_id: "d2",
            scheduled_at: "2025-02-01T00:00:00Z",
            miss_probability: 0.81,
            risk_tier: "high",
            reasons: [],
          },
        ],
      },
      latency_ms: 9,
      title: "Other user share",
    });

    const mine = await listShares({ user_id: "test-user" });
    if (mine.total !== 1) throw new Error(`listShares scope failed: ${mine.total}`);
    if (mine.items[0].id !== rec.id) throw new Error("listShares returned wrong record");
    if (mine.items[0].top_risk !== 0.42) throw new Error("summary top_risk wrong");
    if (mine.items[0].prediction_count !== 1) throw new Error("summary count wrong");

    const all = await listShares({});
    if (all.total !== 2) throw new Error(`listShares all failed: ${all.total}`);

    const searched = await listShares({ q: "other user" });
    if (searched.total !== 1 || searched.items[0].user_id !== "other-user") {
      throw new Error("listShares search failed");
    }

    // deleteShare: forbidden when scoped to wrong user
    const forbidden = await deleteShare(rec.id, { user_id: "other-user" });
    if (forbidden.deleted || forbidden.reason !== "forbidden") {
      throw new Error("deleteShare should refuse cross-user delete");
    }
    if (await getShare(rec.id) === null) {
      throw new Error("forbidden delete should not have removed record");
    }

    const okDel = await deleteShare(rec.id, { user_id: "test-user" });
    if (!okDel.deleted) throw new Error("deleteShare failed for owner");
    if ((await getShare(rec.id)) !== null) {
      throw new Error("share should be gone after delete");
    }

    const ghost = await deleteShare("doesnotexist1");
    if (ghost.deleted || ghost.reason !== "not_found") {
      throw new Error("deleteShare should 404 unknown id");
    }

    // eslint-disable-next-line no-console
    console.log("ok: shares round-trip", rec.id);
  } finally {
    process.chdir(origCwd);
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("FAIL:", err);
  process.exit(1);
});
