/**
 * SCIM 2.0 service provider config.
 *
 * Static document that tells the IdP what we support. The "supported"
 * booleans here match what the routes actually implement; do not flip them
 * on without backing them up.
 */
import { NextRequest } from "next/server";
import { authenticateScim, baseUrlOf, scimError, scimJson } from "@/lib/scim";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateScim(req);
  if (!auth) return scimError(401, "invalid or missing bearer token");
  const base = baseUrlOf(req);
  return scimJson(200, {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: `${base}/docs#scim`,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "Bearer token",
        description: "Workspace-scoped bearer token issued from the workspace SCIM admin page.",
        primary: true,
      },
    ],
    meta: {
      resourceType: "ServiceProviderConfig",
      location: `${base}/scim/v2/ServiceProviderConfig`,
    },
  });
}
