import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between border-b border-[var(--color-border)] px-6 py-6">
      <div className="min-w-0">
        <h1 className="text-lg font-medium tracking-tight">{title}</h1>
        {description ? (
          <p className="text-sm text-[var(--color-muted)] mt-1 max-w-xl">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  hint,
  right,
}: {
  title: string;
  hint?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
      <div>
        <div className="text-sm font-medium">{title}</div>
        {hint ? (
          <div className="text-xs text-[var(--color-muted)] mt-0.5">{hint}</div>
        ) : null}
      </div>
      {right}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">
        {label}
      </div>
      <div className="mt-1 text-xl font-medium tabular-nums">{value}</div>
      {sub ? (
        <div className="mt-0.5 text-xs text-[var(--color-muted)] tabular-nums">{sub}</div>
      ) : null}
    </div>
  );
}

export function Empty({
  title,
  hint,
  icon,
}: {
  title: string;
  hint?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-12">
      {icon ? <div className="mb-3 text-[var(--color-muted)]">{icon}</div> : null}
      <div className="text-sm font-medium">{title}</div>
      {hint ? (
        <p className="text-xs text-[var(--color-muted)] mt-1 max-w-sm">{hint}</p>
      ) : null}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-4 py-3 text-sm">
      <div className="font-medium text-[var(--color-danger)]">Request failed</div>
      <div className="text-[var(--color-fg)]/80 mt-1 break-words">{message}</div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-[var(--color-border)]/50",
        className,
      )}
    />
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "success" | "warn" | "danger" | "accent";
}) {
  const map: Record<string, string> = {
    neutral: "bg-[var(--color-border)]/60 text-[var(--color-fg)]/80",
    success: "bg-[var(--color-success)]/15 text-[var(--color-success)]",
    warn: "bg-[var(--color-warn)]/15 text-[var(--color-warn)]",
    danger: "bg-[var(--color-danger)]/15 text-[var(--color-danger)]",
    accent: "bg-[var(--color-accent)]/15 text-[var(--color-accent)]",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider",
        map[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Button({
  variant = "primary",
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
}) {
  const map = {
    primary:
      "bg-[var(--color-fg)] text-[var(--color-bg)] hover:bg-[var(--color-fg)]/90",
    ghost:
      "border border-[var(--color-border-strong)] text-[var(--color-fg)] hover:bg-[var(--color-border)]/40",
    danger:
      "border border-[var(--color-danger)]/40 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10",
  };
  return (
    <button
      {...rest}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
        map[variant],
        className,
      )}
    />
  );
}

export function Input({
  className,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cn(
        "w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm outline-none placeholder:text-[var(--color-subtle)] focus:border-[var(--color-accent)]/60",
        className,
      )}
    />
  );
}

export function Select({
  className,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={cn(
        "rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]/60",
        className,
      )}
    />
  );
}
