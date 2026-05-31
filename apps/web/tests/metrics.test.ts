import { describe, it, expect, beforeEach } from "vitest";
import { recordUpstream, renderPrometheus, __resetMetricsForTest } from "@/lib/metrics";

describe("dashboard metrics exposition", () => {
  beforeEach(() => {
    __resetMetricsForTest();
  });

  it("emits required series with valid Prometheus format", () => {
    recordUpstream("ok", 12);
    recordUpstream("ok", 230);
    recordUpstream("error", 7);

    const text = renderPrometheus("1.2.3");

    expect(text).toMatch(/^# HELP dashboard_build_info /m);
    expect(text).toMatch(/^# TYPE dashboard_build_info gauge$/m);
    expect(text).toMatch(/dashboard_build_info\{version="1\.2\.3",node="v[^"]+"\} 1/);

    expect(text).toMatch(/^dashboard_process_uptime_seconds [0-9.]+/m);
    expect(text).toMatch(/^dashboard_process_resident_memory_bytes [0-9]+/m);

    expect(text).toMatch(/^dashboard_upstream_request_total\{outcome="ok"\} 2$/m);
    expect(text).toMatch(/^dashboard_upstream_request_total\{outcome="error"\} 1$/m);

    expect(text).toMatch(/dashboard_upstream_request_duration_ms_bucket\{outcome="ok",le="25"\} 1/);
    expect(text).toMatch(/dashboard_upstream_request_duration_ms_bucket\{outcome="ok",le="250"\} 2/);
    expect(text).toMatch(/dashboard_upstream_request_duration_ms_bucket\{outcome="ok",le="\+Inf"\} 2/);
    expect(text).toMatch(/dashboard_upstream_request_duration_ms_count\{outcome="ok"\} 2/);
    expect(text).toMatch(/dashboard_upstream_request_duration_ms_sum\{outcome="ok"\} 242(\.0+)?/);
  });

  it("escapes label values defensively", () => {
    const text = renderPrometheus('weird"version\nwith\\stuff');
    expect(text).toContain('version="weird\\"version\\nwith\\\\stuff"');
  });

  it("renders a baseline ok counter when no calls have been made", () => {
    const text = renderPrometheus("dev");
    expect(text).toMatch(/^dashboard_upstream_request_total\{outcome="ok"\} 0$/m);
  });
});
