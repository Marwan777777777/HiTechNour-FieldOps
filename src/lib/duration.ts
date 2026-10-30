export function formatDurationMinutes(totalMinutes: number): string {
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return "00h 00m";
  const minsInt = Math.floor(totalMinutes);
  const hrs = Math.floor(minsInt / 60);
  const mins = minsInt % 60;
  return `${String(hrs).padStart(2, "0")}h ${String(mins).padStart(2, "0")}m`;
}

export function formatHoursAndMinutes(hoursDecimal: number): string {
  if (!Number.isFinite(hoursDecimal) || hoursDecimal <= 0) return "00h 00m";
  return formatDurationMinutes(Math.round(hoursDecimal * 60));
}
