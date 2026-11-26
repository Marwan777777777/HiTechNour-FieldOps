import { Button } from "@/components/ui/button";
import { type Locale, t } from "@/lib/i18n";
import { LogIn, LogOut, Loader2 } from "lucide-react";
import type { PunchPlan } from "@/lib/punch-plan";

export function PrimaryPunchControl({
  locale,
  isCheckedIn,
  isPending,
  disabled,
  mode,
  onPunch,
}: {
  locale: Locale;
  isCheckedIn: boolean;
  isPending: boolean;
  disabled: boolean;
  mode: PunchPlan["mode"];
  onPunch: () => void;
}) {
  const isPendingMode = mode === "pending";
  const Icon = isCheckedIn ? LogOut : LogIn;

  // Visual button styling based on state
  let buttonVariant = "bg-primary text-primary-foreground hover:bg-primary/90";
  if (isPendingMode) {
    buttonVariant = "bg-amber-600 text-white hover:bg-amber-700 active:bg-amber-800";
  } else if (isCheckedIn) {
    buttonVariant = "bg-rose-600 text-white hover:bg-rose-700 active:bg-rose-800";
  }

  const label = isPending ? (
    <span className="flex items-center gap-2">
      <Loader2 className="size-5 animate-spin" />
      <span>…</span>
    </span>
  ) : mode === "waiting" ? (
    <span>{t(locale, "punchWaitingBtn")}</span>
  ) : isPendingMode ? (
    <span className="flex items-center gap-2">
      <Icon className="size-5" />
      <span>{t(locale, isCheckedIn ? "punchSendOutBtn" : "punchSendInBtn")}</span>
    </span>
  ) : isCheckedIn ? (
    <span className="flex items-center gap-2">
      <Icon className="size-5" />
      <span>{t(locale, "checkOut")}</span>
    </span>
  ) : (
    <span className="flex items-center gap-2">
      <Icon className="size-5" />
      <span>{t(locale, "checkIn")}</span>
    </span>
  );

  return (
    <div className="w-full">
      <Button
        disabled={disabled || isPending}
        onClick={onPunch}
        className={`h-16 w-full rounded-2xl text-base font-bold shadow-md transition-all active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100 ${buttonVariant}`}
      >
        {label}
      </Button>
    </div>
  );
}
