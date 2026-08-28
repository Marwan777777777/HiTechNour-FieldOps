import { cn } from "@/lib/utils";
import type { InputHTMLAttributes, LabelHTMLAttributes, TextareaHTMLAttributes } from "react";

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("block text-xs font-medium text-muted", className)} {...props} />;
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      suppressHydrationWarning
      className={cn(
        "mt-1.5 h-11 w-full rounded-lg border border-line bg-elevated px-3 text-sm text-fg outline-none transition-colors duration-150 placeholder:text-faint focus:border-line-strong",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      suppressHydrationWarning
      className={cn(
        "mt-1.5 w-full rounded-lg border border-line bg-elevated px-3 py-2 text-sm text-fg outline-none placeholder:text-faint focus:border-line-strong",
        className,
      )}
      {...props}
    />
  );
}
