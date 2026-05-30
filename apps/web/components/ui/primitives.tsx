import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between border-b border-[var(--color-border)] px-6 py-5">
      <div className="min-w-0">
        {eyebrow ? (
          <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--color-accent)] mb-1">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="text-[18px] font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="text-[13px] text-[var(--color-muted)] mt-1 max-w-2xl leading-relaxed">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
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
        "rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]",
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
    <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[var(--color-border)]">
      <div className="min-w-0">
        <div className="text-[12px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
          {title}
        </div>
        {hint ? (
          <div className="text-xs text-[var(--color-muted)]/80 mt-0.5">{hint}</div>
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
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-[var(--color-muted)]">
        {label}
      </div>
      <div className="mt-1 text-xl font-mono font-medium tabular-nums">{value}</div>
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
    <div className="rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-4 py-3 text-sm">
      <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-danger)]">
        request failed
      </div>
      <div className="text-[var(--color-fg)]/85 mt-1 break-words text-[13px]">{message}</div>
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
  mono = true,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "success" | "warn" | "danger" | "accent";
  mono?: boolean;
}) {
  const map: Record<string, string> = {
    neutral: "bg-[var(--color-border)]/60 text-[var(--color-fg)]/85 border-[var(--color-border-strong)]",
    success: "bg-[var(--color-success)]/12 text-[var(--color-success)] border-[var(--color-success)]/30",
    warn: "bg-[var(--color-warn)]/12 text-[var(--color-warn)] border-[var(--color-warn)]/30",
    danger: "bg-[var(--color-danger)]/12 text-[var(--color-danger)] border-[var(--color-danger)]/30",
    accent: "bg-[var(--color-accent)]/12 text-[var(--color-accent)] border-[var(--color-accent)]/30",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-[1px] text-[10px] uppercase tracking-[0.12em] tabular-nums",
        mono && "font-mono",
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
  variant?: "primary" | "ghost" | "danger" | "accent";
}) {
  const map = {
    primary:
      "bg-[var(--color-fg)] text-[var(--color-bg)] hover:bg-white",
    accent:
      "bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent)]/90 shadow-[0_0_0_1px_rgba(59,130,246,0.4)]",
    ghost:
      "border border-[var(--color-border-strong)] text-[var(--color-fg)] hover:bg-[var(--color-border)]/40 hover:border-[var(--color-accent)]/40",
    danger:
      "border border-[var(--color-danger)]/40 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10",
  };
  return (
    <button
      {...rest}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
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
        "w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] font-mono outline-none placeholder:text-[var(--color-subtle)] focus:border-[var(--color-accent)]/70 focus:shadow-[0_0_0_3px_var(--color-accent-soft)] transition-shadow",
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
        "rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] font-mono outline-none focus:border-[var(--color-accent)]/70 focus:shadow-[0_0_0_3px_var(--color-accent-soft)] transition-shadow",
        className,
      )}
    />
  );
}

/* New observability-flavored bits */

export function MonoChip({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-1.5 py-[1px] text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--color-muted)] tabular-nums",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function RiskDot({ tier }: { tier: "low" | "mid" | "high" }) {
  const color =
    tier === "high"
      ? "var(--color-high)"
      : tier === "mid"
        ? "var(--color-mid)"
        : "var(--color-low)";
  return (
    <span
      className="inline-block h-2 w-2 rounded-full"
      style={{ background: color, boxShadow: `0 0 6px ${color}` }}
    />
  );
}

export function LiveDot({ active = true }: { active?: boolean }) {
  return (
    <span
      className={cn(
        "inline-block h-1.5 w-1.5 rounded-full",
        active
          ? "bg-[var(--color-low)] shadow-[0_0_6px_var(--color-low)] animate-pulse"
          : "bg-[var(--color-subtle)]",
      )}
    />
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-[var(--color-muted)]">
      {children}
    </div>
  );
}
