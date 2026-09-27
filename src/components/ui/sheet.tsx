import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A modal that renders as a bottom sheet on small screens (thumb-reachable,
 * swipe-to-dismiss friendly) and as a centered dialog on larger screens.
 * Use this instead of stacking forms below long lists — it keeps the
 * create/edit action visible without requiring a scroll past existing rows.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out" />
        <Dialog.Content
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 max-h-[88dvh] overflow-y-auto rounded-t-2xl border-t border-line bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl",
            "sm:inset-x-auto sm:inset-y-0 sm:start-auto sm:end-0 sm:h-dvh sm:max-h-dvh sm:w-full sm:max-w-md sm:rounded-t-none sm:rounded-s-2xl sm:border-s sm:border-t-0",
            className,
          )}
        >
          <div className="mx-auto mb-3 h-1 w-10 shrink-0 rounded-full bg-line sm:hidden" aria-hidden />
          <div className="flex items-center justify-between gap-3">
            <Dialog.Title className="font-display text-lg font-semibold">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:text-fg"
              >
                <X className="size-4" />
              </button>
            </Dialog.Close>
          </div>
          <div className="mt-4 grid gap-3">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
