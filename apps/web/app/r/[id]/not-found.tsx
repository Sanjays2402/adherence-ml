import Link from "next/link";
import { ArrowRight, WarningOctagon } from "@phosphor-icons/react/dist/ssr";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-fg)] font-sans flex items-center justify-center px-5">
      <div className="max-w-md w-full text-center space-y-4">
        <WarningOctagon
          weight="duotone"
          size={36}
          className="mx-auto text-[var(--color-muted)]"
        />
        <h1 className="text-[18px] font-semibold">Run not found</h1>
        <p className="text-[13px] text-[var(--color-muted)] leading-relaxed">
          This share link is invalid, expired, or the owner deleted the run.
        </p>
        <Link
          href="/history"
          className="inline-flex items-center gap-1.5 text-[12px] font-mono text-[var(--color-accent)] hover:opacity-80"
        >
          Browse all runs <ArrowRight weight="duotone" size={14} />
        </Link>
      </div>
    </div>
  );
}
