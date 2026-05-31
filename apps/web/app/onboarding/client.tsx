"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  Sparkle,
  Key,
  FloppyDisk,
  CheckCircle,
  Circle,
  ArrowRight,
  Copy,
  Warning,
  Rocket,
  ArrowCounterClockwise,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Button,
  ErrorBox,
  Skeleton,
  Badge,
} from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

type StepId = "explore_demo" | "issue_key" | "save_run";

type OnboardingState = {
  version: 1;
  completed: StepId[];
  dismissed: boolean;
  seeded_at: number | null;
  updated_at: number;
};

type SeedResp = {
  ok: boolean;
  runs_added: number;
  runs_skipped: number;
  api_key_added: boolean;
  api_key_skipped: boolean;
  api_key_plaintext: string | null;
  webhook_added: boolean;
  webhook_skipped: boolean;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const STEPS: Array<{
  id: StepId;
  num: number;
  title: string;
  blurb: string;
  icon: React.ComponentType<{ size?: number; weight?: "duotone" }>;
}> = [
  {
    id: "explore_demo",
    num: 1,
    title: "Seed your workspace",
    blurb:
      "Populate three sample patient runs, one revoked API key for the curl example, and a sample webhook endpoint. Safe to re-run, this step is idempotent.",
    icon: Sparkle,
  },
  {
    id: "issue_key",
    num: 2,
    title: "Issue an API key",
    blurb:
      "Generate a personal key for programmatic scoring. The key is shown once at creation, then stored as a hash. Use it with /v1/predict.",
    icon: Key,
  },
  {
    id: "save_run",
    num: 3,
    title: "Save your first real run",
    blurb:
      "Score a patient on the Predict page. Every run lands in History with a shareable public URL and a CSV export option.",
    icon: FloppyDisk,
  },
];

function StepBadge({ done, num }: { done: boolean; num: number }) {
  return done ? (
    <div className="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--color-accent)]/15 text-[var(--color-accent)]">
      <CheckCircle size={18} weight="duotone" />
    </div>
  ) : (
    <div className="flex items-center justify-center w-7 h-7 rounded-full border border-[var(--color-border)] text-[12px] font-mono text-[var(--color-muted)]">
      {num}
    </div>
  );
}

export default function OnboardingClient() {
  const { data, error, isLoading, mutate } = useSWR<OnboardingState>(
    "/api/onboarding",
    fetcher,
    { refreshInterval: 0 },
  );

  const [seeding, setSeeding] = useState(false);
  const [seedResp, setSeedResp] = useState<SeedResp | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const completed = useMemo(
    () => new Set<StepId>(data?.completed ?? []),
    [data?.completed],
  );

  // Auto-detect step 1 completion when seeded_at is set.
  useEffect(() => {
    if (data?.seeded_at && !completed.has("explore_demo")) {
      void fetch("/api/onboarding", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step: "explore_demo", done: true }),
      }).then(() => mutate());
    }
  }, [data?.seeded_at, completed, mutate]);

  const seed = useCallback(async () => {
    setSeeding(true);
    setSeedError(null);
    try {
      const res = await fetch("/api/onboarding/seed", { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as SeedResp;
      setSeedResp(j);
      await mutate();
    } catch (e) {
      setSeedError(e instanceof Error ? e.message : "seed failed");
    } finally {
      setSeeding(false);
    }
  }, [mutate]);

  const markDone = useCallback(
    async (step: StepId, done = true) => {
      await fetch("/api/onboarding", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step, done }),
      });
      await mutate();
    },
    [mutate],
  );

  const copy = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 1400);
    } catch {
      /* ignore */
    }
  }, []);

  const resetProgress = useCallback(async () => {
    setResetting(true);
    try {
      for (const s of STEPS) {
        await fetch("/api/onboarding", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ step: s.id, done: false }),
        });
      }
      await mutate();
    } finally {
      setResetting(false);
    }
  }, [mutate]);

  const totalDone = STEPS.filter((s) => completed.has(s.id)).length;
  const pct = Math.round((totalDone / STEPS.length) * 100);

  const sampleCurl = `curl -sS -X POST http://localhost:3000/v1/predict \\
  -H "authorization: Bearer YOUR_KEY_HERE" \\
  -H "content-type: application/json" \\
  -d '{"patient_id":"demo-stable-htn","features":{"time_since_last_dose":6,"missed_in_last_72h":0,"novelty_score":0.1}}'`;

  return (
    <div className="flex flex-col">
      <PageHeader
        eyebrow="first run"
        title="Get started in three steps"
        description="A guided path from empty workspace to a saved run with a shareable URL and a working API key."
        actions={
          <Button
            variant="ghost"
            onClick={resetProgress}
            disabled={resetting || totalDone === 0}
            aria-label="Reset onboarding progress"
          >
            <ArrowCounterClockwise size={14} weight="duotone" />
            <span>Reset progress</span>
          </Button>
        }
      />

      <div className="px-4 md:px-6 py-5 flex flex-col gap-4 max-w-3xl w-full mx-auto">
        {/* Progress strip */}
        <Card>
          <div className="px-4 py-3 flex items-center gap-4">
            <div className="flex items-center gap-2 text-[12px] font-mono text-[var(--color-muted)]">
              <Rocket size={16} weight="duotone" />
              <span>Progress</span>
            </div>
            <div className="flex-1 h-2 rounded-full bg-[var(--color-border)]/60 overflow-hidden">
              <div
                className="h-full bg-[var(--color-accent)] transition-all duration-500"
                style={{ width: `${pct}%` }}
                aria-label={`${pct}% complete`}
              />
            </div>
            <div className="text-[12px] font-mono tabular-nums text-[var(--color-muted)]">
              {totalDone}/{STEPS.length}
            </div>
          </div>
        </Card>

        {error ? <ErrorBox message="Could not load onboarding state." /> : null}

        {isLoading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          STEPS.map((step) => {
            const done = completed.has(step.id);
            const Icon = step.icon;
            return (
              <Card key={step.id} className={cn(done && "opacity-95")}>
                <div className="px-4 py-4 flex items-start gap-4">
                  <StepBadge done={done} num={step.num} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Icon size={16} weight="duotone" />
                      <h2 className="text-[14px] font-medium">{step.title}</h2>
                      {done ? (
                        <Badge tone="success">done</Badge>
                      ) : (
                        <Badge tone="neutral">todo</Badge>
                      )}
                    </div>
                    <p className="text-[12.5px] text-[var(--color-muted)] mt-1.5 leading-relaxed">
                      {step.blurb}
                    </p>

                    {/* Step-specific action area */}
                    <div className="mt-3 flex flex-col gap-3">
                      {step.id === "explore_demo" ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            onClick={seed}
                            disabled={seeding}
                            aria-label="Seed sample workspace"
                          >
                            <Sparkle size={14} weight="duotone" />
                            <span>
                              {seeding
                                ? "Seeding..."
                                : data?.seeded_at
                                  ? "Re-seed sample data"
                                  : "Seed sample data"}
                            </span>
                          </Button>
                          <Link href="/demo" prefetch={false}>
                            <Button variant="ghost">
                              <span>Try a sample patient</span>
                              <ArrowRight size={14} weight="duotone" />
                            </Button>
                          </Link>
                          {data?.seeded_at ? (
                            <span className="text-[11px] font-mono text-[var(--color-muted)]">
                              seeded {new Date(data.seeded_at).toLocaleString()}
                            </span>
                          ) : null}
                        </div>
                      ) : null}

                      {step.id === "issue_key" ? (
                        <div className="flex flex-col gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <Link href="/api-keys" prefetch={false}>
                              <Button>
                                <Key size={14} weight="duotone" />
                                <span>Open API keys</span>
                              </Button>
                            </Link>
                            <Button
                              variant="ghost"
                              onClick={() => markDone("issue_key", !done)}
                            >
                              <CheckCircle size={14} weight="duotone" />
                              <span>{done ? "Mark not done" : "I created a key"}</span>
                            </Button>
                          </div>
                          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/60">
                            <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--color-border)]">
                              <span className="text-[10px] font-mono uppercase tracking-[0.16em] text-[var(--color-muted)]">
                                sample curl
                              </span>
                              <button
                                type="button"
                                onClick={() => copy(sampleCurl, "curl")}
                                className="text-[11px] inline-flex items-center gap-1 text-[var(--color-muted)] hover:text-[var(--color-fg)] transition"
                                aria-label="Copy curl example"
                              >
                                <Copy size={12} weight="duotone" />
                                {copied === "curl" ? "copied" : "copy"}
                              </button>
                            </div>
                            <pre className="px-3 py-2 text-[11.5px] font-mono leading-relaxed overflow-x-auto whitespace-pre">
                              {sampleCurl}
                            </pre>
                          </div>
                        </div>
                      ) : null}

                      {step.id === "save_run" ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <Link href="/predict" prefetch={false}>
                            <Button>
                              <FloppyDisk size={14} weight="duotone" />
                              <span>Score a patient</span>
                            </Button>
                          </Link>
                          <Link href="/history" prefetch={false}>
                            <Button variant="ghost">
                              <span>Open History</span>
                              <ArrowRight size={14} weight="duotone" />
                            </Button>
                          </Link>
                          <Button
                            variant="ghost"
                            onClick={() => markDone("save_run", !done)}
                          >
                            <CheckCircle size={14} weight="duotone" />
                            <span>{done ? "Mark not done" : "Mark complete"}</span>
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })
        )}

        {seedError ? <ErrorBox message={seedError} /> : null}

        {seedResp ? (
          <Card>
            <CardHeader title="seed result" hint="What landed in your workspace" />
            <div className="px-4 py-3 grid grid-cols-2 md:grid-cols-3 gap-3 text-[12px]">
              <div>
                <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-[var(--color-muted)]">
                  runs
                </div>
                <div className="font-mono tabular-nums">
                  +{seedResp.runs_added}{" "}
                  <span className="text-[var(--color-muted)]">
                    / skipped {seedResp.runs_skipped}
                  </span>
                </div>
              </div>
              <div>
                <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-[var(--color-muted)]">
                  api key
                </div>
                <div className="font-mono tabular-nums">
                  {seedResp.api_key_added ? "+1 (revoked)" : "skipped"}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-[var(--color-muted)]">
                  webhook
                </div>
                <div className="font-mono tabular-nums">
                  {seedResp.webhook_added ? "+1 (inactive)" : "skipped"}
                </div>
              </div>
            </div>
            {seedResp.api_key_plaintext ? (
              <div className="px-4 pb-4">
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-[12px] flex gap-2">
                  <Warning size={16} weight="duotone" className="text-amber-500 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <div className="font-medium mb-1">
                      Sample key shown once (already revoked)
                    </div>
                    <code className="block font-mono text-[11.5px] break-all text-[var(--color-muted)]">
                      {seedResp.api_key_plaintext}
                    </code>
                  </div>
                </div>
              </div>
            ) : null}
          </Card>
        ) : null}

        {totalDone === STEPS.length ? (
          <Card>
            <div className="px-4 py-5 flex items-start gap-3">
              <CheckCircle
                size={22}
                weight="duotone"
                className="text-[var(--color-accent)] shrink-0"
              />
              <div className="flex-1">
                <div className="text-[14px] font-medium">You are set up.</div>
                <p className="text-[12.5px] text-[var(--color-muted)] mt-1">
                  Next stops: usage meter, batch CSV scoring, or registering a
                  real webhook endpoint.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link href="/usage" prefetch={false}>
                    <Button variant="ghost">
                      <span>View usage</span>
                      <ArrowRight size={14} weight="duotone" />
                    </Button>
                  </Link>
                  <Link href="/batch" prefetch={false}>
                    <Button variant="ghost">
                      <span>Batch score a CSV</span>
                      <ArrowRight size={14} weight="duotone" />
                    </Button>
                  </Link>
                  <Link href="/webhooks" prefetch={false}>
                    <Button variant="ghost">
                      <span>Wire a webhook</span>
                      <ArrowRight size={14} weight="duotone" />
                    </Button>
                  </Link>
                </div>
              </div>
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
