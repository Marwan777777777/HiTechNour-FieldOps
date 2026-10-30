import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import type { ButtonHTMLAttributes } from "react";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 font-medium transition-[transform,opacity,background-color] duration-(--motion-quick) ease-(--ease-out) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40 active:scale-[0.98]",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:opacity-90",
        outline: "border border-line bg-transparent text-fg hover:bg-line/40",
        ghost: "text-muted hover:text-fg hover:bg-line/20",
        danger: "bg-bad/15 text-bad hover:bg-bad/25",
        success: "bg-ok/15 text-ok hover:bg-ok/25",
      },
      size: {
        sm: "min-h-8 rounded-md px-2.5 text-xs",
        md: "min-h-11 rounded-lg px-4 text-sm",
        lg: "min-h-14 rounded-xl px-6 text-base font-semibold",
        icon: "size-9 rounded-lg p-0",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

