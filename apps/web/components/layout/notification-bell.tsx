"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "@phosphor-icons/react";

interface ApiResp {
  unread: number;
  authenticated: boolean;
}

export default function NotificationBell() {
  const [count, setCount] = useState<number>(0);
  const [authed, setAuthed] = useState<boolean>(false);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch("/api/notifications?unread=1&limit=1", { cache: "no-store" });
        if (!r.ok) return;
        const data = (await r.json()) as ApiResp;
        if (!alive) return;
        setCount(data.unread);
        setAuthed(data.authenticated);
      } catch {
        // network errors are fine; the bell just stays at its last value
      }
    }
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <Link
      href="/notifications"
      className="relative inline-flex items-center justify-center h-8 w-8 rounded-md text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-border)]/30 transition-colors"
      aria-label={`Notifications${count > 0 ? `, ${count} unread` : ""}`}
      title={authed ? "Notifications" : "Notifications (sign in for personal alerts)"}
    >
      <Bell weight="duotone" size={16} />
      {count > 0 ? (
        <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-[var(--color-accent)] text-[10px] font-mono font-semibold text-white flex items-center justify-center leading-none">
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </Link>
  );
}
