"use client";

/**
 * App-wide first run nudge: a slim banner that links to /onboarding when the
 * workspace has not finished setup and the user has not dismissed it. Stays
 * silent during fetch and on errors so it never blocks navigation. Hides
 * itself on /onboarding (where it would be redundant) and on /r/ (the public
 * share view, which has no sidebar).
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { useState, useTransition } from "react";
import { Rocket, ArrowRight, X } from "@phosphor-icons/react";

type State = {
  version: 1;
  completed: string[];
  dismissed: boolean;
  seeded_at: number | null;
  updated_at: number;
};

const TOTAL_STEPS = 3;

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`status ${r.status}`);
    return r.json();
  });

export default function OnboardingBanner() {
  const pathname = usePathname() ?? "/";
  const { data, mutate } = useSWR<State>("/api/onboarding", fetcher, {
    revalidateOnFocus: false,
  });
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  if (!data) return null;
  if (pathname === "/onboarding" || pathname.startsWith("/r/")) return null;
  if (data.dismissed) return null;
  const done = data.completed.length;
  if (done >= TOTAL_STEPS) return null;

  const dismiss = async () => {
    setBusy(true);
    // optimistic
    startTransition(() => {
      mutate({ ...data, dismissed: true }, { revalidate: false });
    });
    try {
      await fetch("/api/onboarding", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dismissed: true }),
      });
    } finally {
      setBusy(false);
      mutate();
    }
  };

  return (
    <div
      role="region"
      aria-label="First run guide"
      className="border-b border-[var(--color-border)] bg-[var(--color-accent)]/8 px-4 md:px-6 py-2.5 flex items-center gap-3 flex-wrap"
    >
      <Rocket
        weight="duotone"
        size={16}
        className="text-[var(--color-accent)] shrink-0"
      />
      <div className="text-[12px] text-[var(--color-fg)]/85 min-w-0 flex-1">
        Finish setup so every page has real data to render.
        <span className="ml-2 font-mono text-[11px] uppercase tracking-wider text-[var(--color-subtle)]">
          step {done}/{TOTAL_STEPS}
        </span>
      </div>
      <Link
        href="/onboarding"
        className="inline-flex items-center gap-1 rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[12px] font-medium text-white hover:bg-[var(--color-accent)]/90"
      >
        Resume
        <ArrowRight weight="duotone" size={12} />
      </Link>
      <button
        type="button"
        onClick={dismiss}
        disabled={busy}
        aria-label="Dismiss onboarding banner"
        className="rounded p-1 text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-border)]/40 disabled:opacity-50"
      >
        <X weight="duotone" size={13} />
      </button>
    </div>
  );
}
