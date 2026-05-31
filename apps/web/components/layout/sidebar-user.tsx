"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SignOut, UserCircle, SignIn } from "@phosphor-icons/react";

interface MeResponse {
  user: { id: string; email: string } | null;
}

export default function SidebarUser() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const data = (await res.json()) as MeResponse;
      setEmail(data.user?.email ?? null);
    } catch {
      setEmail(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      setEmail(null);
      router.refresh();
      router.push("/login");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="px-3 py-2 text-[11px] font-mono uppercase tracking-widest text-[var(--color-subtle)]">
        ...
      </div>
    );
  }

  if (!email) {
    return (
      <Link
        href="/login"
        className="group flex items-center gap-2 rounded-md border border-[var(--color-border-strong)] px-2.5 py-1.5 text-[12px] text-[var(--color-fg)] hover:border-[var(--color-accent)]"
      >
        <SignIn weight="duotone" size={14} className="text-[var(--color-accent)]" />
        <span>Sign in</span>
      </Link>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <UserCircle weight="duotone" size={18} className="shrink-0 text-[var(--color-accent)]" />
        <span className="truncate text-[12px] text-[var(--color-fg)]" title={email}>
          {email}
        </span>
      </div>
      <button
        type="button"
        onClick={signOut}
        disabled={busy}
        title="Sign out"
        aria-label="Sign out"
        className="shrink-0 rounded p-1 text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:opacity-50"
      >
        <SignOut weight="duotone" size={14} />
      </button>
    </div>
  );
}
