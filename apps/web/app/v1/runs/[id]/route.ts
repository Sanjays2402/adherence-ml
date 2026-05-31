/**
 * Public, key-authenticated single-run endpoints.
 *
 *   curl http://localhost:3000/v1/runs/<id> \
 *     -H "authorization: Bearer adh_..."
 *
 *   curl -X PATCH http://localhost:3000/v1/runs/<id> \
 *     -H "authorization: Bearer adh_..." \
 *     -H "content-type: application/json" \
 *     -d '{"title":"renamed","tags":["billed","q3"]}'
 *
 *   curl -X DELETE http://localhost:3000/v1/runs/<id> \
 *     -H "authorization: Bearer adh_..."
 *
 * GET requires the "read" scope. PATCH and DELETE require the "predict"
 * scope, the same scope used for creating runs. This gives customers a
 * full CRUD surface so they can rename, retag, and clean up runs from
 * their own dashboards without screen-scraping /history.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  clientIpFromHeaders,
  extractKey,
  hasScope,
  ipAllowedForKey,
  type ApiKeyRecord,
  verifyKey,
} from "@/lib/api-keys-store";
import { recordKeyUsage } from "@/lib/api-key-usage-store";
import { deleteRun, getRun, updateRun } from "@/lib/runs-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function badId() {
  return NextResponse.json({ detail: "invalid run id" }, { status: 400 });
}

function isValidId(id: string | undefined | null): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(id)
  );
}

type AuthResult =
  | { err: NextResponse; key?: undefined }
  | { err?: undefined; key: ApiKeyRecord };

async function requireKey(
  req: NextRequest,
  scope: "read" | "predict",
): Promise<AuthResult> {
  const presented = extractKey(req.headers);
  if (!presented) {
    return {
      err: NextResponse.json(
        { detail: "missing api key. send Authorization: Bearer <key> or x-api-key: <key>" },
        { status: 401 },
      ),
    };
  }
  const key = await verifyKey(presented, { client_ip: (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null, user_agent: req.headers.get("user-agent") });
  if (!key) {
    return {
      err: NextResponse.json(
        { detail: "invalid or revoked api key" },
        { status: 401 },
      ),
    };
  }
  if (!ipAllowedForKey(key, clientIpFromHeaders(req.headers))) {
    return {
      err: NextResponse.json(
        { detail: "source ip not allowed for this api key" },
        { status: 403 },
      ),
    };
  }
  if (!ipAllowedForKey(key, clientIpFromHeaders(req.headers))) {
    return {
      err: NextResponse.json(
        { detail: "source ip not allowed for this api key" },
        { status: 403 },
      ),
    };
  }
  if (!hasScope(key, scope)) {
    return {
      err: NextResponse.json(
        {
          detail: `this key is missing the '${scope}' scope`,
          required_scope: scope,
          key_scopes: key.scopes ?? [],
        },
        { status: 403 },
      ),
    };
  }
  return { key };
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireKey(req, "read");
  if (auth.err) return auth.err;
  const { key } = auth;

  const { id } = await ctx.params;
  if (!isValidId(id)) return badId();

  const rec = await getRun(id);
  if (!rec) {
    void recordKeyUsage({
      key_id: key.id,
      ts: Date.now(),
      method: "GET",
      path: "/v1/runs/[id]",
      status: 404,
      latency_ms: 0,
    }).catch(() => {});
    return NextResponse.json({ detail: "run not found" }, { status: 404 });
  }

  void recordKeyUsage({
    key_id: key.id,
    ts: Date.now(),
    method: "GET",
    path: "/v1/runs/[id]",
    status: 200,
    latency_ms: 0,
  }).catch(() => {});
  return NextResponse.json({
    id: rec.id,
    created_at: rec.created_at,
    kind: rec.kind,
    title: rec.title,
    summary: rec.summary,
    user_id: rec.user_id,
    latency_ms: rec.latency_ms,
    tags: rec.tags,
    shared: Boolean(rec.share_token),
    share_url: rec.share_token ? `/share/${rec.share_token}` : null,
    payload: rec.payload,
  });
}

const PatchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    tags: z.array(z.string().min(1).max(40)).max(12).optional(),
  })
  .refine((v) => v.title !== undefined || v.tags !== undefined, {
    message: "must include 'title' or 'tags'",
  });

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireKey(req, "predict");
  if (auth.err) return auth.err;
  const { key } = auth;

  const { id } = await ctx.params;
  if (!isValidId(id)) return badId();

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { detail: "request body was not valid JSON" },
      { status: 400 },
    );
  }
  const parsed = PatchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "validation_failed", errors: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const existing = await getRun(id);
  if (!existing) {
    void recordKeyUsage({
      key_id: key.id,
      ts: Date.now(),
      method: "PATCH",
      path: "/v1/runs/[id]",
      status: 404,
      latency_ms: 0,
    }).catch(() => {});
    return NextResponse.json({ detail: "run not found" }, { status: 404 });
  }

  const patch: { title?: string; tags?: string[] } = {};
  if (parsed.data.title !== undefined) patch.title = parsed.data.title.trim();
  if (parsed.data.tags !== undefined) {
    // normalise: trim, dedupe, drop empties
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of parsed.data.tags) {
      const v = t.trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    patch.tags = out;
  }

  const updated = await updateRun(id, patch);
  void recordKeyUsage({
    key_id: key.id,
    ts: Date.now(),
    method: "PATCH",
    path: "/v1/runs/[id]",
    status: 200,
    latency_ms: 0,
  }).catch(() => {});
  return NextResponse.json({
    id: updated!.id,
    title: updated!.title,
    tags: updated!.tags,
    updated: true,
  });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireKey(req, "predict");
  if (auth.err) return auth.err;
  const { key } = auth;

  const { id } = await ctx.params;
  if (!isValidId(id)) return badId();

  const ok = await deleteRun(id);
  void recordKeyUsage({
    key_id: key.id,
    ts: Date.now(),
    method: "DELETE",
    path: "/v1/runs/[id]",
    status: ok ? 200 : 404,
    latency_ms: 0,
  }).catch(() => {});
  if (!ok) {
    return NextResponse.json({ detail: "run not found" }, { status: 404 });
  }
  return NextResponse.json({ id, deleted: true });
}
