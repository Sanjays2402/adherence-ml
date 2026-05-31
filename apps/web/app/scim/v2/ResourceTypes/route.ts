/**
 * SCIM 2.0 ResourceTypes discovery.
 */
import { NextRequest } from "next/server";
import {
  SCIM_GROUP_SCHEMA,
  SCIM_LIST_SCHEMA,
  SCIM_USER_SCHEMA,
  SCIM_ENTERPRISE_USER_EXT,
  authenticateScim,
  baseUrlOf,
  scimError,
  scimJson,
} from "@/lib/scim";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateScim(req);
  if (!auth) return scimError(401, "invalid or missing bearer token");
  const base = baseUrlOf(req);
  const user = {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "User",
    name: "User",
    endpoint: "/Users",
    description: "Workspace members provisioned by your identity provider",
    schema: SCIM_USER_SCHEMA,
    schemaExtensions: [
      { schema: SCIM_ENTERPRISE_USER_EXT, required: false },
    ],
    meta: {
      resourceType: "ResourceType",
      location: `${base}/scim/v2/ResourceTypes/User`,
    },
  };
  const group = {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "Group",
    name: "Group",
    endpoint: "/Groups",
    description:
      "Fixed role groups (owners, editors, viewers). Membership controls workspace role.",
    schema: SCIM_GROUP_SCHEMA,
    schemaExtensions: [],
    meta: {
      resourceType: "ResourceType",
      location: `${base}/scim/v2/ResourceTypes/Group`,
    },
  };
  return scimJson(200, {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: 2,
    Resources: [user, group],
    startIndex: 1,
    itemsPerPage: 2,
  });
}
