/**
 * OG image for token-gated shared runs at /share/<token>. 1200x630 PNG via
 * next/og ImageResponse. Mirrors the /r/<id> card so Slack, iMessage,
 * Twitter, and LinkedIn unfurl the user's actual share link cleanly.
 *
 * Path: GET /share/<token>/opengraph-image
 *
 * Wired into <meta property="og:image"> by Next via the file convention; the
 * /share/<token> page also opts in explicitly via generateMetadata.openGraph.
 */
import { ImageResponse } from "next/og";
import { getRunByShareToken } from "@/lib/runs-store";

export const runtime = "nodejs";
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };
export const alt = "adherence.ml shared run";

interface Pred {
  miss_probability?: number;
  risk_tier?: string;
}
interface PredictPayload {
  response?: { predictions?: Pred[] };
}

function topMiss(payload: unknown): { pct: number; tier: string } | null {
  const p = payload as PredictPayload;
  const preds = p?.response?.predictions;
  if (!Array.isArray(preds) || preds.length === 0) return null;
  let best: Pred | null = null;
  for (const pr of preds) {
    if (typeof pr?.miss_probability !== "number") continue;
    if (!best || (pr.miss_probability ?? 0) > (best.miss_probability ?? 0)) {
      best = pr;
    }
  }
  if (!best || typeof best.miss_probability !== "number") return null;
  return {
    pct: Math.round(best.miss_probability * 1000) / 10,
    tier: best.risk_tier ?? "n/a",
  };
}

const BG = "#0a0b0e";
const SURFACE = "#13151a";
const BORDER = "#1f232c";
const FG = "#e8eaed";
const MUTED = "#7d828c";
const ACCENT = "#7cd4fd";
const DANGER = "#fb7185";
const WARN = "#fbbf24";
const SUCCESS = "#86efac";

function tierColor(tier: string): string {
  const t = tier.toLowerCase();
  if (t === "high") return DANGER;
  if (t === "medium" || t === "med") return WARN;
  return SUCCESS;
}

export default async function Image({
  params,
}: {
  params: { token: string };
}) {
  const rec = await getRunByShareToken(params.token);
  const title = rec?.title ?? "Shared run";
  const kind = rec?.kind ?? "unknown";
  const summary = rec?.summary ?? "";
  const tags = (rec?.tags ?? []).slice(0, 4);
  const top = rec ? topMiss(rec.payload) : null;
  const when = rec ? new Date(rec.created_at).toISOString().slice(0, 10) : "";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: BG,
          color: FG,
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          padding: "56px 64px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div
              style={{
                width: 18,
                height: 18,
                borderRadius: 9,
                background: ACCENT,
                boxShadow: `0 0 18px ${ACCENT}`,
              }}
            />
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span
                style={{ fontSize: 24, fontWeight: 600, letterSpacing: -0.4 }}
              >
                adherence.ml
              </span>
              <span
                style={{
                  fontSize: 13,
                  color: MUTED,
                  textTransform: "uppercase",
                  letterSpacing: 3,
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, monospace",
                }}
              >
                shared run
              </span>
            </div>
          </div>
          <span
            style={{
              fontSize: 14,
              color: MUTED,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              textTransform: "uppercase",
              letterSpacing: 2,
              border: `1px solid ${BORDER}`,
              padding: "6px 12px",
              borderRadius: 8,
              background: SURFACE,
            }}
          >
            {kind}
          </span>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            justifyContent: "center",
            gap: 26,
          }}
        >
          <div
            style={{
              fontSize: 62,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: -1.2,
              maxWidth: 1080,
            }}
          >
            {title.length > 110 ? title.slice(0, 107) + "..." : title}
          </div>
          {summary ? (
            <div
              style={{
                fontSize: 26,
                color: MUTED,
                lineHeight: 1.35,
                maxWidth: 1020,
              }}
            >
              {summary.length > 180 ? summary.slice(0, 177) + "..." : summary}
            </div>
          ) : null}

          {top ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 18,
                marginTop: 6,
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  padding: "16px 22px",
                  border: `1px solid ${BORDER}`,
                  background: SURFACE,
                  borderRadius: 12,
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    color: MUTED,
                    textTransform: "uppercase",
                    letterSpacing: 2,
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, monospace",
                  }}
                >
                  Top miss probability
                </span>
                <span
                  style={{
                    fontSize: 42,
                    fontWeight: 700,
                    fontVariantNumeric: "tabular-nums",
                    color: tierColor(top.tier),
                  }}
                >
                  {top.pct.toFixed(1)}%
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  padding: "16px 22px",
                  border: `1px solid ${BORDER}`,
                  background: SURFACE,
                  borderRadius: 12,
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    color: MUTED,
                    textTransform: "uppercase",
                    letterSpacing: 2,
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, monospace",
                  }}
                >
                  Tier
                </span>
                <span
                  style={{
                    fontSize: 42,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    color: tierColor(top.tier),
                  }}
                >
                  {top.tier}
                </span>
              </div>
            </div>
          ) : null}

          {tags.length > 0 ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {tags.map((t) => (
                <span
                  key={t}
                  style={{
                    fontSize: 18,
                    color: MUTED,
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, monospace",
                    border: `1px solid ${BORDER}`,
                    background: SURFACE,
                    padding: "6px 12px",
                    borderRadius: 8,
                  }}
                >
                  #{t}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: `1px solid ${BORDER}`,
            paddingTop: 18,
          }}
        >
          <span
            style={{
              fontSize: 16,
              color: MUTED,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            }}
          >
            adherence.ml/share/{params.token.slice(0, 10)}
            {params.token.length > 10 ? "..." : ""}
          </span>
          <span
            style={{
              fontSize: 16,
              color: MUTED,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            }}
          >
            {when}
          </span>
        </div>
      </div>
    ),
    size,
  );
}
