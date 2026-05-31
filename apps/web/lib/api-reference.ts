/**
 * Single source of truth for the public /v1 API documented on /docs.
 * Each entry lists the HTTP method, path, required scope, a one-line
 * description, and a copy-paste curl snippet. The test in
 * tests/api-reference.test.ts verifies every documented path resolves
 * to a real route file on disk, so this list cannot rot silently.
 */

export type ApiScope = "predict" | "read" | "webhooks";

export type ApiEndpoint = {
  id: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  routeFile: string;
  scope: ApiScope;
  group: "predict" | "runs" | "webhooks" | "keys";
  summary: string;
  curl: string;
  liveTestable: boolean;
};

const HOST = "$HOST";
const KEY = "$KEY";

export const API_BASE_HINT =
  "Point $HOST at your deployment (for example http://localhost:3000) and $KEY at any key from the API keys page.";

export const ENDPOINTS: ApiEndpoint[] = [
  {
    id: "predict",
    method: "POST",
    path: "/v1/predict",
    routeFile: "app/v1/predict/route.ts",
    scope: "predict",
    group: "predict",
    summary: "Score a batch of scheduled doses for one user. Returns per-dose risk plus a roll-up.",
    curl: `curl -X POST ${HOST}/v1/predict \\
  -H "authorization: Bearer ${KEY}" \\
  -H "content-type: application/json" \\
  -d '{
    "user_id": "u_123",
    "doses": [
      {
        "dose_id": "d1",
        "scheduled_at": "2025-01-01T08:00:00Z",
        "dose_class": "statin",
        "dose_strength_mg": 20
      }
    ]
  }'`,
    liveTestable: false,
  },
  {
    id: "batch",
    method: "POST",
    path: "/v1/batch",
    routeFile: "app/v1/batch/route.ts",
    scope: "predict",
    group: "predict",
    summary: "Score a CSV file. Upload multipart/form-data with the file under the field `file`.",
    curl: `curl -X POST ${HOST}/v1/batch \\
  -H "authorization: Bearer ${KEY}" \\
  -F "file=@doses.csv"`,
    liveTestable: false,
  },
  {
    id: "keys-me",
    method: "GET",
    path: "/v1/keys/me",
    routeFile: "app/v1/keys/me/route.ts",
    scope: "read",
    group: "keys",
    summary: "Introspect the calling API key. Returns name, prefix, scopes, and use count.",
    curl: `curl ${HOST}/v1/keys/me \\
  -H "authorization: Bearer ${KEY}"`,
    liveTestable: true,
  },
  {
    id: "keys-me-rotate",
    method: "POST",
    path: "/v1/keys/me/rotate",
    routeFile: "app/v1/keys/me/rotate/route.ts",
    scope: "read",
    group: "keys",
    summary: "Rotate the calling API key in place. Returns the new plaintext exactly once; the old secret stops working immediately. Body requires {\"confirm\": true}.",
    curl: `curl -X POST ${HOST}/v1/keys/me/rotate \\
  -H "authorization: Bearer ${KEY}" \\
  -H "content-type: application/json" \\
  -d '{\"confirm\": true}'`,
    liveTestable: false,
  },
  {
    id: "usage",
    method: "GET",
    path: "/v1/usage",
    routeFile: "app/v1/usage/route.ts",
    scope: "read",
    group: "keys",
    summary: "Read the daily quota, requests used today, and a 30 day usage window. Sends X-RateLimit headers. Does not consume quota.",
    curl: `curl -i ${HOST}/v1/usage \\
  -H "authorization: Bearer ${KEY}"`,
    liveTestable: true,
  },
  {
    id: "runs-list",
    method: "GET",
    path: "/v1/runs",
    routeFile: "app/v1/runs/route.ts",
    scope: "read",
    group: "runs",
    summary: "List recent runs. Supports `limit` and `cursor` for pagination.",
    curl: `curl "${HOST}/v1/runs?limit=20" \\
  -H "authorization: Bearer ${KEY}"`,
    liveTestable: true,
  },
  {
    id: "runs-get",
    method: "GET",
    path: "/v1/runs/{id}",
    routeFile: "app/v1/runs/[id]/route.ts",
    scope: "read",
    group: "runs",
    summary: "Fetch one full run by id, including the original input and the model output.",
    curl: `curl ${HOST}/v1/runs/RUN_ID \\
  -H "authorization: Bearer ${KEY}"`,
    liveTestable: false,
  },
  {
    id: "runs-export",
    method: "GET",
    path: "/v1/runs/export",
    routeFile: "app/v1/runs/export/route.ts",
    scope: "read",
    group: "runs",
    summary: "Bulk export your run history as CSV, JSON, or NDJSON. Pick with `?format=csv`.",
    curl: `curl "${HOST}/v1/runs/export?format=csv" \\
  -H "authorization: Bearer ${KEY}" \\
  -o runs.csv`,
    liveTestable: false,
  },
  {
    id: "runs-share",
    method: "POST",
    path: "/v1/runs/{id}/share",
    routeFile: "app/v1/runs/[id]/share/route.ts",
    scope: "read",
    group: "runs",
    summary: "Mint a public, revocable share link for one run.",
    curl: `curl -X POST ${HOST}/v1/runs/RUN_ID/share \\
  -H "authorization: Bearer ${KEY}"`,
    liveTestable: false,
  },
  {
    id: "webhooks-list",
    method: "GET",
    path: "/v1/webhooks",
    routeFile: "app/v1/webhooks/route.ts",
    scope: "webhooks",
    group: "webhooks",
    summary: "List registered webhook endpoints with their events and recent health.",
    curl: `curl ${HOST}/v1/webhooks \\
  -H "authorization: Bearer ${KEY}"`,
    liveTestable: true,
  },
  {
    id: "webhooks-create",
    method: "POST",
    path: "/v1/webhooks",
    routeFile: "app/v1/webhooks/route.ts",
    scope: "webhooks",
    group: "webhooks",
    summary: "Register a new webhook endpoint. Returns a signing secret you store once.",
    curl: `curl -X POST ${HOST}/v1/webhooks \\
  -H "authorization: Bearer ${KEY}" \\
  -H "content-type: application/json" \\
  -d '{"url":"https://example.com/hooks/adherence","events":["run.completed"]}'`,
    liveTestable: false,
  },
  {
    id: "webhooks-delete",
    method: "DELETE",
    path: "/v1/webhooks/{id}",
    routeFile: "app/v1/webhooks/[id]/route.ts",
    scope: "webhooks",
    group: "webhooks",
    summary: "Permanently remove one webhook endpoint.",
    curl: `curl -X DELETE ${HOST}/v1/webhooks/WEBHOOK_ID \\
  -H "authorization: Bearer ${KEY}"`,
    liveTestable: false,
  },
  {
    id: "webhooks-deliveries",
    method: "GET",
    path: "/v1/webhooks/deliveries",
    routeFile: "app/v1/webhooks/deliveries/route.ts",
    scope: "webhooks",
    group: "webhooks",
    summary: "Tail the outbound delivery log, including retry state and response status codes.",
    curl: `curl "${HOST}/v1/webhooks/deliveries?limit=50" \\
  -H "authorization: Bearer ${KEY}"`,
    liveTestable: true,
  },
  {
    id: "webhooks-redeliver",
    method: "POST",
    path: "/v1/webhooks/deliveries/{id}/redeliver",
    routeFile: "app/v1/webhooks/deliveries/[id]/redeliver/route.ts",
    scope: "webhooks",
    group: "webhooks",
    summary: "Replay a recorded delivery against the same endpoint. Supports ?dry_run=true for change-control previews.",
    curl: `curl -X POST ${HOST}/v1/webhooks/deliveries/DELIVERY_ID/redeliver \\
  -H "authorization: Bearer ${KEY}"`,
    liveTestable: true,
  },
];

export const GROUPS: { id: ApiEndpoint["group"]; label: string; blurb: string }[] = [
  { id: "predict", label: "Predict", blurb: "Score doses, one request or batched." },
  { id: "runs", label: "Runs", blurb: "Read, export, and share saved runs." },
  { id: "webhooks", label: "Webhooks", blurb: "Manage outbound endpoints and tail deliveries." },
  { id: "keys", label: "Keys", blurb: "Introspect the calling key." },
];

export function renderCurl(curl: string, host: string, key: string): string {
  const safeKey = key && key.length > 0 ? key : "$KEY";
  const safeHost = host && host.length > 0 ? host.replace(/\/$/, "") : "$HOST";
  return curl.replaceAll("$HOST", safeHost).replaceAll("$KEY", safeKey);
}
