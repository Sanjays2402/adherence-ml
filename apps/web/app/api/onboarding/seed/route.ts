/**
 * Sample-data seeder. Populates the workspace so a brand new instance
 * does not feel empty: three saved runs spanning the demo personas,
 * one demo API key (revoked, for the curl example), and one inactive
 * webhook endpoint pointing at example.com. Idempotent on a per-store
 * basis: we never duplicate a sample row that is already present.
 */
import { NextResponse } from "next/server";
import { appendRun, listAllRuns, newRunId, type RunRecord } from "@/lib/runs-store";
import { createKey, listKeys, revokeKey } from "@/lib/api-keys-store";
import {
  createEndpoint,
  listEndpoints,
  setEndpointActive,
} from "@/lib/webhooks-store";
import { markSeeded, markStep } from "@/lib/onboarding-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SAMPLE_TAG = "sample";
const SAMPLE_KEY_NAME = "sample (revoked)";
const SAMPLE_WEBHOOK_NAME = "sample relay";
const SAMPLE_WEBHOOK_URL = "https://example.com/adherence/webhook";

const SAMPLE_RUNS: Array<Pick<RunRecord, "kind" | "title" | "summary" | "user_id" | "latency_ms" | "payload">> = [
  {
    kind: "demo",
    title: "Sample: stable hypertension",
    summary: "3 doses scored, 0 high risk, top driver: time_since_last_dose",
    user_id: "demo-stable-htn",
    latency_ms: 42,
    payload: {
      sample: true,
      persona: "stable-htn",
      top_miss_probability: 0.08,
      tiers: { low: 3, medium: 0, high: 0 },
    },
  },
  {
    kind: "demo",
    title: "Sample: slipping diabetes + SSRI",
    summary: "4 doses scored, 1 high risk, top driver: missed_in_last_72h",
    user_id: "demo-slipping-dm",
    latency_ms: 51,
    payload: {
      sample: true,
      persona: "slipping-dm",
      top_miss_probability: 0.71,
      tiers: { low: 1, medium: 2, high: 1 },
    },
  },
  {
    kind: "demo",
    title: "Sample: new antibiotic course",
    summary: "5 doses scored, 0 high risk, top driver: novelty_score",
    user_id: "demo-new-abx",
    latency_ms: 47,
    payload: {
      sample: true,
      persona: "new-abx",
      top_miss_probability: 0.22,
      tiers: { low: 4, medium: 1, high: 0 },
    },
  },
];

export async function POST() {
  const result = {
    runs_added: 0,
    runs_skipped: 0,
    api_key_added: false,
    api_key_skipped: false,
    api_key_plaintext: null as string | null,
    webhook_added: false,
    webhook_skipped: false,
  };

  // 1. Runs (idempotent by title + sample tag).
  const existingRuns = await listAllRuns();
  const existingTitles = new Set(
    existingRuns
      .filter((r) => r.tags?.includes(SAMPLE_TAG))
      .map((r) => r.title),
  );
  for (const r of SAMPLE_RUNS) {
    if (existingTitles.has(r.title)) {
      result.runs_skipped += 1;
      continue;
    }
    const rec: RunRecord = {
      id: newRunId(),
      created_at: Date.now() - Math.floor(Math.random() * 1000 * 60 * 60),
      kind: r.kind,
      title: r.title,
      summary: r.summary,
      user_id: r.user_id,
      latency_ms: r.latency_ms,
      payload: r.payload,
      tags: [SAMPLE_TAG, "onboarding"],
    };
    await appendRun(rec);
    result.runs_added += 1;
  }

  // 2. Demo API key (revoked so it cannot be used in production).
  const existingKeys = await listKeys();
  const existingSampleKey = existingKeys.find(
    (k) => k.name === SAMPLE_KEY_NAME,
  );
  if (!existingSampleKey) {
    const { record, plaintext } = await createKey(SAMPLE_KEY_NAME);
    await revokeKey(record.id);
    result.api_key_added = true;
    result.api_key_plaintext = plaintext;
  } else {
    result.api_key_skipped = true;
  }

  // 3. Sample webhook endpoint (inactive so it does not actually POST).
  const existingEndpoints = await listEndpoints();
  const sampleEndpoint = existingEndpoints.find(
    (e) => e.name === SAMPLE_WEBHOOK_NAME && e.url === SAMPLE_WEBHOOK_URL,
  );
  if (!sampleEndpoint) {
    try {
      const { record: endpoint } = await createEndpoint({
        name: SAMPLE_WEBHOOK_NAME,
        url: SAMPLE_WEBHOOK_URL,
      });
      await setEndpointActive(endpoint.id, false);
      result.webhook_added = true;
    } catch {
      // createEndpoint validates URL; example.com is valid so this is rare.
      result.webhook_skipped = true;
    }
  } else {
    result.webhook_skipped = true;
  }

  await markSeeded();
  await markStep("explore_demo", true);

  return NextResponse.json({ ok: true, ...result });
}
