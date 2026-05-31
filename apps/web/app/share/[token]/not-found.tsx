import Link from "next/link";
import { ShareNetwork } from "@phosphor-icons/react/dist/ssr";

export default function ShareNotFound() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="max-w-sm text-center space-y-3">
        <ShareNetwork
          weight="duotone"
          size={36}
          className="mx-auto text-[var(--color-muted)]"
        />
        <h1 className="text-base font-medium">Shared link not found</h1>
        <p className="text-[12px] text-[var(--color-muted)]">
          This share has been revoked or never existed. If you got this link
          from someone, ask them to re-share.
        </p>
        <Link
          href="/"
          className="inline-flex items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[12px] hover:bg-[var(--color-border)]/30"
        >
          Back home
        </Link>
      </div>
    </div>
  );
}
