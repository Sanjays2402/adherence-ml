/**
 * Self-service rotation of the currently-authenticated API key.
 *
 *   curl -X POST http://localhost:3000/v1/keys/me/rotate \
 *     -H "authorization: Bearer adh_OLD..." \
 *     -H "content-type: application/json" \
 *     -d '{"confirm": true}'
 *
 * Returns the new plaintext exactly once. Same key id, same scopes, same
 * created_at, same usage counters; only the secret material changes. The
 * old secret is invalidated atomically. Caller must replace it in their
 * config before the next request.
 *
 * Why this exists: enterprise security teams require a "rotate now" path
 * that does not need dashboard access. Incident responders rotating a
 * leaked key from a shell at 3am should not have to log into the UI.
 *
 * Gating: possession of the key is the authority. We require an explicit
 * `{"confirm": true}` body so a curl typo or webhook replay cannot
 * accidentally roll a production credential. Rotation is recorded in the
 * dashboard audit log (action: api_key.rotate.self) and counted against
 * the key's daily usage, with the standard X-RateLimit-* headers on the
 * response.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  clientIpFromHeaders,
  extractKey,
  ipAllowedForKey,
  isExpired,
  publicView,
  rotateKey,
  verifyKey,
} from "@/lib/api-keys-store";
import { recordKeyUsage } from "@/lib/api-key-usage-store";
import { rateLimitHeaders, readBudget } from "@/lib/v1-ratelimit";
import { recordAudit } from "@/lib/dashboard-audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({
  confirm: z.literal(true, {
    errorMap: () => ({
      message: "set 'confirm' to true to acknowledge this invalidates the current key",
    }),
  }),
});

function unauthorized(detail: string): NextResponse {
  return NextResponse.json({ detail }, { status: 401 });
}

export async function POST(req: NextRequest) {
  const presented = extractKey(req.headers);
  if (!presented) {
    return unauthorized(
      "missing api key. send Authorization: Bearer <key> or x-api-key: <key>",
    );
  }
  const key = await verifyKey(presented);
  if (!key || key.revoked || isExpired(key)) {
    return unauthorized("invalid, revoked, or expired api key");
  }
  if (!ipAllowedForKey(key, clientIpFromHeaders(req.headers))) {
    return NextResponse.json(
      { detail: "source ip not allowed for this api key" },
      { status: 403 },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { detail: "invalid json body; expected {\"confirm\": true}" },
      { status: 400 },
    );
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        detail: "rotation requires explicit confirmation",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const started = Date.now();
  const issued = await rotateKey(key.id);
  if (!issued) {
    // race: revoked or expired between verify + rotate
    void recordKeyUsage({
      key_id: key.id,
      ts: Date.now(),
      method: "POST",
      path: "/v1/keys/me/rotate",
      status: 409,
      latency_ms: Date.now() - started,
    }).catch(() => {});
    return NextResponse.json(
      { detail: "key state changed during rotation; refresh and retry" },
      { status: 409 },
    );
  }

  void recordKeyUsage({
    key_id: key.id,
    ts: Date.now(),
    method: "POST",
    path: "/v1/keys/me/rotate",
    status: 200,
    latency_ms: Date.now() - started,
  }).catch(() => {});

  void recordAudit({
    action: "api_key.rotate.self",
    target: key.id,
    outcome: "success",
    actor: null,
    request: req,
    metadata: {
      key_name: key.name,
      old_prefix: key.prefix,
      new_prefix: issued.record.prefix,
      via: "v1_self_rotate",
    },
  }).catch(() => {});

  const budget = await readBudget(issued.record);
  const headers = rateLimitHeaders(budget, 1);

  return NextResponse.json(
    {
      ...publicView(issued.record),
      key: issued.plaintext, // shown exactly once
      notice:
        "store this value now; the previous secret is invalid as of this response",
    },
    { headers },
  );
}
