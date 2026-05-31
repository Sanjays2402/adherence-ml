import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Clock, ShareNetwork, ArrowRight } from "@phosphor-icons/react/dist/ssr";
import { getRunByShareToken } from "@/lib/runs-store";
import { PageHeader, Card, CardHeader } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Props {
  params: Promise<{ token: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const rec = await getRunByShareToken(token);
  if (!rec) return { title: "Shared run not found // adherence.ml" };
  const ogPath = `/share/${token}/opengraph-image`;
  return {
    title: `${rec.title} // adherence.ml`,
    description: rec.summary || `Shared ${rec.kind} run`,
    openGraph: {
      title: rec.title,
      description: rec.summary || `Shared ${rec.kind} run`,
      type: "article",
      images: [
        {
          url: ogPath,
          width: 1200,
          height: 630,
          alt: rec.title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: rec.title,
      description: rec.summary || `Shared ${rec.kind} run`,
      images: [ogPath],
    },
    robots: { index: false, follow: false },
  };
}

export default async function PublicSharedRunPage({ params }: Props) {
  const { token } = await params;
  const rec = await getRunByShareToken(token);
  if (!rec) notFound();

  const created = new Date(rec.created_at).toLocaleString();
  const sharedAt = rec.shared_at
    ? new Date(rec.shared_at).toLocaleString()
    : null;
  const pretty = JSON.stringify(rec.payload, null, 2);

  return (
    <div className="flex flex-col min-h-screen">
      <PageHeader
        eyebrow={`shared / ${rec.kind}`}
        title={rec.title}
        description={
          rec.summary || "Publicly shared model run from adherence.ml"
        }
        actions={
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-border)]/30"
          >
            Try adherence.ml <ArrowRight weight="duotone" size={14} />
          </Link>
        }
      />

      <div className="p-6 grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-1">
          <CardHeader
            title="Run metadata"
            hint="public view"
          />
          <dl className="p-4 grid grid-cols-3 gap-y-2 text-[12px]">
            <dt className="text-[var(--color-muted)]">kind</dt>
            <dd className="col-span-2 font-mono uppercase">{rec.kind}</dd>
            <dt className="text-[var(--color-muted)]">created</dt>
            <dd className="col-span-2 inline-flex items-center gap-1">
              <Clock weight="duotone" size={12} /> {created}
            </dd>
            {sharedAt && (
              <>
                <dt className="text-[var(--color-muted)]">shared</dt>
                <dd className="col-span-2 inline-flex items-center gap-1">
                  <ShareNetwork weight="duotone" size={12} /> {sharedAt}
                </dd>
              </>
            )}
            <dt className="text-[var(--color-muted)]">latency</dt>
            <dd className="col-span-2 font-mono">
              {rec.latency_ms != null ? `${rec.latency_ms} ms` : "n/a"}
            </dd>
            {rec.tags.length > 0 && (
              <>
                <dt className="text-[var(--color-muted)]">tags</dt>
                <dd className="col-span-2 font-mono">
                  {rec.tags.map((t) => `#${t}`).join(" ")}
                </dd>
              </>
            )}
          </dl>
          <div className="p-4 border-t border-[var(--color-border)] text-[11px] text-[var(--color-muted)]">
            This is a read-only public link. The owner can revoke it at any
            time from their history.
          </div>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader title="Payload" hint="request and response" />
          <pre className="p-4 text-[11px] font-mono leading-snug overflow-auto max-h-[70vh] whitespace-pre-wrap break-all">
            {pretty}
          </pre>
        </Card>
      </div>
    </div>
  );
}
