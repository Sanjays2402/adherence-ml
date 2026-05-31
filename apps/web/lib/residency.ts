/**
 * Data residency helpers.
 *
 * Customer-facing region declaration is stored per workspace
 * (`security_policy.data_residency`). The operator declares the deployment
 * region via the `ADHERENCE_DEPLOY_REGION` env var (defaults to "unspecified").
 *
 * Both values are surfaced on workspace-scoped HTTP responses so SIEM/DLP
 * tooling, customers, and auditors can verify where data is held without
 * scraping the UI:
 *
 *   X-Data-Residency           // workspace-declared region
 *   X-Data-Residency-Deploy    // operator-declared deployment region
 *   X-Data-Residency-Match     // "match" | "mismatch" | "unspecified"
 *
 * A mismatch never blocks the request (residency is a contractual hint, not a
 * routing decision), but it is loud and easy to alert on.
 */
import type { NextResponse } from "next/server";
import type { DataResidencyRegion } from "./workspaces-store";
import { isDataResidencyRegion } from "./workspaces-store";

export function deploymentRegion(): DataResidencyRegion {
  const raw = String(process.env.ADHERENCE_DEPLOY_REGION ?? "").trim().toLowerCase();
  if (isDataResidencyRegion(raw)) return raw;
  return "unspecified";
}

export function residencyMatch(
  workspace: DataResidencyRegion,
  deploy: DataResidencyRegion = deploymentRegion(),
): "match" | "mismatch" | "unspecified" {
  if (workspace === "unspecified" || deploy === "unspecified") return "unspecified";
  if (workspace === deploy) return "match";
  // Treat the broad region as compatible with a more specific sub-region:
  //   workspace=eu + deploy=eu-frankfurt  -> match
  //   workspace=eu-frankfurt + deploy=eu  -> match
  if (deploy.startsWith(`${workspace}-`)) return "match";
  if (workspace.startsWith(`${deploy}-`)) return "match";
  return "mismatch";
}

export function withResidencyHeaders<T extends NextResponse>(
  res: T,
  workspaceRegion: DataResidencyRegion,
): T {
  const deploy = deploymentRegion();
  res.headers.set("X-Data-Residency", workspaceRegion);
  res.headers.set("X-Data-Residency-Deploy", deploy);
  res.headers.set("X-Data-Residency-Match", residencyMatch(workspaceRegion, deploy));
  return res;
}
