import { CheckCircle2, AlertTriangle, AlertCircle, MapPinOff } from "lucide-react";
import { type Locale, t } from "@/lib/i18n";
import { type GpsAdvisoryState, evaluateGpsAdvisory } from "@/lib/geo-advisory";

export { type GpsAdvisoryState, evaluateGpsAdvisory };

export function LocationStatusCard({
  locale,
  state,
  accuracy,
  distanceToBoundary,
  distanceFromCenter,
}: {
  locale: Locale;
  state: GpsAdvisoryState;
  accuracy: number | null;
  distanceToBoundary: number | null;
  distanceFromCenter: number | null;
}) {
  const roundAcc = accuracy != null ? Math.round(accuracy) : null;

  if (state === "permission_denied") {
    return (
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3.5 text-start">
        <div className="flex items-center gap-2 text-rose-500">
          <MapPinOff className="size-4 shrink-0" />
          <span className="text-sm font-semibold">{t(locale, "locDenied")}</span>
        </div>
      </div>
    );
  }

  if (state === "locating") {
    return (
      <div className="rounded-xl border border-line bg-surface p-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="size-2 animate-ping rounded-full bg-amber-500" />
            <span className="text-xs font-semibold text-muted">{t(locale, "locating")}</span>
          </div>
          <span className="font-mono text-xs text-faint">GPS</span>
        </div>
        <p className="mt-1 text-xs text-muted">{t(locale, "locTimedOut")}</p>
      </div>
    );
  }

  if (state === "ready") {
    return (
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-4 shrink-0" />
            <span className="text-sm font-bold">{t(locale, "locStatusReady")}</span>
          </div>
          <span className="font-mono text-xs font-semibold text-emerald-700 dark:text-emerald-300">
            ±{roundAcc}m
          </span>
        </div>
        <p className="mt-1.5 text-xs text-muted">
          {distanceFromCenter != null ? `${distanceFromCenter} ${t(locale, "locDistanceInside")}` : ""}
        </p>
      </div>
    );
  }

  if (state === "indoor_review") {
    return (
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0" />
            <span className="text-sm font-bold">{t(locale, "locStatusIndoorReview")}</span>
          </div>
          <span className="font-mono text-xs font-semibold text-amber-700 dark:text-amber-300">
            ±{roundAcc}m
          </span>
        </div>
        <p className="mt-1.5 text-xs text-muted">
          {t(locale, "locIndoorReviewNotice").replace("{acc}", String(roundAcc ?? 0))}
        </p>
      </div>
    );
  }

  if (state === "insufficient_accuracy") {
    return (
      <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400">
            <AlertCircle className="size-4 shrink-0" />
            <span className="text-sm font-bold">{t(locale, "locStatusInsufficient")}</span>
          </div>
          <span className="font-mono text-xs font-semibold text-rose-600 dark:text-rose-400">
            ±{roundAcc}m
          </span>
        </div>
        <p className="mt-1.5 text-xs text-muted">
          {t(locale, "locStepOutdoors").replace("{acc}", String(roundAcc ?? 0))}
        </p>
      </div>
    );
  }

  // Outside state
  const dist = distanceToBoundary != null ? Math.max(1, distanceToBoundary) : 0;
  return (
    <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400">
          <AlertCircle className="size-4 shrink-0" />
          <span className="text-sm font-bold">{t(locale, "locStatusOutside")}</span>
        </div>
        {roundAcc != null ? (
          <span className="font-mono text-xs text-muted">±{roundAcc}m</span>
        ) : null}
      </div>
      <p className="mt-1.5 text-xs text-muted">
        {t(locale, "locMoveCloser").replace("{dist}", String(dist))}
      </p>
    </div>
  );
}
