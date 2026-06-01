"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  Archive,
  Brain,
  DownloadSimple,
  Plus,
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorBox,
  Input,
  Select,
  Skeleton,
} from "@/components/ui/primitives";

type Sensitivity = "none" | "low" | "medium" | "high" | "phi";
type Fairness =
  | "not_assessed"
  | "in_progress"
  | "assessed"
  | "remediation";

type ModelCard = {
  id: number;
  tenant_id: string;
  model_name: string;
  model_version: string;
  owner: string;
  intended_use: string | null;
  training_data_summary: string | null;
  training_data_sensitivity: Sensitivity;
  evaluation_summary: string | null;
  limitations: string | null;
  phi_suitable: boolean;
  fairness_status: Fairness;
  last_validated_at: string | null;
  model_card_url: string | null;
  notes: string | null;
  version: number;
  status: string;
  created_by: string;
  created_at: string;
  archived_by: string | null;
  archived_at: string | null;
  archive_reason: string | null;
  superseded_by_id: number | null;
  active: boolean;
};

type ListResp = {
  tenant_id: string;
  active_count: number;
  archived_count: number;
  phi_suitable_count: number;
  unvalidated_active_count: number;
  total: number;
  entries: ModelCard[];
};

const fetcher = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(
      typeof body?.detail === "string"
        ? body.detail
        : `request failed (${r.status})`,
    );
  }
  return r.json();
};

function fmtTime(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z";
  } catch {
    return iso;
  }
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-xs">
      <span className="font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="text-[11px] text-[var(--color-muted)]">{hint}</span>
      ) : null}
    </label>
  );
}

function sensitivityTone(
  s: Sensitivity,
): "success" | "warn" | "danger" | "neutral" {
  if (s === "phi" || s === "high") return "danger";
  if (s === "medium") return "warn";
  return "neutral";
}

function fairnessTone(
  f: Fairness,
): "success" | "warn" | "danger" | "neutral" {
  if (f === "assessed") return "success";
  if (f === "in_progress") return "warn";
  if (f === "remediation") return "danger";
  return "neutral";
}

export default function ModelCardsClient() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data, error, isLoading, mutate } = useSWR<ListResp>(
    `/api/model-cards?include_archived=${includeArchived}`,
    fetcher<ListResp>,
  );

  const [modelName, setModelName] = useState("");
  const [modelVersion, setModelVersion] = useState("");
  const [owner, setOwner] = useState("");
  const [intendedUse, setIntendedUse] = useState("");
  const [trainingSummary, setTrainingSummary] = useState("");
  const [sensitivity, setSensitivity] = useState<Sensitivity>("none");
  const [evalSummary, setEvalSummary] = useState("");
  const [limitations, setLimitations] = useState("");
  const [phiSuitable, setPhiSuitable] = useState(false);
  const [fairness, setFairness] = useState<Fairness>("not_assessed");
  const [lastValidated, setLastValidated] = useState("");
  const [cardUrl, setCardUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [supersede, setSupersede] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<number | null>(null);

  const phiCount = useMemo(() => data?.phi_suitable_count ?? 0, [data]);
  const unvalidatedCount = useMemo(
    () => data?.unvalidated_active_count ?? 0,
    [data],
  );

  const reset = () => {
    setModelName("");
    setModelVersion("");
    setOwner("");
    setIntendedUse("");
    setTrainingSummary("");
    setSensitivity("none");
    setEvalSummary("");
    setLimitations("");
    setPhiSuitable(false);
    setFairness("not_assessed");
    setLastValidated("");
    setCardUrl("");
    setNotes("");
    setSupersede("");
  };

  const onCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      if (modelName.trim().length < 2) {
        setFormError("model_name must be at least 2 characters");
        return;
      }
      if (!modelVersion.trim()) {
        setFormError("model_version is required");
        return;
      }
      if (!owner.trim()) {
        setFormError("owner is required");
        return;
      }
      if (phiSuitable && sensitivity !== "phi") {
        setFormError(
          "phi_suitable=true requires training_data_sensitivity=phi",
        );
        return;
      }
      const body = {
        model_name: modelName.trim(),
        model_version: modelVersion.trim(),
        owner: owner.trim(),
        intended_use: intendedUse.trim() || null,
        training_data_summary: trainingSummary.trim() || null,
        training_data_sensitivity: sensitivity,
        evaluation_summary: evalSummary.trim() || null,
        limitations: limitations.trim() || null,
        phi_suitable: phiSuitable,
        fairness_status: fairness,
        last_validated_at: lastValidated.trim() || null,
        model_card_url: cardUrl.trim() || null,
        notes: notes.trim() || null,
        supersede_reason: supersede.trim() || null,
      };
      setSubmitting(true);
      try {
        const r = await fetch("/api/model-cards", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const b = await r.json().catch(() => ({}));
          throw new Error(
            typeof b?.detail === "string"
              ? b.detail
              : `request failed (${r.status})`,
          );
        }
        reset();
        await mutate();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "failed to create");
      } finally {
        setSubmitting(false);
      }
    },
    [
      modelName,
      modelVersion,
      owner,
      intendedUse,
      trainingSummary,
      sensitivity,
      evalSummary,
      limitations,
      phiSuitable,
      fairness,
      lastValidated,
      cardUrl,
      notes,
      supersede,
      mutate,
    ],
  );

  const onArchive = useCallback(
    async (id: number) => {
      setArchivingId(id);
      try {
        const r = await fetch(`/api/model-cards/${id}/archive`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "archived from settings console" }),
        });
        if (!r.ok) {
          const b = await r.json().catch(() => ({}));
          throw new Error(
            typeof b?.detail === "string"
              ? b.detail
              : `request failed (${r.status})`,
          );
        }
        await mutate();
      } catch (err) {
        setFormError(
          err instanceof Error ? err.message : "failed to archive",
        );
      } finally {
        setArchivingId(null);
      }
    },
    [mutate],
  );

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1200px] flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/settings"
          className="inline-flex items-center gap-2 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          <ArrowLeft size={14} weight="duotone" />
          settings
        </Link>
        <a
          className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-fg)] hover:bg-[var(--color-surface-2)]"
          href="/api/model-cards?include_archived=true"
        >
          <DownloadSimple size={14} weight="duotone" />
          export json
        </a>
      </div>

      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Brain size={20} weight="duotone" />
          <h1 className="text-xl font-semibold tracking-tight">
            AI transparency register
          </h1>
        </div>
        <p className="max-w-3xl text-sm text-[var(--color-muted)]">
          Per-workspace record of every AI model in service for this
          tenant. Captures intended use, training data summary and
          sensitivity, evaluation results, limitations, PHI suitability,
          fairness assessment status, and last validation date.
          Procurement evidence for EU AI Act Article 13, NIST AI RMF, and
          ISO/IEC 42001. The in-force card for a given name and version
          is exposed at /v1/model-cards/active.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card>
          <div className="flex flex-col gap-1 p-4">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
              active cards
            </span>
            <span className="text-2xl font-semibold tabular-nums">
              {data ? data.active_count : "."}
            </span>
          </div>
        </Card>
        <Card>
          <div className="flex flex-col gap-1 p-4">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
              phi suitable
            </span>
            <span className="text-2xl font-semibold tabular-nums">
              {data ? phiCount : "."}
            </span>
          </div>
        </Card>
        <Card>
          <div className="flex flex-col gap-1 p-4">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
              unvalidated active
            </span>
            <span
              className={
                "text-2xl font-semibold tabular-nums" +
                (unvalidatedCount > 0 ? " text-amber-500" : "")
              }
            >
              {data ? unvalidatedCount : "."}
            </span>
          </div>
        </Card>
        <Card>
          <div className="flex flex-col gap-1 p-4">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
              archived
            </span>
            <span className="text-2xl font-semibold tabular-nums">
              {data ? data.archived_count : "."}
            </span>
          </div>
        </Card>
      </section>

      <Card>
        <CardHeader
          title="Register a model card"
          hint="Recording a card for an existing (model_name, model_version) supersedes the prior active row. Mutations require admin and an active MFA challenge."
        />
        <form
          onSubmit={onCreate}
          className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          <Field label="model_name">
            <Input
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder="adherence-rf"
              required
            />
          </Field>
          <Field label="model_version">
            <Input
              value={modelVersion}
              onChange={(e) => setModelVersion(e.target.value)}
              placeholder="1.0.0"
              required
            />
          </Field>
          <Field label="owner">
            <Input
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="ml-platform@acme"
              required
            />
          </Field>
          <Field label="training data sensitivity">
            <Select
              value={sensitivity}
              onChange={(e) =>
                setSensitivity(e.target.value as Sensitivity)
              }
            >
              <option value="none">none</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="phi">phi</option>
            </Select>
          </Field>
          <Field label="fairness status">
            <Select
              value={fairness}
              onChange={(e) => setFairness(e.target.value as Fairness)}
            >
              <option value="not_assessed">not_assessed</option>
              <option value="in_progress">in_progress</option>
              <option value="assessed">assessed</option>
              <option value="remediation">remediation</option>
            </Select>
          </Field>
          <Field label="phi suitable">
            <label className="inline-flex items-center gap-2 text-xs text-[var(--color-fg)]">
              <input
                type="checkbox"
                checked={phiSuitable}
                onChange={(e) => setPhiSuitable(e.target.checked)}
                className="size-3.5 accent-[var(--color-accent)]"
              />
              cleared for protected health information
            </label>
          </Field>
          <Field label="last_validated_at (ISO 8601)">
            <Input
              value={lastValidated}
              onChange={(e) => setLastValidated(e.target.value)}
              placeholder="2026-04-01T00:00:00Z"
            />
          </Field>
          <Field label="model card url">
            <Input
              value={cardUrl}
              onChange={(e) => setCardUrl(e.target.value)}
              placeholder="https://docs.example/cards/adherence-rf-1.0.0"
            />
          </Field>
          <Field label="supersede reason (optional)">
            <Input
              value={supersede}
              onChange={(e) => setSupersede(e.target.value)}
              placeholder="retrain, scope change, fairness fix, ..."
            />
          </Field>
          <div className="sm:col-span-2 lg:col-span-3">
            <Field label="intended use">
              <textarea
                value={intendedUse}
                onChange={(e) => setIntendedUse(e.target.value)}
                rows={2}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono text-[var(--color-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                placeholder="Predict 30 day medication adherence risk for adult outpatients."
              />
            </Field>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <Field label="training data summary">
              <textarea
                value={trainingSummary}
                onChange={(e) => setTrainingSummary(e.target.value)}
                rows={2}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono text-[var(--color-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                placeholder="De-identified pharmacy claims 2018 to 2023, IRB approved, no free text PHI."
              />
            </Field>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <Field label="evaluation summary">
              <textarea
                value={evalSummary}
                onChange={(e) => setEvalSummary(e.target.value)}
                rows={2}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono text-[var(--color-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                placeholder="AUROC 0.84 on held out 2024 cohort, calibration ECE 0.03."
              />
            </Field>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <Field label="limitations">
              <textarea
                value={limitations}
                onChange={(e) => setLimitations(e.target.value)}
                rows={2}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono text-[var(--color-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                placeholder="Trained on US adults, not validated for pediatric or non US populations."
              />
            </Field>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <Field label="notes">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono text-[var(--color-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              />
            </Field>
          </div>
          {formError ? (
            <div className="sm:col-span-2 lg:col-span-3">
              <ErrorBox message={formError} />
            </div>
          ) : null}
          <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-3">
            <Button type="submit" disabled={submitting}>
              <Plus size={14} weight="duotone" />
              {submitting ? "recording ..." : "record model card"}
            </Button>
            <span className="text-[11px] text-[var(--color-muted)]">
              Writes an immutable admin audit row with actor, IP, and
              request id.
            </span>
          </div>
        </form>
      </Card>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-tight">
            Registered model cards
          </h2>
          <label className="inline-flex items-center gap-2 text-xs text-[var(--color-muted)]">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              className="size-3.5 accent-[var(--color-accent)]"
            />
            include archived
          </label>
        </div>

        {error ? (
          <ErrorBox message={(error as Error).message} />
        ) : isLoading || !data ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : data.entries.length === 0 ? (
          <Empty
            title="No model cards registered"
            hint="Record the first one above. Each card is the procurement record for a deployed (model_name, model_version)."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
            <table className="min-w-full divide-y divide-[var(--color-border)] text-xs">
              <thead className="bg-[var(--color-surface-2)] text-left font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                <tr>
                  <th className="px-3 py-2">model</th>
                  <th className="px-3 py-2">owner</th>
                  <th className="px-3 py-2">sensitivity</th>
                  <th className="px-3 py-2">phi</th>
                  <th className="px-3 py-2">fairness</th>
                  <th className="px-3 py-2">last validated</th>
                  <th className="px-3 py-2">status</th>
                  <th className="px-3 py-2">v</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {data.entries.map((c) => (
                  <tr key={c.id} className="align-top">
                    <td className="px-3 py-2 font-mono">
                      <div className="font-semibold">
                        {c.model_name}{" "}
                        <span className="text-[var(--color-muted)]">
                          @ {c.model_version}
                        </span>
                      </div>
                      <div className="text-[10px] text-[var(--color-muted)]">
                        id {c.id} . by {c.created_by} . {fmtTime(c.created_at)}
                      </div>
                      {c.model_card_url ? (
                        <a
                          href={c.model_card_url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-block text-[10px] text-[var(--color-accent)] hover:underline"
                        >
                          card document
                        </a>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 font-mono">{c.owner}</td>
                    <td className="px-3 py-2">
                      <Badge tone={sensitivityTone(c.training_data_sensitivity)}>
                        {c.training_data_sensitivity}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      {c.phi_suitable ? (
                        <Badge tone="warn">phi ok</Badge>
                      ) : (
                        <span className="text-[10px] text-[var(--color-muted)]">
                          no
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={fairnessTone(c.fairness_status)}>
                        {c.fairness_status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 font-mono tabular-nums">
                      {c.last_validated_at ? (
                        fmtTime(c.last_validated_at)
                      ) : (
                        <span className="text-amber-500">never</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={c.active ? "success" : "neutral"}>
                        {c.status}
                      </Badge>
                      {c.superseded_by_id ? (
                        <div className="mt-1 text-[10px] text-[var(--color-muted)]">
                          superseded by id {c.superseded_by_id}
                        </div>
                      ) : null}
                      {c.archive_reason ? (
                        <div className="mt-1 text-[10px] text-[var(--color-muted)]">
                          {c.archive_reason}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 font-mono tabular-nums">
                      {c.version}
                    </td>
                    <td className="px-3 py-2">
                      {c.active ? (
                        <button
                          type="button"
                          onClick={() => onArchive(c.id)}
                          disabled={archivingId === c.id}
                          className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
                          aria-label={`archive model card ${c.id}`}
                        >
                          <Archive size={12} weight="duotone" />
                          {archivingId === c.id ? "archiving" : "archive"}
                        </button>
                      ) : (
                        <span className="text-[10px] text-[var(--color-muted)]">
                          {c.archived_at ? fmtTime(c.archived_at) : ""}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
