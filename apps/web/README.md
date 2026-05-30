# adherence-ml web

Next.js 15 + Tailwind v4 control surface for the adherence-ml FastAPI service.

## Pages

- `/dashboard` – live model performance (AUC, Brier, ECE, calibration curve, by-model breakdown). Auto-refreshes every 30s. Reads `/v1/metrics/online`.
- `/explain` – global SHAP-based feature importance and per-sample contributions. Reads `/v1/explain/global` and `/v1/explain/sample`.
- `/interventions` – per-user delivery queue with one-click ack flow (Sent / Snooze 30m / Dismiss / Acted). Posts to `/v1/interventions/{id}/ack`.
- `/predict` – form to score a user's upcoming doses against the live model. Posts to `/v1/predict`.

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
