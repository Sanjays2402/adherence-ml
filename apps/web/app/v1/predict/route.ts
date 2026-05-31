/**
 * Public, key-authenticated prediction endpoint.
 *
 *   curl -X POST http://localhost:3000/v1/predict \
 *     -H "authorization: Bearer adh_..." \
 *     -H "content-type: application/json" \
 *     -d '{"user_id":"u_123","doses":[{"dose_id":"d1","scheduled_at":"2025-01-01T08:00:00Z","dose_class":"statin","dose_strength_mg":20}]}'
 *
 * Accepts either `Authorization: Bearer <key>` or `x-api-key: <key>`.
 * Forwards a sanitised body to the upstream FastAPI predictor and
 * records the call in the runs store so it appears in /history.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";
import { extractKey, verifyKey } from "@/lib/api-keys-store";
import { appendRun, newRunId } from "@/lib/runs-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DoseSchema = z.object({
  dose_id: z.string().min(1),
  scheduled_at: z.string().min(1),
  dose_class: z.string().min(1),
  dose_strength_mg: z.number().nonnegative(),
});

const BodySchema = z.object({
  user_id: z.string().min(1),
  doses: z.array(DoseSchema).min(1).max(500),
  top_k: z.number().int().min(1).max(50).optional(),
});

export async function POST(req: NextRequest) {
  const presented = extractKey(req.headers);
  if (!presented) {
    return NextResponse.json(
      { detail: "missing api key. send Authorization: Bearer <key> or x-api-key: <key>" },
      { status: 401 },
    );
  }
  const key = await verifyKey(presented);
  if (!key) {
    return NextResponse.json({ detail: "invalid or revoked api key" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid json body" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const t0 = Date.now();
  try {
    const data = await apiFetch("/v1/predict", {
      method: "POST",
      body: JSON.stringify(parsed.data),
      headers: { "content-type": "application/json" },
    });
    const latency = Date.now() - t0;
    // best-effort: record in runs history under the key owner's name
    try {
      const s = data as Record<string, unknown>;
      const risk = typeof s.risk === "number" ? (s.risk as number) : null;
      const band =
        typeof s.band === "string"
          ? s.band
          : typeof s.risk_band === "string"
            ? (s.risk_band as string)
            : "";
      await appendRun({
        id: newRunId(),
        created_at: Date.now(),
        kind: "predict",
        title: `predict ${parsed.data.user_id}`,
        summary:
          risk !== null ? `risk ${(risk * 100).toFixed(1)}% ${band}`.trim() : band || "score",
        user_id: parsed.data.user_id,
        latency_ms: latency,
        payload: { request: parsed.data, response: data, via: "v1", key_id: key.id },
        tags: ["v1", `key:${key.prefix}`],
      });
    } catch {
      // never let bookkeeping break the user-facing call
    }
    return NextResponse.json(data, {
      headers: { "x-latency-ms": String(latency) },
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json(
        typeof err.body === "object" && err.body !== null
          ? err.body
          : { detail: err.message },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { detail: err instanceof Error ? err.message : "upstream error" },
      { status: 502 },
    );
  }
}

export async function GET() {
  return NextResponse.json(
    {
      endpoint: "/v1/predict",
      method: "POST",
      auth: "Authorization: Bearer <key>  or  x-api-key: <key>",
      example: {
        user_id: "u_123",
        doses: [
          {
            dose_id: "d1",
            scheduled_at: "2025-01-01T08:00:00Z",
            dose_class: "statin",
            dose_strength_mg: 20,
          },
        ],
      },
    },
    { status: 200 },
  );
}
