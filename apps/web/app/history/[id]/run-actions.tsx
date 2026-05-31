"use client";

import { useState, useCallback } from "react";
import useSWR, { mutate } from "swr";
import {
  ShareNetwork,
  Copy,
  DownloadSimple,
  FilePdf,
  Check,
  ArrowSquareOut,
  CircleNotch,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

type ShareState = {
  id: string;
  enabled: boolean;
  token: string | null;
  shared_at: number | null;
  url: string | null;
};

const fetcher = async (u: string): Promise<ShareState> => {
  const r = await fetch(u, { cache: "no-store" });
  if (!r.ok) throw new Error(`http_${r.status}`);
  return r.json();
};

interface Props {
  runId: string;
}

export default function RunActions({ runId }: Props) {
  const key = `/api/runs/${runId}/share`;
  const { data, error, isLoading } = useSWR<ShareState>(key, fetcher);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<"share" | "json" | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const toggle = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      setErrMsg(null);
      try {
        const r = await fetch(key, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        if (!r.ok) throw new Error(`http_${r.status}`);
        const next = (await r.json()) as ShareState;
        await mutate(key, next, { revalidate: false });
      } catch (e) {
        setErrMsg(e instanceof Error ? e.message : "request failed");
      } finally {
        setBusy(false);
      }
    },
    [key],
  );

  const copyShareLink = useCallback(async () => {
    if (!data?.url) return;
    try {
      await navigator.clipboard.writeText(data.url);
      setCopied("share");
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setErrMsg("clipboard blocked");
    }
  }, [data?.url]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
        <CircleNotch weight="duotone" size={14} className="animate-spin" />
        loading share status
      </div>
    );
  }
  if (error) {
    return (
      <div className="text-[12px] text-red-500">
        Could not load share status. Try refresh.
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={`/api/runs/${runId}/download`}
          download
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-border)]/30"
        >
          <DownloadSimple weight="duotone" size={14} /> Download JSON
        </a>
        <a
          href={`/api/runs/${runId}/pdf`}
          download
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-border)]/30"
        >
          <FilePdf weight="duotone" size={14} /> Download PDF
        </a>
        {data.enabled ? (
          <>
            <button
              type="button"
              onClick={copyShareLink}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px]",
                "border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-border)]/30",
              )}
            >
              {copied === "share" ? (
                <>
                  <Check weight="duotone" size={14} /> Copied
                </>
              ) : (
                <>
                  <Copy weight="duotone" size={14} /> Copy public link
                </>
              )}
            </button>
            {data.url && (
              <a
                href={data.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-border)]/30"
              >
                <ArrowSquareOut weight="duotone" size={14} /> Open
              </a>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => toggle(false)}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] text-red-400 hover:bg-red-500/10 disabled:opacity-50"
            >
              {busy ? (
                <CircleNotch weight="duotone" size={14} className="animate-spin" />
              ) : (
                <ShareNetwork weight="duotone" size={14} />
              )}
              Make private
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => toggle(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-2.5 py-1.5 text-[12px] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/20 disabled:opacity-50"
          >
            {busy ? (
              <CircleNotch weight="duotone" size={14} className="animate-spin" />
            ) : (
              <ShareNetwork weight="duotone" size={14} />
            )}
            Create public link
          </button>
        )}
      </div>

      {data.enabled && data.url && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 font-mono text-[11px] break-all text-[var(--color-muted)]">
          {data.url}
        </div>
      )}

      {errMsg && (
        <div className="text-[11px] text-red-400">{errMsg}</div>
      )}
    </div>
  );
}

