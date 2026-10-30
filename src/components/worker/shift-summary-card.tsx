import { useEffect, useState } from "react";
import { Clock, Info } from "lucide-react";
import { type Locale, t } from "@/lib/i18n";
import type { TimelineEvent } from "@/lib/server/field";

function formatDuration(diffMs: number): string {
  if (diffMs <= 0) return "00:00:00";
  const sec = Math.floor((diffMs / 1000) % 60);
  const min = Math.floor((diffMs / (1000 * 60)) % 60);
  const hrs = Math.floor(diffMs / (1000 * 60 * 60));
  return [hrs, min, sec].map((v) => String(v).padStart(2, "0")).join(":");
}

import { formatDurationMinutes, formatHoursAndMinutes } from "@/lib/duration";
export { formatDurationMinutes, formatHoursAndMinutes };

export function ShiftSummaryCard({
  locale,
  isCheckedIn,
  timeline,
  todayHours,
}: {
  locale: Locale;
  isCheckedIn: boolean;
  timeline: TimelineEvent[];
  todayHours: number;
}) {
  // Find open check-in timestamp
  const latestIn = isCheckedIn
    ? timeline.find((e) => e.type === "check_in")?.created_at
    : null;

  const [elapsed, setElapsed] = useState("00:00:00");

  useEffect(() => {
    if (!latestIn) {
      setElapsed("00:00:00");
      return;
    }
    const update = () => {
      const diff = Date.now() - new Date(latestIn).getTime();
      setElapsed(formatDuration(diff));
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [latestIn]);

  const todayPunches = timeline.slice(0, 4);

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      {/* Elapsed Wall-Clock Timer (Only visible while checked in) */}
      {isCheckedIn && latestIn ? (
        <div className="mb-4 rounded-lg border border-primary/20 bg-primary/5 p-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-primary">
              <Clock className="size-3.5" />
              {t(locale, "elapsedShiftTime")}
            </span>
            <span className="font-mono text-base font-bold tabular-nums text-fg">
              {elapsed}
            </span>
          </div>
          <p className="mt-1.5 flex items-start gap-1 text-[11px] text-muted leading-tight">
            <Info className="mt-0.5 size-3 shrink-0 text-faint" />
            <span>{t(locale, "elapsedTimerDisclaimer")}</span>
          </p>
        </div>
      ) : null}

      {/* Recorded Attendance Intervals */}
      <div>
        <div className="flex items-center justify-between pb-2 border-b border-line/60">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">
            {t(locale, "recordedIntervalsToday")}
          </span>
          <span className="font-mono text-xs font-bold text-fg">
            {formatHoursAndMinutes(todayHours)}
          </span>
        </div>

        {todayPunches.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted">{t(locale, "emptyTimeline")}</p>
        ) : (
          <ul className="mt-2.5 divide-y divide-line/40">
            {todayPunches.map((punch) => {
              const date = new Date(punch.created_at);
              const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
              const isIn = punch.type === "check_in";
              return (
                <li key={punch.id} className="flex items-center justify-between py-2 text-xs first:pt-0 last:pb-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`size-2 rounded-full ${isIn ? "bg-emerald-500" : "bg-rose-500"}`}
                      aria-hidden
                    />
                    <span className="font-medium text-fg">
                      {isIn ? t(locale, "checkIn") : t(locale, "checkOut")}
                    </span>
                    <span className="truncate text-muted max-w-[140px]">{punch.site_name}</span>
                  </div>
                  <div className="text-end">
                    <span className="font-mono text-fg">{timeStr}</span>
                    {punch.status === "inside" ? (
                      <span className="ms-1.5 text-[10px] text-emerald-600 dark:text-emerald-400">✓</span>
                    ) : (
                      <span className="ms-1.5 text-[10px] text-rose-500">!</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
