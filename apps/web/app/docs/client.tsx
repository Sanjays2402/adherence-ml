"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  Copy,
  Check,
  Key,
  Lightning,
  Play,
  Plugs,
  ClockCounterClockwise,
  Warning,
  ShieldCheck,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  Button,
  Input,
  Empty,
  ErrorBox,
  Badge,
  MonoChip,
  SectionLabel,
} from "@/components/ui/primitives";
import {
  ENDPOINTS,
  GROUPS,
  API_BASE_HINT,
  renderCurl,
  type ApiEndpoint,
  type ApiScope,
} from "@/lib/api-reference";

const SCOPE_TONE: Record<ApiScope, "success" | "warn" | "neutral"> = {
  predict: "success",
  read: "neutral",
  webhooks: "warn",
  audit: "warn",
};

const METHOD_TONE: Record<ApiEndpoint["method"], string> = {
  GET: "text-emerald-400 border-emerald-400/30 bg-emerald-400/5",
  POST: "text-sky-400 border-sky-400/30 bg-sky-400/5",
  PATCH: "text-amber-400 border-amber-400/30 bg-amber-400/5",
  DELETE: "text-rose-400 border-rose-400/30 bg-rose-400/5",
};

const GROUP_ICON = {
  predict: Lightning,
  runs: ClockCounterClockwise,
  webhooks: Plugs,
  keys: Key,
  audit: ShieldCheck,
} as const;

const STORAGE_KEY = "adh-docs-key";
const STORAGE_HOST = "adh-docs-host";

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* noop */
        }
      }}
      className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
      aria-label="copy"
    >
      {done ? <Check weight="bold" size={12} /> : <Copy weight="duotone" size={12} />}
      {done ? "copied" : "copy"}
    </button>
  );
}

function MethodChip({ method }: { method: ApiEndpoint["method"] }) {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider rounded border ${METHOD_TONE[method]}`}
    >
      {method}
    </span>
  );
}

function EndpointCard({
  ep,
  host,
  apiKey,
  onTest,
  testResult,
  testing,
}: {
  ep: ApiEndpoint;
  host: string;
  apiKey: string;
  onTest: (ep: ApiEndpoint) => void;
  testResult?: { status: number; ms: number; body: string } | { error: string };
  testing: boolean;
}) {
  const rendered = renderCurl(ep.curl, host, apiKey);
  return (
    <Card className="overflow-hidden" key={ep.id}>
      <div className="px-4 py-3 border-b border-[var(--color-border)]">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <MethodChip method={ep.method} />
            <span className="font-mono text-[13px] truncate">{ep.path}</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone={SCOPE_TONE[ep.scope]}>scope: {ep.scope}</Badge>
            {ep.liveTestable ? (
              <Button
                variant="ghost"
                disabled={testing || !apiKey}
                onClick={() => onTest(ep)}
                title={!apiKey ? "paste a key above to test live" : "run this request from your browser"}
                className="inline-flex items-center gap-1 text-[11px] px-2 py-1"
              >
                <Play weight="duotone" size={12} />
                {testing ? "running" : "test it"}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      <div className="px-4 pb-4 space-y-3">
        <p className="text-[13px] text-[var(--color-muted)] leading-relaxed">{ep.summary}</p>
        <div className="relative">
          <pre className="text-[12px] font-mono leading-relaxed bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md p-3 overflow-x-auto whitespace-pre">
            {rendered}
          </pre>
          <div className="absolute top-2 right-2">
            <CopyBtn text={rendered} />
          </div>
        </div>
        {testResult && "error" in testResult ? (
          <ErrorBox message={testResult.error} />
        ) : testResult ? (
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]">
            <div className="px-3 py-2 border-b border-[var(--color-border)] flex items-center justify-between">
              <div className="flex items-center gap-2 text-[11px] font-mono">
                <span
                  className={
                    testResult.status >= 200 && testResult.status < 300
                      ? "text-emerald-400"
                      : "text-rose-400"
                  }
                >
                  {testResult.status}
                </span>
                <span className="text-[var(--color-muted)]">{testResult.ms}ms</span>
              </div>
              <CopyBtn text={testResult.body} />
            </div>
            <pre className="text-[11px] font-mono leading-relaxed p-3 overflow-x-auto max-h-72">
              {testResult.body}
            </pre>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

export default function DocsClient() {
  const [host, setHost] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [results, setResults] = useState<
    Record<string, { status: number; ms: number; body: string } | { error: string }>
  >({});
  const [testingId, setTestingId] = useState<string | null>(null);

  // Default host to the current origin once we're on the client.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const storedHost = window.localStorage.getItem(STORAGE_HOST);
    setHost(storedHost ?? window.location.origin);
    const storedKey = window.localStorage.getItem(STORAGE_KEY);
    if (storedKey) setApiKey(storedKey);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (host) window.localStorage.setItem(STORAGE_HOST, host);
  }, [host]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (apiKey) window.localStorage.setItem(STORAGE_KEY, apiKey);
  }, [apiKey]);

  const grouped = useMemo(() => {
    return GROUPS.map((g) => ({
      ...g,
      items: ENDPOINTS.filter((e) => e.group === g.id),
    }));
  }, []);

  const runTest = useCallback(
    async (ep: ApiEndpoint) => {
      if (!apiKey) return;
      setTestingId(ep.id);
      const url = (host || window.location.origin).replace(/\/$/, "") + ep.path;
      const started = performance.now();
      try {
        const res = await fetch(url, {
          method: ep.method,
          headers: { authorization: `Bearer ${apiKey}` },
        });
        const ms = Math.round(performance.now() - started);
        const text = await res.text();
        let pretty = text;
        try {
          pretty = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          /* keep raw */
        }
        setResults((r) => ({ ...r, [ep.id]: { status: res.status, ms, body: pretty } }));
      } catch (e) {
        setResults((r) => ({
          ...r,
          [ep.id]: { error: e instanceof Error ? e.message : "network error" },
        }));
      } finally {
        setTestingId(null);
      }
    },
    [apiKey, host],
  );

  return (
    <div className="flex flex-col">
      <PageHeader
        eyebrow="developer"
        title="API reference"
        description="Every public /v1 endpoint with a copy-paste curl and a live tester. Paste a key from the API keys page and run GET requests without leaving this page."
        actions={
          <Link href="/api-keys">
            <Button variant="ghost" className="inline-flex items-center gap-1 text-[12px] px-2 py-1">
              <Key weight="duotone" size={14} /> manage keys
            </Button>
          </Link>
        }
      />

      <div className="p-6 grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
        <aside className="hidden lg:flex flex-col gap-4 sticky top-6 self-start">
          <SectionLabel>Sections</SectionLabel>
          <nav className="flex flex-col gap-1">
            {grouped.map((g) => {
              const Icon = GROUP_ICON[g.id];
              return (
                <a
                  key={g.id}
                  href={`#${g.id}`}
                  className="flex items-center gap-2 text-[13px] px-2 py-1.5 rounded hover:bg-[var(--color-surface)] text-[var(--color-fg)]"
                >
                  <Icon weight="duotone" size={14} />
                  <span>{g.label}</span>
                  <span className="ml-auto text-[10px] font-mono text-[var(--color-muted)]">
                    {g.items.length}
                  </span>
                </a>
              );
            })}
          </nav>
        </aside>

        <div className="space-y-6 min-w-0">
          <Card>
            <div className="px-4 py-3 border-b border-[var(--color-border)]">
              <div className="flex items-center gap-2">
                <ShieldCheck weight="duotone" size={16} />
                <span className="text-[13px] font-medium">Try it from your browser</span>
              </div>
            </div>
            <div className="px-4 pt-4 pb-4 space-y-3">
              <p className="text-[12px] text-[var(--color-muted)]">{API_BASE_HINT}</p>
              <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
                    host
                  </label>
                  <Input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="http://localhost:3000"
                    spellCheck={false}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
                    api key (stays in this browser)
                  </label>
                  <Input
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="adh_..."
                    spellCheck={false}
                    type="password"
                    autoComplete="off"
                  />
                </div>
              </div>
              {!apiKey ? (
                <div className="flex items-start gap-2 text-[12px] text-[var(--color-muted)]">
                  <Warning weight="duotone" size={14} className="mt-0.5 shrink-0" />
                  <span>
                    No key pasted yet. The curl snippets below show <MonoChip>$KEY</MonoChip> until you paste
                    one. Get one from{" "}
                    <Link href="/api-keys" className="underline">
                      API keys
                    </Link>
                    .
                  </span>
                </div>
              ) : null}
            </div>
          </Card>

          {grouped.map((g) => {
            const Icon = GROUP_ICON[g.id];
            return (
              <section key={g.id} id={g.id} className="space-y-3 scroll-mt-6">
                <div className="flex items-center gap-2">
                  <Icon weight="duotone" size={16} />
                  <h2 className="text-[14px] font-semibold tracking-tight">{g.label}</h2>
                  <span className="text-[12px] text-[var(--color-muted)]">{g.blurb}</span>
                </div>
                {g.items.length === 0 ? (
                  <Empty title="Nothing here yet" hint="This group has no endpoints." icon={<BookOpen weight="duotone" size={20} />} />
                ) : (
                  <div className="grid grid-cols-1 gap-3">
                    {g.items.map((ep) => (
                      <EndpointCard
                        key={ep.id}
                        ep={ep}
                        host={host}
                        apiKey={apiKey}
                        onTest={runTest}
                        testResult={results[ep.id]}
                        testing={testingId === ep.id}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
