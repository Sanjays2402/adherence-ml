import { proxyGet } from "@/lib/proxy";
export const dynamic = "force-dynamic";
export const GET = proxyGet("/v1/metrics/online");
