/**
 * Idempotency middleware for mutating API routes.
 *
 * Usage at the top of a POST handler:
 *
 *   const idem = await beginIdempotency(req, workspaceId, rawBody);
 *   if (idem.kind === "replay") return idem.response;
 *   if (idem.kind === "conflict") return idem.response;
 *   if (idem.kind === "invalid") return idem.response;
 *   // ... do the work, build `response: NextResponse` ...
 *   return idem.kind === "live" ? await finishIdempotency(idem, response) : response;
 *
 * Only callers that present an `Idempotency-Key` header opt into caching.
 * Calls without the header behave exactly as before, so existing clients
 * are unaffected.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  IDEMPOTENCY_BODY_MAX_BYTES,
  hashRequest,
  isValidIdempotencyKey,
  lookupRecord,
  storeRecord,
} from "./idempotency-store";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const REPLAY_HEADER = "Idempotent-Replay";

export type IdempotencyOutcome =
  | { kind: "none" }
  | {
      kind: "live";
      workspaceId: string;
      key: string;
      requestHash: string;
    }
  | { kind: "replay"; response: NextResponse }
  | { kind: "conflict"; response: NextResponse }
  | { kind: "invalid"; response: NextResponse };

function readKey(req: NextRequest): string | null {
  // Accept any common header casing.
  return (
    req.headers.get(IDEMPOTENCY_HEADER) ??
    req.headers.get(IDEMPOTENCY_HEADER.toLowerCase())
  );
}

function jsonError(status: number, detail: string, extras: Record<string, unknown> = {}) {
  return NextResponse.json({ detail, ...extras }, { status });
}

/**
 * Inspect the inbound request for an `Idempotency-Key`. If absent, returns
 * { kind: "none" } and the caller proceeds normally. If present:
 *   - `replay`: a previous identical request body is cached; the caller
 *     must return `response` verbatim (it carries the cached status/body
 *     plus `Idempotent-Replay: true`).
 *   - `conflict`: same key, different body, the cache returns a 409 so the
 *     client learns it is reusing a key for a different request.
 *   - `invalid`: header is malformed; 400 response is returned for the
 *     caller to send back.
 *   - `live`: nothing cached yet; the caller should run the handler and,
 *     on success, call `finishIdempotency(...)` with its response so the
 *     result is cached for the next retry.
 */
export async function beginIdempotency(
  req: NextRequest,
  workspaceId: string,
  rawBody: string | null,
): Promise<IdempotencyOutcome> {
  const key = readKey(req);
  if (!key) return { kind: "none" };
  if (!isValidIdempotencyKey(key)) {
    return {
      kind: "invalid",
      response: jsonError(400, "invalid Idempotency-Key header", {
        code: "idempotency_key_invalid",
      }),
    };
  }
  if (rawBody && rawBody.length > IDEMPOTENCY_BODY_MAX_BYTES) {
    return {
      kind: "invalid",
      response: jsonError(413, "request body too large for idempotency caching", {
        code: "idempotency_body_too_large",
        max_bytes: IDEMPOTENCY_BODY_MAX_BYTES,
      }),
    };
  }
  const url = new URL(req.url);
  const requestHash = hashRequest(req.method, url.pathname, rawBody);
  const existing = await lookupRecord(workspaceId, key);
  if (existing) {
    if (existing.request_hash !== requestHash) {
      return {
        kind: "conflict",
        response: jsonError(
          409,
          "Idempotency-Key reused with a different request body",
          {
            code: "idempotency_key_conflict",
            cached_at: new Date(existing.created_at).toISOString(),
          },
        ),
      };
    }
    const replay = new NextResponse(existing.body, {
      status: existing.status,
      headers: {
        "content-type": existing.content_type || "application/json",
        [REPLAY_HEADER]: "true",
        [IDEMPOTENCY_HEADER]: key,
      },
    });
    return { kind: "replay", response: replay };
  }
  return { kind: "live", workspaceId, key, requestHash };
}

/**
 * Cache a successful response for future replay. Only 2xx responses are
 * cached; errors are intentionally not (so the client can retry once the
 * underlying problem is fixed without first being forced to mint a new
 * Idempotency-Key).
 */
export async function finishIdempotency(
  live: Extract<IdempotencyOutcome, { kind: "live" }>,
  response: NextResponse,
): Promise<NextResponse> {
  if (response.status < 200 || response.status >= 300) return response;
  // Clone before reading the body; NextResponse bodies are streams.
  const cloned = response.clone();
  const text = await cloned.text();
  const contentType = response.headers.get("content-type") ?? "application/json";
  await storeRecord(
    live.workspaceId,
    live.key,
    live.requestHash,
    response.status,
    text,
    contentType,
  );
  // Echo the key back so the client can correlate.
  response.headers.set(IDEMPOTENCY_HEADER, live.key);
  return response;
}
