import { cn } from "@/lib/utils";

export function HoursHeat({
  days,
}: {
  days: { day: number; hours: number }[];
}) {
  const max = Math.max(1, ...days.map((d) => d.hours));
  return (
    <div className="grid grid-cols-7 gap-1">
      {days.map((d) => {
        const t = d.hours / max;
        return (
          <div
            key={d.day}
            title={`${d.day}: ${d.hours}h`}
            className={cn(
              "flex aspect-square items-center justify-center rounded-sm font-mono text-[10px]",
              d.hours <= 0 ? "bg-elevated text-faint" : "text-fg",
            )}
            style={
              d.hours > 0
                ? { background: `color-mix(in oklab, var(--color-ok) ${Math.round(20 + t * 70)}%, var(--color-elevated))` }
                : undefined
            }
          >
            {d.day}
          </div>
        );
      })}
    </div>
  );
}
