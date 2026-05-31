import type { Metadata } from "next";
import LoginClient from "./client";
import { getSession } from "@/lib/session";
import { isGithubOAuthConfigured } from "@/lib/oauth-state";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "sign in // adherence.ml",
  description: "Sign in to save runs, manage API keys, and share results.",
};

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const ctx = await getSession();
  const sp = await searchParams;
  if (ctx) {
    redirect(sp.next && sp.next.startsWith("/") ? sp.next : "/");
  }
  return (
    <LoginClient
      error={sp.error ?? null}
      next={sp.next ?? null}
      githubEnabled={isGithubOAuthConfigured()}
    />
  );
}
