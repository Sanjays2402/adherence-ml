import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmtPct(x: number | null | undefined, digits = 1): string {
  if (x == null || Number.isNaN(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

export function fmtNum(x: number | null | undefined, digits = 3): string {
  if (x == null || Number.isNaN(x)) return "—";
  return x.toFixed(digits);
}

export function fmtInt(x: number | null | undefined): string {
  if (x == null) return "—";
  return new Intl.NumberFormat("en-US").format(x);
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
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

export function riskColor(p: number): string {
  if (p >= 0.7) return "var(--color-danger)";
  if (p >= 0.4) return "var(--color-warn)";
  return "var(--color-success)";
}
