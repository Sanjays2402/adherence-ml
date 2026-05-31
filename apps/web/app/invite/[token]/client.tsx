"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { UsersThree, Check, ArrowRight } from "@phosphor-icons/react";
import {
  Card,
  CardHeader,
  Button,
  ErrorBox,
  Skeleton,
  Badge,
} from "@/components/ui/primitives";

type Preview = {
  workspace: { id: string; name: string };
  email: string;
  role: "owner" | "editor" | "viewer";
  expires_at: number;
};

type Me = { user: { id: string; email: string } | null };

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.detail ?? `request failed (${r.status})`);
  }
  return r.json();
};

export default function InviteAcceptClient({ token }: { token: string }) {
  const router = useRouter();
  const preview = useSWR<Preview>(
    `/api/workspaces/invites/accept?token=${encodeURIComponent(token)}`,
    fetcher,
    { revalidateOnFocus: false },
  );
  const me = useSWR<Me>("/api/auth/me", fetcher, { revalidateOnFocus: false });

  const [accepting, setAccepting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (done) {
      const t = setTimeout(() => router.push("/workspace"), 900);
      return () => clearTimeout(t);
    }
  }, [done, router]);

  const accept = async () => {
    setAccepting(true);
    setErr(null);
    try {
      const r = await fetch("/api/workspaces/invites/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const j = await r.json();
      if (!r.ok) {
        setErr(j.detail ?? "Could not accept invite.");
      } else {
        setDone(true);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "network error");
    } finally {
      setAccepting(false);
    }
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <Card>
          <CardHeader title="workspace invite" hint="Review and accept" />
          <div className="p-5 flex flex-col gap-4">
            {preview.error ? (
              <ErrorBox message={String(preview.error.message ?? preview.error)} />
            ) : !preview.data ? (
              <>
                <Skeleton className="h-8 w-2/3" />
                <Skeleton className="h-6 w-1/2" />
                <Skeleton className="h-10 w-full" />
              </>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 text-[var(--color-accent)]">
                    <UsersThree weight="duotone" size={22} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                      You are invited to
                    </div>
                    <div className="text-[16px] font-semibold truncate">
                      {preview.data.workspace.name}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 text-[12px]">
                  <Badge>role: {preview.data.role}</Badge>
                  <Badge>for: {preview.data.email}</Badge>
                </div>

                {!me.data?.user ? (
                  <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-[13px] flex flex-col gap-2">
                    <span className="text-[var(--color-muted)]">
                      Sign in with {preview.data.email} to accept.
                    </span>
                    <Link
                      href={`/login?email=${encodeURIComponent(preview.data.email)}&next=${encodeURIComponent("/invite/" + token)}`}
                      className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline"
                    >
                      Sign in <ArrowRight weight="duotone" size={12} />
                    </Link>
                  </div>
                ) : me.data.user.email.toLowerCase() !== preview.data.email.toLowerCase() ? (
                  <ErrorBox
                    message={`Signed in as ${me.data.user.email}, but invite is for ${preview.data.email}. Sign out and sign back in with the invited address.`}
                  />
                ) : done ? (
                  <div className="rounded-md border border-[var(--color-low)]/40 bg-[var(--color-low)]/10 p-3 text-[13px] inline-flex items-center gap-2">
                    <Check weight="duotone" size={16} /> Joined. Redirecting to your workspace.
                  </div>
                ) : (
                  <>
                    {err ? <ErrorBox message={err} /> : null}
                    <Button onClick={accept} disabled={accepting} variant="accent">
                      {accepting ? "Accepting..." : "Accept invite"}
                    </Button>
                  </>
                )}
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
