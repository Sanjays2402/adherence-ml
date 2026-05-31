/**
 * Structured JSON logger for the dashboard.
 *
 * Single line of JSON per call, written to stdout, ready to be ingested by
 * any log shipper. Every line includes ISO timestamp, level, message, and
 * the caller-supplied fields. Pass the incoming Request to inherit the
 * `x-request-id` header so dashboard logs join with FastAPI's logs.
 *
 * Intentionally tiny: no dependencies, no transports, no rotation. Run a
 * sidecar (fluent-bit / vector / cloudwatch agent) for that.
 */
export type Level = "debug" | "info" | "warn" | "error";

interface BaseFields {
  request_id?: string | null;
  [k: string]: unknown;
}

function emit(level: Level, msg: string, fields: BaseFields) {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  if (level === "error" || level === "warn") {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(line));
  } else {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
  }
}

export function requestIdFrom(req: Request | Headers | null | undefined): string | null {
  if (!req) return null;
  const h = req instanceof Headers ? req : req.headers;
  return h.get("x-request-id");
}

export function log(level: Level, msg: string, fields: BaseFields = {}) {
  emit(level, msg, fields);
}

export const logger = {
  debug: (msg: string, fields: BaseFields = {}) => emit("debug", msg, fields),
  info: (msg: string, fields: BaseFields = {}) => emit("info", msg, fields),
  warn: (msg: string, fields: BaseFields = {}) => emit("warn", msg, fields),
  error: (msg: string, fields: BaseFields = {}) => emit("error", msg, fields),
  child(base: BaseFields) {
    return {
      debug: (msg: string, f: BaseFields = {}) => emit("debug", msg, { ...base, ...f }),
      info: (msg: string, f: BaseFields = {}) => emit("info", msg, { ...base, ...f }),
      warn: (msg: string, f: BaseFields = {}) => emit("warn", msg, { ...base, ...f }),
      error: (msg: string, f: BaseFields = {}) => emit("error", msg, { ...base, ...f }),
    };
  },
};
