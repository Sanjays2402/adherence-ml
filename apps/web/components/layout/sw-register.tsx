"use client";

/**
 * Registers the service worker that powers the offline shell.
 *
 * Skipped in development so HMR keeps working. Also surfaces a small
 * "update ready" chip when a new worker has taken control, so users get the
 * new bundle without a stale screenshot.
 */
import { useEffect, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";

export default function SwRegister() {
  const [updated, setUpdated] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;

    let firstControl = !navigator.serviceWorker.controller;

    const onControllerChange = () => {
      if (firstControl) {
        firstControl = false;
        return;
      }
      setUpdated(true);
    };

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch(() => {
        /* registration failures are non-fatal; app works without offline shell */
      });

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  if (!updated) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs shadow-lg hover:bg-[var(--color-surface-hover)]"
      >
        <ArrowClockwise size={14} weight="duotone" />
        New version ready, reload
      </button>
    </div>
  );
}
