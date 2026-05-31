import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { findSsoForEmail } from "@/lib/workspaces-store";
import { isValidEmail, normalizeEmail } from "@/lib/users-store";

export const runtime = "nodejs";

const Body = z.object({ email: z.string().min(3).max(254) });

/**
 * Returns the SSO entry for an email, if one is configured. Always returns
 * 200 with a constant shape so the login UI can decide whether to show
 * "Continue with SSO" without revealing whether the email exists. We do
 * leak that the email's *domain* is on an SSO workspace, which is
 * unavoidable: an enforced SSO domain has to refuse magic links anyway,
 * and we want to surface the right next step in the UI.
 */
export async function POST(req: NextRequest) {
  let parsed;
  try {
    parsed = Body.safeParse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, sso: null });
  }
  if (!parsed.success) return NextResponse.json({ ok: false, sso: null });
  const email = normalizeEmail(parsed.data.email);
  if (!isValidEmail(email)) return NextResponse.json({ ok: false, sso: null });
  const match = await findSsoForEmail(email);
  if (!match) return NextResponse.json({ ok: true, sso: null });
  return NextResponse.json({
    ok: true,
    sso: {
      workspace_id: match.workspace.id,
      workspace_name: match.workspace.name,
      label: match.sso.label,
      enforce: match.sso.enforce,
      start_url: `/api/auth/sso/start?workspace=${encodeURIComponent(match.workspace.id)}`,
    },
  });
}
