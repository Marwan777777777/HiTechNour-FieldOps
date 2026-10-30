import { ShieldAlert, WifiOff } from "lucide-react";
import { type Locale, t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";

export function DeviceStatusBanner({
  locale,
  deviceId,
}: {
  locale: Locale;
  deviceId: string | null;
}) {
  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-start">
      <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
        <ShieldAlert className="size-5 shrink-0" />
        <h3 className="text-sm font-bold">{t(locale, "pendingDeviceTitle")}</h3>
      </div>
      <p className="mt-1.5 text-xs text-muted leading-relaxed">
        {t(locale, "pendingDeviceBody")}
      </p>
      {deviceId ? (
        <div className="mt-2.5 rounded-lg border border-line bg-elevated/80 p-2 font-mono text-[11px] text-faint truncate">
          ID: {deviceId}
        </div>
      ) : null}
    </div>
  );
}

export function NetworkTimeoutAlert({
  locale,
  isChecking,
  onCheckStatus,
}: {
  locale: Locale;
  isChecking?: boolean;
  onCheckStatus: () => void;
}) {
  return (
    <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-start">
      <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400">
        <WifiOff className="size-5 shrink-0" />
        <h3 className="text-sm font-bold">{t(locale, "networkTimeoutTitle")}</h3>
      </div>
      <p className="mt-1.5 text-xs text-muted leading-relaxed">
        {t(locale, "networkTimeoutBody")}
      </p>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button
          variant="outline"
          disabled={isChecking}
          onClick={onCheckStatus}
          className="h-8 text-xs font-semibold"
        >
          {isChecking ? "…" : t(locale, "checkStatusBtn")}
        </Button>
      </div>
    </div>
  );
}
