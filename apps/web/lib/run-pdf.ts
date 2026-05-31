import type { RunRecord } from "@/lib/runs-store";
import { renderPdf, type PdfBlock } from "@/lib/pdf";

const KIND_LABEL: Record<string, string> = {
  predict: "Adherence prediction",
  demo: "Demo run",
  explain: "Explainability run",
  cohort: "Cohort analysis",
  forecast: "Forecast",
  other: "Run",
};

function fmtDate(ms: number): string {
  const d = new Date(ms);
  // YYYY-MM-DD HH:MM UTC; PDF text is plain ASCII so avoid locale strings.
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

/** Try to lift a numeric risk score from a few common payload shapes. */
function extractRisk(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const candidates: unknown[] = [
    p.risk,
    p.risk_score,
    p.probability,
    p.prob,
    p.score,
    (p.prediction as Record<string, unknown> | undefined)?.risk,
    (p.prediction as Record<string, unknown> | undefined)?.probability,
    (p.response as Record<string, unknown> | undefined)?.risk,
    (p.response as Record<string, unknown> | undefined)?.probability,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return null;
}

function riskBand(r: number): string {
  if (r < 0.25) return "Low";
  if (r < 0.5) return "Moderate";
  if (r < 0.75) return "Elevated";
  return "High";
}

/**
 * Compose the printable report for a single run. Keeps the layout neutral so
 * it works for predict, cohort, forecast, and demo records.
 */
export function runToPdf(rec: RunRecord, opts?: { origin?: string }): Buffer {
  const blocks: PdfBlock[] = [];
  blocks.push({ kind: "h1", text: "Adherence ML report" });
  blocks.push({
    kind: "p",
    text: `${KIND_LABEL[rec.kind] ?? "Run"} . ${fmtDate(rec.created_at)}`,
  });
  blocks.push({ kind: "rule" });
  blocks.push({ kind: "h2", text: rec.title || "Untitled run" });
  if (rec.summary) blocks.push({ kind: "p", text: rec.summary });
  blocks.push({ kind: "space", pts: 6 });

  // Metadata table-ish lines
  const meta: string[] = [];
  meta.push(`Run id:    ${rec.id}`);
  meta.push(`Kind:      ${rec.kind}`);
  if (rec.user_id) meta.push(`User:      ${rec.user_id}`);
  if (typeof rec.latency_ms === "number")
    meta.push(`Latency:   ${rec.latency_ms} ms`);
  if (rec.tags?.length) meta.push(`Tags:      ${rec.tags.join(", ")}`);
  if (opts?.origin)
    meta.push(`Permalink: ${opts.origin}/history/${rec.id}`);
  blocks.push({ kind: "mono", text: meta.join("\n") });
  blocks.push({ kind: "space", pts: 8 });

  const risk = extractRisk(rec.payload);
  if (risk !== null) {
    const pct = (risk * 100).toFixed(1);
    blocks.push({ kind: "h2", text: "Risk score" });
    blocks.push({
      kind: "p",
      text: `${pct}% probability of non-adherence (${riskBand(risk)})`,
    });
    blocks.push({ kind: "space", pts: 4 });
  }

  blocks.push({ kind: "h2", text: "Payload" });
  let payloadStr = "";
  try {
    payloadStr = JSON.stringify(rec.payload, null, 2);
  } catch {
    payloadStr = "[unserializable payload]";
  }
  // Cap payload print so a giant cohort dump does not blow the single page.
  const MAX = 2400;
  if (payloadStr.length > MAX) {
    payloadStr =
      payloadStr.slice(0, MAX) +
      `\n... [${payloadStr.length - MAX} more chars truncated]`;
  }
  blocks.push({ kind: "mono", text: payloadStr });

  return renderPdf(blocks);
}
