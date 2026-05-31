/**
 * Prometheus exposition for the dashboard process.
 *
 * No client library: we write the wire format directly. Counters live in
 * module-scope maps so they survive across requests within a Node worker.
 *
 * Exposed series:
 *   dashboard_build_info{version,node}                           gauge
 *   dashboard_process_uptime_seconds                             gauge
 *   dashboard_process_resident_memory_bytes                      gauge
 *   dashboard_upstream_request_total{outcome}                    counter
 *   dashboard_upstream_request_duration_ms_bucket{le,outcome}    histogram
 *   dashboard_upstream_request_duration_ms_count{outcome}
 *   dashboard_upstream_request_duration_ms_sum{outcome}
 *
 * Add new series here; never expose user IDs or other high-cardinality
 * labels.
 */
const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

interface HistoState {
  counts: number[];
  sum: number;
  n: number;
}

const upstreamCounter: Map<string, number> = new Map();
const upstreamHisto: Map<string, HistoState> = new Map();

function emptyHisto(): HistoState {
  return { counts: new Array(BUCKETS_MS.length).fill(0), sum: 0, n: 0 };
}

export function recordUpstream(outcome: "ok" | "error" | "timeout", durationMs: number) {
  upstreamCounter.set(outcome, (upstreamCounter.get(outcome) ?? 0) + 1);
  const h = upstreamHisto.get(outcome) ?? emptyHisto();
  for (let i = 0; i < BUCKETS_MS.length; i++) {
    if (durationMs <= BUCKETS_MS[i]!) h.counts[i]! += 1;
  }
  h.sum += durationMs;
  h.n += 1;
  upstreamHisto.set(outcome, h);
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function renderPrometheus(version: string): string {
  const lines: string[] = [];

  lines.push("# HELP dashboard_build_info Build metadata.");
  lines.push("# TYPE dashboard_build_info gauge");
  lines.push(
    `dashboard_build_info{version="${escapeLabel(version)}",node="${escapeLabel(process.version)}"} 1`,
  );

  lines.push("# HELP dashboard_process_uptime_seconds Process uptime.");
  lines.push("# TYPE dashboard_process_uptime_seconds gauge");
  lines.push(`dashboard_process_uptime_seconds ${process.uptime().toFixed(3)}`);

  const mem = process.memoryUsage();
  lines.push("# HELP dashboard_process_resident_memory_bytes RSS memory.");
  lines.push("# TYPE dashboard_process_resident_memory_bytes gauge");
  lines.push(`dashboard_process_resident_memory_bytes ${mem.rss}`);

  lines.push("# HELP dashboard_upstream_request_total Upstream API calls from the dashboard.");
  lines.push("# TYPE dashboard_upstream_request_total counter");
  for (const [outcome, v] of upstreamCounter.entries()) {
    lines.push(`dashboard_upstream_request_total{outcome="${escapeLabel(outcome)}"} ${v}`);
  }
  if (upstreamCounter.size === 0) {
    lines.push('dashboard_upstream_request_total{outcome="ok"} 0');
  }

  lines.push(
    "# HELP dashboard_upstream_request_duration_ms Latency of upstream API calls.",
  );
  lines.push("# TYPE dashboard_upstream_request_duration_ms histogram");
  for (const [outcome, h] of upstreamHisto.entries()) {
    for (let i = 0; i < BUCKETS_MS.length; i++) {
      lines.push(
        `dashboard_upstream_request_duration_ms_bucket{outcome="${escapeLabel(outcome)}",le="${BUCKETS_MS[i]}"} ${h.counts[i]}`,
      );
    }
    lines.push(
      `dashboard_upstream_request_duration_ms_bucket{outcome="${escapeLabel(outcome)}",le="+Inf"} ${h.n}`,
    );
    lines.push(
      `dashboard_upstream_request_duration_ms_sum{outcome="${escapeLabel(outcome)}"} ${h.sum.toFixed(3)}`,
    );
    lines.push(
      `dashboard_upstream_request_duration_ms_count{outcome="${escapeLabel(outcome)}"} ${h.n}`,
    );
  }

  return lines.join("\n") + "\n";
}

// Test hook. Not part of the public surface.
export function __resetMetricsForTest() {
  upstreamCounter.clear();
  upstreamHisto.clear();
}
