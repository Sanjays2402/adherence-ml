/**
 * Auth lifecycle audit.
 *
 * Thin wrapper over lib/dashboard-audit.ts that records every authentication
 * lifecycle event (login attempts, magic-link verify, SSO start/callback,
 * MFA enroll/verify/disable, session logout) into the same tamper-evident
 * hash-chained log the rest of the dashboard mutations land in.
 *
 * Procurement reviewers ask "show me every login attempt for user X in the
 * last 90 days, including failures, including SSO, including MFA prompts"
 * and we need to answer that without grepping nginx logs. Every action
 * recorded here is shaped `auth.<verb>.<outcome>` so the existing /audit
 * dashboard panel and the listAudit({ action_prefix: "auth." }) query
 * surface the whole stream consistently.
 *
 * Failure-safe: if writing to the audit chain throws (disk full, locked
 * file, etc) we swallow it. We must never block a login on audit IO.
 *
 * No secrets: callers must never put magic tokens, TOTP codes, recovery
 * codes, id_tokens, or access tokens into `metadata`. There is a test
 * pinning this contract (tests/auth-audit.test.ts).
 */
import type { NextRequest } from "next/server";
import { recordAudit, type AuditOutcome } from "@/lib/dashboard-audit";

export type AuthVerb =
  // primary login flows
  | "request" // /api/auth/request - magic link asked for
  | "login_request" // legacy alias for request
  | "login" // session minted (magic link, sso, github)
  | "logout"
  // SSO / OAuth
  | "sso_start"
  | "sso_callback"
  // MFA enrollment + step-up
  | "mfa_setup"
  | "mfa_enable"
  | "mfa_disable"
  | "mfa" // mfa challenge during login (success or failure)
  // misc
  | "session_revoked";

export type AuthMethod =
  | "magic_link"
  | "sso"
  | "sso_oidc"
  | "oidc"
  | "github"
  | "totp"
  | "recovery_code"
  | "session";

export interface RecordAuthEventOptions {
  verb: AuthVerb;
  method?: AuthMethod;
  outcome?: AuditOutcome; // defaults to "success"
  email?: string | null;
  userId?: string | null;
  workspaceId?: string | null;
  /** Reason code for failure/denied outcomes (e.g. "invalid_totp_code"). */
  reason?: string | null;
  /** Free-form structured context. Must not contain secrets. */
  metadata?: Record<string, unknown> | null;
  /** Used to capture IP + user-agent. */
  request?: NextRequest | null;
  /** What the verb acted on (e.g. workspace id for sso_start). */
  target?: string | null;
}

function canonicalVerb(verb: AuthVerb): string {
  // login_request is just a long-form alias kept for readability at call sites.
  return verb === "login_request" ? "request" : verb;
}

function actionFor(verb: AuthVerb, outcome: AuditOutcome): string {
  return `auth.${canonicalVerb(verb)}.${outcome}`;
}

function lowerEmail(email?: string | null): string | null {
  if (!email) return null;
  return email.trim().toLowerCase();
}

// Field names that are NEVER allowed in metadata, even if a caller forgets.
// This is defence in depth: the contract says don't pass them, the lib also
// strips them.
const FORBIDDEN_METADATA_KEYS = new Set([
  "token",
  "magic_token",
  "code",
  "totp_code",
  "recovery_code",
  "access_token",
  "id_token",
  "client_secret",
  "password",
  "secret",
]);

function sanitizeMetadata(
  md: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!md) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(md)) {
    if (FORBIDDEN_METADATA_KEYS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

export async function recordAuthEvent(
  opts: RecordAuthEventOptions,
): Promise<void> {
  const outcome: AuditOutcome = opts.outcome ?? "success";
  const email = lowerEmail(opts.email);

  const metadata: Record<string, unknown> = {
    ...(sanitizeMetadata(opts.metadata) ?? {}),
  };
  if (opts.method) metadata.method = opts.method;
  if (opts.reason) metadata.reason = opts.reason;
  if (opts.workspaceId) metadata.workspace_id = opts.workspaceId;

  try {
    await recordAudit({
      action: actionFor(opts.verb, outcome),
      outcome,
      target: opts.target ?? email,
      actor: {
        user_id: opts.userId ?? null,
        email,
      },
      metadata: Object.keys(metadata).length ? metadata : null,
      request: opts.request ?? null,
    });
  } catch {
    // Audit must never break auth. Swallow.
  }
}
