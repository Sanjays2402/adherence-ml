"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChartLine,
  Lightbulb,
  Bell,
  Lightning,
  Pulse,
  UsersThree,
  Scales,
  CalendarBlank,
  ClipboardText,
  House,
  Sparkle,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Overview", icon: House, hint: "What this does" },
  { href: "/demo", label: "Try a sample", icon: Sparkle, hint: "3 patient personas" },
  { href: "/compare", label: "Compare", icon: Scales, hint: "Side by side triage" },
  { href: "/dashboard", label: "Performance", icon: ChartLine, hint: "AUC // Brier // ECE" },
  { href: "/cohort", label: "Cohort", icon: UsersThree, hint: "Population risk" },
  { href: "/forecast", label: "Forecast", icon: CalendarBlank, hint: "7-day projection" },
  { href: "/explain", label: "Explainer", icon: Lightbulb, hint: "SHAP contributions" },
  { href: "/interventions", label: "Interventions", icon: Bell, hint: "Delivery queue" },
  { href: "/predict", label: "Predict", icon: Lightning, hint: "Inline scoring" },
  { href: "/audit", label: "Audit", icon: ClipboardText, hint: "Call log" },
];

export default function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="md:w-60 md:border-r md:border-[var(--color-border)] md:min-h-screen md:sticky md:top-0 bg-[var(--color-surface)]/60 backdrop-blur">
      <div className="px-5 py-4 flex items-center gap-2 border-b border-[var(--color-border)]">
        <div className="relative">
          <Pulse weight="duotone" size={20} className="text-[var(--color-accent)]" />
          <span className="absolute -right-1 -top-1 block h-1.5 w-1.5 rounded-full bg-[var(--color-low)] shadow-[0_0_6px_var(--color-low)]" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-[13px] font-semibold tracking-tight">adherence.ml</span>
          <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted)]">
            observability
          </span>
        </div>
      </div>
      <nav className="flex md:flex-col gap-0.5 p-2 overflow-x-auto md:overflow-x-visible scrollbar-thin">
        {NAV.map(({ href, label, icon: Icon, hint }) => {
          const active =
            href === "/"
              ? pathname === "/"
              : pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "group flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm whitespace-nowrap transition-colors",
                active
                  ? "bg-[var(--color-accent-soft)] text-[var(--color-fg)]"
                  : "text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-border)]/30",
              )}
            >
              <Icon
                weight="duotone"
                size={16}
                className={cn(active ? "text-[var(--color-accent)]" : "text-[var(--color-muted)] group-hover:text-[var(--color-fg)]")}
              />
              <span className="flex flex-col leading-tight">
                <span>{label}</span>
                <span className="hidden md:block text-[10px] font-mono uppercase tracking-wider text-[var(--color-subtle)]">
                  {hint}
                </span>
              </span>
            </Link>
          );
        })}
      </nav>
      <div className="hidden md:block absolute bottom-0 left-0 right-0 border-t border-[var(--color-border)] px-3 py-2 text-[10px] font-mono uppercase tracking-widest text-[var(--color-subtle)]">
        <div className="flex items-center justify-between">
          <span>online</span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-low)] shadow-[0_0_6px_var(--color-low)]" />
            <span className="text-[var(--color-muted)]">streaming</span>
          </span>
        </div>
      </div>
    </aside>
  );
}
