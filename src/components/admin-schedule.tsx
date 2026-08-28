import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Empty, Kicker, Panel } from "@/components/chrome";
import { Skeleton } from "@/components/ui/skeleton";
import { cairoDate } from "@/lib/geo";
import { type Locale, t } from "@/lib/i18n";
import { listSites, listWorkers } from "@/lib/server/admin";
import { deleteAssignment, listSchedule, upsertAssignment, type ScheduleRow } from "@/lib/server/schedule";

export function AdminSchedule({ locale }: { locale: Locale }) {
  const today = cairoDate();
  const [cursor, setCursor] = useState(() => new Date(`${today}T12:00:00`));
  const [selected, setSelected] = useState(today);
  const from = format(startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 }), "yyyy-MM-dd");
  const to = format(endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 }), "yyyy-MM-dd");

  const days = useMemo(() => {
    return eachDayOfInterval({
      start: startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 }),
      end: endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 }),
    });
  }, [cursor]);

  const q = useQuery({
    queryKey: ["htn-schedule", from, to],
    queryFn: () => listSchedule({ data: { from, to } }),
  });
  const workers = useQuery({ queryKey: ["htn-workers", "sched"], queryFn: () => listWorkers({ data: {} }) });
  const sites = useQuery({ queryKey: ["htn-sites"], queryFn: () => listSites() });

  const rows = q.data?.rows ?? [];
  const onDay = rows.filter((r) => r.start_date <= selected && r.end_date >= selected);
  const countByDay = (iso: string) => rows.filter((r) => r.start_date <= iso && r.end_date >= iso).length;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)]">
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h1 className="font-display text-2xl font-semibold">{t(locale, "schedule")}</h1>
          <div className="flex items-center gap-1">
            <Button variant="ghost" onClick={() => setCursor((c) => addMonths(c, -1))} aria-label="prev">
              <ChevronLeft className="size-4" />
            </Button>
            <p className="min-w-36 text-center text-sm font-medium">{format(cursor, "MMMM yyyy")}</p>
            <Button variant="ghost" onClick={() => setCursor((c) => addMonths(c, 1))} aria-label="next">
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center text-xs uppercase tracking-widest text-muted">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <div key={d} className="py-1">
              {d}
            </div>
          ))}
        </div>
        <div className="mt-1 grid grid-cols-7 gap-1">
          {days.map((day) => {
            const iso = format(day, "yyyy-MM-dd");
            const inMonth = isSameMonth(day, cursor);
            const isSel = iso === selected;
            const isToday = isSameDay(day, new Date(`${today}T12:00:00`));
            const n = countByDay(iso);
            return (
              <button
                key={iso}
                type="button"
                onClick={() => setSelected(iso)}
                className={`min-h-16 rounded-lg border px-1 py-1.5 text-start ${
                  isSel ? "border-accent bg-elevated" : "border-line bg-surface"
                } ${inMonth ? "text-fg" : "text-faint"}`}
              >
                <span className={`font-mono text-xs ${isToday ? "text-accent" : ""}`}>{format(day, "d")}</span>
                {n ? <span className="mt-2 block font-mono text-xs text-muted">{n}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid gap-4">
        <AssignForm
          locale={locale}
          date={selected}
          workers={workers.data?.rows ?? []}
          sites={sites.data?.rows ?? []}
          onDone={() => void q.refetch()}
        />
        {q.isLoading ? (
          <Skeleton className="h-40" />
        ) : onDay.length === 0 ? (
          <Empty>{t(locale, "noJobs")}</Empty>
        ) : (
          <ul className="grid gap-2">
            {onDay.map((row) => (
              <DayRow key={row.id} row={row} locale={locale} onDone={() => void q.refetch()} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function DayRow({
  row,
  locale,
  onDone,
}: {
  row: ScheduleRow;
  locale: Locale;
  onDone: () => void;
}) {
  return (
    <li className="flex items-start justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-3">
      <div>
        <p className="text-sm font-medium">{row.full_name}</p>
        <p className="text-sm text-muted">{row.site_name}</p>
        {row.task ? <p className="mt-1 text-sm text-faint">{row.task}</p> : null}
        <p className="mt-1 font-mono text-xs text-faint">
          {row.start_date} → {row.end_date}
        </p>
      </div>
      <Button
        variant="danger"
        onClick={async () => {
          await deleteAssignment({ data: { id: row.id } });
          onDone();
        }}
      >
        {t(locale, "remove")}
      </Button>
    </li>
  );
}

function AssignForm({
  locale,
  date,
  workers,
  sites,
  onDone,
}: {
  locale: Locale;
  date: string;
  workers: { user_id: string; full_name: string; role: string }[];
  sites: { id: number; name: string }[];
  onDone: () => void;
}) {
  const people = workers.filter((w) => w.role === "employee");
  const [userId, setUserId] = useState(people[0]?.user_id ?? "");
  const [siteId, setSiteId] = useState(sites[0]?.id ?? 0);
  const [task, setTask] = useState("");
  const [start, setStart] = useState(date);
  const [end, setEnd] = useState(date);

  useEffect(() => {
    setStart(date);
    setEnd(date);
  }, [date]);
  useEffect(() => {
    if (!userId && people[0]) setUserId(people[0].user_id);
  }, [people, userId]);
  useEffect(() => {
    if (!siteId && sites[0]) setSiteId(sites[0].id);
  }, [sites, siteId]);

  const save = useMutation({
    mutationFn: () =>
      upsertAssignment({
        data: { userId, siteId, task, startDate: start || date, endDate: end || date },
      }),
    onSuccess: () => {
      toast.success(t(locale, "saved"));
      setTask("");
      onDone();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <Panel className="grid gap-2">
      <Kicker>
        {t(locale, "assign")} · {date}
      </Kicker>
      <select
        className="h-11 rounded-lg border border-line bg-elevated px-3 text-sm"
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
      >
        {people.map((w) => (
          <option key={w.user_id} value={w.user_id}>
            {w.full_name}
          </option>
        ))}
      </select>
      <select
        className="h-11 rounded-lg border border-line bg-elevated px-3 text-sm"
        value={siteId}
        onChange={(e) => setSiteId(Number(e.target.value))}
      >
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <input
        className="h-11 rounded-lg border border-line bg-elevated px-3 text-sm"
        placeholder={t(locale, "task")}
        value={task}
        onChange={(e) => setTask(e.target.value)}
      />
      <div className="grid grid-cols-2 gap-2">
        <input
          className="h-11 rounded-lg border border-line bg-elevated px-3 font-mono text-sm"
          type="date"
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
        <input
          className="h-11 rounded-lg border border-line bg-elevated px-3 font-mono text-sm"
          type="date"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
        />
      </div>
      <Button disabled={save.isPending || !userId || !siteId} onClick={() => save.mutate()}>
        {t(locale, "assign")}
      </Button>
    </Panel>
  );
}
