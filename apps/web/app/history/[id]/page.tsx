import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRun } from "@/lib/runs-store";
import { getSession } from "@/lib/session";
import { ArrowLeft, Clock, Link as LinkIcon, Repeat } from "@phosphor-icons/react/dist/ssr";
import { PageHeader, Card, CardHeader } from "@/components/ui/primitives";
import RunActions from "./run-actions";
import RunNotes from "./run-notes";
import { isCloneable } from "@/lib/run-clone";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const rec = await getRun(id);
  if (!rec) return { title: "run not found // adherence.ml" };
  return {
    title: `${rec.title} // adherence.ml`,
    description: rec.summary || `${rec.kind} run from adherence.ml`,
    openGraph: {
      title: rec.title,
      description: rec.summary || `${rec.kind} run`,
      type: "article",
    },
  };
}

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const rec = await getRun(id);
  if (!rec) notFound();

  const sess = await getSession();
  const created = new Date(rec.created_at).toLocaleString();
  const pretty = JSON.stringify(rec.payload, null, 2);
  const cloneable = isCloneable(rec);

  return (
    <div className="flex flex-col min-h-screen">
      <PageHeader
        eyebrow={`run / ${rec.kind}`}
        title={rec.title}
        description={rec.summary || "Saved model run, shareable by link."}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {cloneable && (
              <Link
                href={`/predict?from=${encodeURIComponent(rec.id)}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-2.5 py-1.5 text-[12px] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/20"
              >
                <Repeat weight="duotone" size={14} /> Re-run
              </Link>
            )}
            <Link
              href="/history"
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-border)]/30"
            >
              <ArrowLeft weight="duotone" size={14} /> Back to history
            </Link>
          </div>
        }
      />

      <div className="p-6 grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-1">
          <CardHeader title="Run metadata" hint="who / when / how long" />
          <dl className="p-4 grid grid-cols-3 gap-y-2 text-[12px]">
            <dt className="text-[var(--color-muted)]">id</dt>
            <dd className="col-span-2 font-mono break-all">{rec.id}</dd>
            <dt className="text-[var(--color-muted)]">kind</dt>
            <dd className="col-span-2 font-mono uppercase">{rec.kind}</dd>
            <dt className="text-[var(--color-muted)]">user</dt>
            <dd className="col-span-2 font-mono break-all">{rec.user_id ?? "—"}</dd>
            <dt className="text-[var(--color-muted)]">created</dt>
            <dd className="col-span-2 inline-flex items-center gap-1">
              <Clock weight="duotone" size={12} /> {created}
            </dd>
            <dt className="text-[var(--color-muted)]">latency</dt>
            <dd className="col-span-2 font-mono">
              {rec.latency_ms != null ? `${rec.latency_ms} ms` : "—"}
            </dd>
            <dt className="text-[var(--color-muted)]">tags</dt>
            <dd className="col-span-2 font-mono">
              {rec.tags.length === 0 ? "—" : rec.tags.map((t) => `#${t}`).join(" ")}
            </dd>
            <dt className="text-[var(--color-muted)]">share</dt>
            <dd className="col-span-2 inline-flex items-center gap-1 text-[var(--color-accent)]">
              <LinkIcon weight="duotone" size={12} /> /history/{rec.id}
            </dd>
          </dl>
          <div className="p-4 border-t border-[var(--color-border)]">
            <RunActions runId={rec.id} />
          </div>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader title="Payload" hint="request + response, raw" />
          <pre className="p-4 text-[11px] font-mono leading-snug overflow-auto max-h-[70vh] whitespace-pre-wrap break-all">
            {pretty}
          </pre>
        </Card>

        <Card className="md:col-span-3">
          <RunNotes runId={rec.id} currentUserId={sess?.user.id ?? null} />
        </Card>
      </div>
    </div>
  );
}
