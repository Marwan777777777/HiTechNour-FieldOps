import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function BrandMark({
  className,
  lockup = false,
  alt = "HiTechNour Technologies",
}: {
  className?: string;
  lockup?: boolean;
  alt?: string;
}) {
  return (
    <img
      src={lockup ? "/logo-htn.png" : "/logo-mark.png"}
      alt={alt}
      className={cn("brand-mark", lockup && "brand-mark-lockup", className)}
    />
  );
}

export function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-line bg-surface p-4", className)}>
      {children}
    </section>
  );
}

export function Kicker({ children }: { children: ReactNode }) {
  return (
    <p className="mb-2 text-xs font-medium uppercase tracking-widest text-muted">{children}</p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-faint">{children}</p>;
}

export function Stat({
  label,
  value,
  warn,
}: {
  label: string;
  value: string | number;
  warn?: boolean;
}) {
  return (
    <div className="rounded-lg border border-line bg-elevated px-3 py-3">
      <p className="text-xs uppercase tracking-widest text-muted">{label}</p>
      <p className={cn("mt-1 font-mono text-xl font-medium", warn ? "text-warn" : "text-fg")}>
        {value}
      </p>
    </div>
  );
}

export function FlagChip({ reason }: { reason: string | null }) {
  if (!reason) return null;
  return (
    <span className="rounded-full bg-warn/15 px-2 py-0.5 font-mono text-xs text-warn">{reason}</span>
  );
}

export function StatusDot({ on }: { on: boolean }) {
  return (
    <span
      className={cn("inline-block size-2 rounded-full", on ? "bg-ok" : "bg-faint")}
      aria-hidden
    />
  );
}
