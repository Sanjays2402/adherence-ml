import Link from "next/link";
import { CloudSlash, ArrowClockwise } from "@phosphor-icons/react/dist/ssr";

export const metadata = {
  title: "offline // adherence.ml",
  description: "You are offline. Cached pages still work.",
};

export default function OfflinePage() {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center px-6 text-center">
      <div className="mb-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <CloudSlash size={40} weight="duotone" className="text-[var(--color-fg-muted)]" />
      </div>
      <h1 className="text-lg font-semibold">You are offline</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Live predictions and saved runs need the network. Recently visited
        pages still work from your device cache.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm hover:bg-[var(--color-surface-hover)]"
        >
          <ArrowClockwise size={16} weight="duotone" />
          Try again
        </Link>
        <Link
          href="/history"
          className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          Browse cached history
        </Link>
      </div>
      <p className="mt-8 text-xs text-[var(--color-fg-subtle)]">
        Tip: install the app for a faster offline shell. Look for the install
        chip on the home screen.
      </p>
    </div>
  );
}
