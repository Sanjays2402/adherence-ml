/**
 * SCIM 2.0 schema discovery. Returns the minimal core User + enterprise
 * extension schemas this provider supports.
 */
import { NextRequest } from "next/server";
import {
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
  const userSchema = {
    id: SCIM_USER_SCHEMA,
    name: "User",
    description: "Workspace member",
    attributes: [
      { name: "userName", type: "string", required: true, uniqueness: "server", caseExact: false, mutability: "readWrite", returned: "default" },
      { name: "active", type: "boolean", required: false, mutability: "readWrite", returned: "default" },
      { name: "emails", type: "complex", multiValued: true, returned: "default", mutability: "readWrite" },
      { name: "groups", type: "complex", multiValued: true, returned: "default", mutability: "readWrite" },
    ],
    meta: { resourceType: "Schema", location: `${base}/scim/v2/Schemas/${SCIM_USER_SCHEMA}` },
  };
  const entExt = {
    id: SCIM_ENTERPRISE_USER_EXT,
    name: "EnterpriseUser",
    description: "Enterprise extension",
    attributes: [
      { name: "department", type: "string", required: false, mutability: "readWrite", returned: "default" },
    ],
    meta: { resourceType: "Schema", location: `${base}/scim/v2/Schemas/${SCIM_ENTERPRISE_USER_EXT}` },
  };
  return scimJson(200, {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: 2,
    Resources: [userSchema, entExt],
    startIndex: 1,
    itemsPerPage: 2,
  });
}
