import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmtPct(x: number | null | undefined, digits = 1): string {
  if (x == null || Number.isNaN(x)) return "n/a";
  return `${(x * 100).toFixed(digits)}%`;
}

export function fmtNum(x: number | null | undefined, digits = 3): string {
  if (x == null || Number.isNaN(x)) return "n/a";
  return x.toFixed(digits);
}

export function fmtInt(x: number | null | undefined): string {
  if (x == null) return "n/a";
  return new Intl.NumberFormat("en-US").format(x);
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "n/a";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "n/a";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = (Date.now() - t) / 1000;
  const abs = Math.abs(diff);
  const sign = diff >= 0 ? "" : "in ";
  const suffix = diff >= 0 ? " ago" : "";
  if (abs < 60) return `${sign}${Math.round(abs)}s${suffix}`;
  if (abs < 3600) return `${sign}${Math.round(abs / 60)}m${suffix}`;
  if (abs < 86400) return `${sign}${Math.round(abs / 3600)}h${suffix}`;
  return `${sign}${Math.round(abs / 86400)}d${suffix}`;
}

export type Risk = "low" | "mid" | "high";

export function riskFromProb(p: number | null | undefined): Risk {
  if (p == null || Number.isNaN(p)) return "low";
  if (p >= 0.7) return "high";
  if (p >= 0.4) return "mid";
  return "low";
}

export function riskColor(p: number): string {
  const r = riskFromProb(p);
  return r === "high"
    ? "var(--color-high)"
    : r === "mid"
      ? "var(--color-mid)"
      : "var(--color-low)";
}

export function riskRailClass(p: number | null | undefined): string {
  const r = riskFromProb(p);
  return r === "high" ? "rail-high" : r === "mid" ? "rail-mid" : "rail-low";
}
