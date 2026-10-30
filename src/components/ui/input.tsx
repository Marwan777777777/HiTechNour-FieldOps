import { cn } from "@/lib/utils";
import type { InputHTMLAttributes, LabelHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("block text-xs font-semibold text-muted", className)} {...props} />;
}

export function Input({
  className,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { error?: boolean }) {
  return (
    <input
      suppressHydrationWarning
      className={cn(
        "mt-1.5 h-11 w-full rounded-lg border bg-elevated px-3 text-sm text-fg outline-none transition-all duration-150 placeholder:text-faint",
        error
          ? "border-bad/60 focus:border-bad focus:ring-1 focus:ring-bad/30"
          : "border-line focus:border-line-strong focus:ring-1 focus:ring-accent/20",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({
  className,
  error,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { error?: boolean }) {
  return (
    <textarea
      suppressHydrationWarning
      className={cn(
        "mt-1.5 w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-fg outline-none transition-all duration-150 placeholder:text-faint",
        error
          ? "border-bad/60 focus:border-bad focus:ring-1 focus:ring-bad/30"
          : "border-line focus:border-line-strong focus:ring-1 focus:ring-accent/20",
        className,
      )}
      {...props}
    />
  );
}

export function FormError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <p className="mt-1 text-xs text-bad">{children}</p>;
}

export function FormHint({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <p className="mt-1 text-xs text-muted leading-relaxed">{children}</p>;
}

