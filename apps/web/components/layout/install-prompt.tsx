"use client";

/**
 * Lightweight, dismissable PWA install prompt.
 *
 * Listens for `beforeinstallprompt` and surfaces a small floating chip on
 * supported browsers (Chrome, Edge, Android). Dismissal is remembered for
 * 14 days in localStorage so we never nag. iOS Safari does not fire
 * `beforeinstallprompt`, so for iOS users we fall back to a one-line "Add
 * to Home Screen" hint surfaced via the same chip on first visit.
 */
import { useEffect, useState } from "react";
import { DeviceMobile, Download, X } from "@phosphor-icons/react";

const STORAGE_KEY = "adh-install-dismissed-at";
const DISMISS_MS = 14 * 24 * 60 * 60 * 1000;

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function recentlyDismissed(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (!v) return false;
    return Date.now() - Number(v) < DISMISS_MS;
  } catch {
    return false;
  }
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // iOS uses navigator.standalone; other browsers use display-mode media query
  const mq = window.matchMedia?.("(display-mode: standalone)").matches;
  const ios = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return Boolean(mq || ios);
}

function isIos(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) && !(/CriOS|FxiOS|EdgiOS/.test(ua));
}

export default function InstallPrompt() {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if (isStandalone() || recentlyDismissed()) return;

    const onBefore = (e: Event) => {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
      setHidden(false);
    };
    window.addEventListener("beforeinstallprompt", onBefore);

    if (isIos()) {
      setIosHint(true);
      setHidden(false);
    }
    return () => window.removeEventListener("beforeinstallprompt", onBefore);
  }, []);

  if (hidden) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    setHidden(true);
  };

  const install = async () => {
    if (!evt) return;
    await evt.prompt();
    try {
      const choice = await evt.userChoice;
      if (choice.outcome === "accepted") setHidden(true);
    } catch {
      /* ignore */
    }
    dismiss();
  };

  return (
    <div
      role="dialog"
      aria-label="install adherence as an app"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 max-w-[calc(100vw-2rem)]"
    >
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur shadow-lg">
        <DeviceMobile weight="duotone" size={18} className="text-[var(--color-accent)] shrink-0" />
        <div className="text-[12px] leading-tight min-w-0">
          <div className="font-medium truncate">Install adherence</div>
          <div className="text-[11px] text-[var(--color-muted)] truncate">
            {iosHint
              ? "Tap Share, then Add to Home Screen"
              : "Faster launches and an app icon on your device"}
          </div>
        </div>
        {!iosHint && evt ? (
          <button
            type="button"
            onClick={install}
            className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/15 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
          >
            <Download weight="duotone" size={12} />
            Install
          </button>
        ) : null}
        <button
          type="button"
          onClick={dismiss}
          aria-label="dismiss install prompt"
          className="p-1 rounded text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-border)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
        >
          <X weight="bold" size={12} />
        </button>
      </div>
    </div>
  );
}
