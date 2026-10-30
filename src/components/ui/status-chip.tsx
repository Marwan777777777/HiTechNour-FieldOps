import type { ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const statusChipVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        ok: "border border-ok/30 bg-ok/10 text-ok",
        warn: "border border-warn/30 bg-warn/10 text-warn",
        bad: "border border-bad/30 bg-bad/10 text-bad",
        info: "border border-login-cta/30 bg-login-cta/10 text-login-cta",
        neutral: "border border-line bg-elevated text-muted",
      },
      size: {
        sm: "px-2 py-0.2 text-[11px]",
        md: "px-2.5 py-0.5 text-xs",
      },
    },
    defaultVariants: {
      variant: "neutral",
      size: "md",
    },
  },
);

export interface StatusChipProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusChipVariants> {
  dot?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}

export function StatusChip({
  className,
  variant,
  size,
  dot,
  icon,
  children,
  ...props
}: StatusChipProps) {
  const dotColor =
    variant === "ok"
      ? "bg-ok"
      : variant === "warn"
      ? "bg-warn"
      : variant === "bad"
      ? "bg-bad"
      : variant === "info"
      ? "bg-login-cta"
      : "bg-muted";

  return (
    <span
      className={cn(statusChipVariants({ variant, size }), className)}
      {...props}
    >
      {dot ? (
        <span className={cn("size-1.5 shrink-0 rounded-full", dotColor)} aria-hidden />
      ) : null}
      {icon ? <span className="shrink-0">{icon}</span> : null}
      <span>{children}</span>
    </span>
  );
}
