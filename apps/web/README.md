# adherence-ml web

Next.js 15 + Tailwind v4 control surface for the adherence-ml FastAPI service.

## Pages

- `/dashboard` – live model performance (AUC, Brier, ECE, calibration curve, by-model breakdown). Auto-refreshes every 30s. Reads `/v1/metrics/online`.
- `/explain` – global SHAP-based feature importance and per-sample contributions. Reads `/v1/explain/global` and `/v1/explain/sample`.
- `/interventions` – per-user delivery queue with one-click ack flow (Sent / Snooze 30m / Dismiss / Acted). Posts to `/v1/interventions/{id}/ack`.
- `/predict` – form to score a user's upcoming doses against the live model. Posts to `/v1/predict`.
- `/api-keys` – issue, scope, rotate, and revoke API keys for the `/v1/*` endpoints. Pick the `predict` scope to call `POST /v1/predict`, the `read` scope to call `GET /v1/runs`, or both.

## Public API (key-authenticated)

Keys are scoped. A `predict`-only key can score doses but cannot list runs; a `read`-only key can list runs but cannot call the model. Legacy keys created before scopes shipped keep both scopes for backwards compatibility.

Try it locally after creating a key at `/api-keys`:

```bash
# score a dose plan (requires predict scope)
curl -X POST http://localhost:3000/v1/predict \
  -H "authorization: Bearer adh_YOUR_KEY" \
  -H "content-type: application/json" \
  -d '{"user_id":"u_123","doses":[{"dose_id":"d1","scheduled_at":"2025-01-01T08:00:00Z","dose_class":"statin","dose_strength_mg":20}]}'

# list recent saved runs (requires read scope)
curl "http://localhost:3000/v1/runs?limit=10" \
  -H "authorization: Bearer adh_YOUR_KEY"
```

Missing the right scope returns `403` with `{ detail, required_scope, key_scopes }` so client libraries can surface a clear upgrade path.

## Architecture

- All API calls are server-side. The browser only talks to Next.js route handlers under `/api/*`. The `ADHERENCE_API_KEY` never reaches the client.
- Browser mutations (predict, ack) go through `/api/proxy/[...path]`, which has a tight upstream allow-list.
- SWR drives live refresh on the dashboard and intervention queue.

## Run

```bash
cp .env.example .env.local   # fill in ADHERENCE_API_BASE and ADHERENCE_API_KEY
pnpm install
pnpm dev                     # http://localhost:3000
```

Set `ADHERENCE_API_KEY` to a key with admin role so the dashboard can call `/v1/metrics/online` and `/v1/interventions/deliveries/{user}`.

## Tech

Next.js 15 App Router, React 19, Tailwind v4, SWR, Recharts, Phosphor duotone icons.

## Run history

Every POST through `/api/proxy/v1/{predict,cohort/risk,forecast/user}` is appended to
`.data/runs.jsonl` (single-process JSONL store, no native bindings). The `/history`
page lists every run with search, kind filter, pagination, copy-link, and delete.
Public share URLs live at `/r/<id>` and render without the sidebar so they look
clean in an incognito window.

- `GET /api/runs?q=&kind=&limit=&offset=` lists with search and filter
- `POST /api/runs` records a run (zod-validated)
- `GET /api/runs/<id>` fetches one
- `DELETE /api/runs/<id>` removes one

Override the data dir with `ADHERENCE_DATA_DIR=/path/to/dir`. Run the test suite
with `pnpm test`.
