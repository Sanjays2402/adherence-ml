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
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/dashboard", label: "Performance", icon: ChartLine },
  { href: "/cohort", label: "Cohort", icon: UsersThree },
  { href: "/explain", label: "Explainer", icon: Lightbulb },
  { href: "/interventions", label: "Interventions", icon: Bell },
  { href: "/predict", label: "Predict", icon: Lightning },
];

export default function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="md:w-60 md:border-r md:border-[var(--color-border)] md:min-h-screen md:sticky md:top-0 bg-[var(--color-surface)]/40">
      <div className="px-5 py-5 flex items-center gap-2 border-b border-[var(--color-border)] md:border-b">
        <Pulse weight="duotone" size={20} className="text-[var(--color-accent)]" />
        <span className="text-sm font-medium tracking-tight">adherence</span>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
          ml
        </span>
      </div>
      <nav className="flex md:flex-col gap-1 p-2 overflow-x-auto md:overflow-x-visible scrollbar-thin">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm whitespace-nowrap transition-colors",
                active
                  ? "bg-[var(--color-border)]/60 text-[var(--color-fg)]"
                  : "text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-border)]/30",
              )}
            >
              <Icon
                weight="duotone"
                size={16}
                className={cn(active && "text-[var(--color-accent)]")}
              />
              {label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
