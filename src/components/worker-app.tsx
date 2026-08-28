import { Calendar, Clock, FileText, Home, MapPin, Shield, User } from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Radar } from "@/components/radar";
import { Button } from "@/components/ui/button";
import { Empty, FlagChip, Kicker, Panel } from "@/components/chrome";
import { Skeleton } from "@/components/ui/skeleton";
import { haversineMeters } from "@/lib/geo";
import { type Locale, type Msg, t } from "@/lib/i18n";
import { enqueuePunch, flushQueue, queuedCount } from "@/lib/offline-queue";
import {
  checkInOut,
  loadAssignments,
  loadHistory,
  loadNotifications,
  loadReports,
  markNotificationsRead,
  submitReport,
  updateProfile,
  type HomeData,
  type TimelineEvent,
} from "@/lib/server/field";
import { answerSurvey, loadAnnouncements, loadSurveys } from "@/lib/server/comms";
import { HoursHeat } from "./hours-heat";
import { OpsMap } from "./ops-map";
import { clientEventId, deviceId } from "@/lib/utils";

type Tab = "home" | "history" | "jobs" | "reports" | "me";

function errorCopy(locale: Locale, msg: string) {
  if (msg === "DEVICE_PENDING") return t(locale, "pendingDevice");
  if (msg === "ACCOUNT_PENDING") return t(locale, "accountPending");
  if (msg === "ALREADY_CHECKED_IN") return t(locale, "alreadyIn");
  if (msg === "NOT_CHECKED_IN") return t(locale, "notIn");
  if (msg === "RATE_LIMITED") return t(locale, "slowDown");
  return msg;
}

function HomeFeed({ locale }: { locale: Locale }) {
  const news = useQuery({ queryKey: ["htn-announcements-me"], queryFn: () => loadAnnouncements() });
  const latest = news.data?.rows[0];
  return (
    <>
      {latest ? (
        <Panel>
          <Kicker>{t(locale, "announcements")}</Kicker>
          <p className="font-display text-base font-semibold">{latest.title}</p>
          <p className="mt-1 text-sm text-muted">{latest.body}</p>
        </Panel>
      ) : null}
      <SurveyList locale={locale} compact />
    </>
  );
}

function SurveyList({ locale, compact }: { locale: Locale; compact?: boolean }) {
  const q = useQuery({ queryKey: ["htn-surveys"], queryFn: () => loadSurveys() });
  const [draft, setDraft] = useState<Record<number, string>>({});
  const send = useMutation({
    mutationFn: (id: number) => answerSurvey({ data: { surveyId: id, answer: draft[id] ?? "" } }),
    onSuccess: () => {
      toast.success(t(locale, "saved"));
      void q.refetch();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  const open = (q.data?.rows ?? []).filter((s) => !s.answered);
  if (q.isLoading) return compact ? null : <Skeleton className="h-24" />;
  if (!open.length) return compact ? null : <Empty>{t(locale, "noOpenSurveys")}</Empty>;
  return (
    <div className="grid gap-2">
      {open.map((s) => (
        <Panel key={s.id}>
          <Kicker>{t(locale, "surveys")}</Kicker>
          <p className="text-sm font-medium">{s.title}</p>
          <p className="mt-1 text-sm text-muted">{s.body}</p>
          <textarea
            className="mt-2 min-h-20 w-full rounded-lg border border-line bg-elevated px-3 py-2 text-sm"
            placeholder={t(locale, "surveyAnswer")}
            value={draft[s.id] ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, [s.id]: e.target.value }))}
          />
          <Button className="mt-2 w-full" disabled={send.isPending} onClick={() => send.mutate(s.id)}>
            {t(locale, "submitAnswer")}
          </Button>
        </Panel>
      ))}
    </div>
  );
}

export function WorkerApp({
  home,
  locale,
  onHome,
  embedded = false,
}: {
  home: HomeData;
  locale: Locale;
  onHome: (next: HomeData) => void;
  embedded?: boolean;
}) {
  const [tab, setTab] = useState<Tab>("home");
  const tabs: { id: Tab; label: Msg; icon: typeof Home }[] = [
    { id: "home", label: "home", icon: Home },
    { id: "history", label: "history", icon: Clock },
    { id: "jobs", label: "jobs", icon: Calendar },
    { id: "reports", label: "reports", icon: FileText },
    { id: "me", label: "profile", icon: User },
  ];

  return (
    <div className={`mx-auto flex max-w-lg flex-col ${embedded ? "" : "min-h-dvh"}`}>
      <main className={`flex-1 overflow-auto px-4 pt-4 ${embedded ? "pb-4" : "pb-24"}`}>
        {tab === "home" ? <HomeTab home={home} locale={locale} onHome={onHome} /> : null}
        {tab === "history" ? <HistoryTab locale={locale} /> : null}
        {tab === "jobs" ? <JobsTab locale={locale} /> : null}
        {tab === "reports" ? <ReportsTab home={home} locale={locale} /> : null}
        {tab === "me" ? <MeTab home={home} locale={locale} onHome={onHome} /> : null}
      </main>
      <nav className={`${embedded ? "relative" : "fixed inset-x-0 bottom-0 z-20"} border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur`}>
        <ul className="mx-auto grid max-w-lg grid-cols-5">
          {tabs.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={`flex min-h-14 w-full flex-col items-center justify-center gap-0.5 text-xs ${
                    active ? "text-fg" : "text-faint"
                  }`}
                >
                  <Icon className="size-4" />
                  {t(locale, item.label)}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

function HomeTab({
  home,
  locale,
  onHome,
}: {
  home: HomeData;
  locale: Locale;
  onHome: (next: HomeData) => void;
}) {
  const qc = useQueryClient();
  const [pos, setPos] = useState<{ lat: number; lng: number; accuracy: number; mock: boolean } | null>(null);
  const [locErr, setLocErr] = useState(false);
  const [siteId, setSiteId] = useState<number | null>(home.todayAssign[0]?.site_id ?? home.sites[0]?.id ?? null);
  const [offline, setOffline] = useState(typeof navigator !== "undefined" ? queuedCount() : 0);

  useEffect(() => {
    if (!("geolocation" in navigator)) {
      setLocErr(true);
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const coords = p.coords as GeolocationCoordinates & { mock?: boolean };
        setPos({
          lat: coords.latitude,
          lng: coords.longitude,
          accuracy: coords.accuracy,
          mock: Boolean(coords.mock),
        });
        setLocErr(false);
      },
      () => setLocErr(true),
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 12000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  useEffect(() => {
    const flush = () => {
      void flushQueue((item) => checkInOut({ data: item })).then((n) => {
        setOffline(queuedCount());
        if (n) toast.success(t(locale, "synced"));
      });
    };
    window.addEventListener("online", flush);
    flush();
    return () => window.removeEventListener("online", flush);
  }, [locale]);

  const site = home.sites.find((s) => s.id === siteId) ?? home.sites[0];
  const dist = pos && site ? haversineMeters(pos.lat, pos.lng, site.lat, site.lng) : null;
  const inside = dist != null && site ? dist <= site.radius_meters : false;
  const ratio = site && dist != null ? dist / (site.radius_meters * 1.8) : 0.4;

  const punch = useMutation({
    mutationFn: async () => {
      if (!site || !pos) throw new Error(t(locale, "waitingLocation"));
      const payload = {
        siteId: site.id,
        lat: pos.lat,
        lng: pos.lng,
        accuracy: pos.accuracy,
        mock: pos.mock,
        deviceId: deviceId(),
        type: (home.isCheckedIn ? "check_out" : "check_in") as "check_in" | "check_out",
        clientEventId: clientEventId(),
      };
      try {
        return await checkInOut({ data: payload });
      } catch (err) {
        if (typeof navigator !== "undefined" && !navigator.onLine) {
          enqueuePunch(payload);
          setOffline(queuedCount());
          throw new Error("OFFLINE");
        }
        throw err;
      }
    },
    onSuccess: (result) => {
      const event: TimelineEvent = {
        id: result.id,
        type: result.type as TimelineEvent["type"],
        distance_meters: result.distance_meters,
        status: result.status as TimelineEvent["status"],
        flagged: result.flagged,
        flag_reason: result.flag_reason,
        created_at: result.created_at,
        site_name: result.site_name,
        site_id: result.site_id,
      };
      const next: HomeData = {
        ...home,
        isCheckedIn: result.isCheckedIn,
        timeline: result.replayed ? home.timeline : [event, ...home.timeline],
      };
      onHome(next);
      qc.setQueryData(["htn-home"], next);
      toast.success(t(locale, "confirmed"));
      if (result.flag_reason) toast.message(result.flag_reason);
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "Failed";
      if (msg === "OFFLINE") toast.message(t(locale, "offlineQueue"));
      else toast.error(errorCopy(locale, msg));
    },
  });

  if (!home.me.device_approved) {
    return (
      <div className="grid min-h-[70dvh] place-items-center">
        <Panel className="max-w-sm text-center">
          <Shield className="mx-auto size-8 text-warn" />
          <h1 className="mt-3 font-display text-xl font-semibold">{t(locale, "pendingDeviceTitle")}</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">{t(locale, "pendingDeviceBody")}</p>
        </Panel>
      </div>
    );
  }

  const assignment = home.todayAssign[0];

  return (
    <div className="grid gap-4">
      {offline > 0 ? (
        <p className="rounded-lg border border-warn/40 bg-surface px-3 py-2 text-sm text-warn">
          {t(locale, "offlineQueue")} · {offline}
        </p>
      ) : null}

      <HomeFeed locale={locale} />

      <Panel>
        <Kicker>{t(locale, "assignmentToday")}</Kicker>
        {assignment ? (
          <p className="font-display text-lg font-semibold">
            {assignment.site_name}
            {assignment.task ? <span className="block text-sm font-normal text-muted">{assignment.task}</span> : null}
          </p>
        ) : (
          <p className="text-sm text-muted">{t(locale, "noAssignment")}</p>
        )}
      </Panel>

      <Panel className="p-5">
        <Radar ratio={ratio} inside={inside} locating={!pos && !locErr} />
        <div className="mt-4 text-center">
          <p className="font-display text-lg font-semibold">
            {locErr
              ? t(locale, "locDenied")
              : inside
                ? t(locale, "inside")
                : pos
                  ? t(locale, "outside")
                  : t(locale, "locating")}
          </p>
          <p className="mt-1 font-mono text-sm text-muted">
            {dist != null ? `${Math.round(dist)} m` : "—"}
            {pos ? ` · ±${Math.round(pos.accuracy)} m` : ""}
          </p>
        </div>
        {site && pos ? (
          <OpsMap
            className="mt-4 h-44"
            sites={[site]}
            worker={{ lat: pos.lat, lng: pos.lng }}
          />
        ) : null}
      </Panel>

      <label className="block">
        <span className="text-xs font-medium text-muted">{t(locale, "site")}</span>
        <select
          className="mt-1.5 h-11 w-full rounded-lg border border-line bg-elevated px-3 text-sm"
          value={siteId ?? ""}
          onChange={(e) => setSiteId(Number(e.target.value))}
        >
          {home.sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <Button
        className="h-14 w-full rounded-xl text-base"
        disabled={punch.isPending || !pos}
        onClick={() => punch.mutate()}
      >
        {punch.isPending ? "…" : home.isCheckedIn ? t(locale, "checkOut") : t(locale, "checkIn")}
      </Button>

      <section>
        <Kicker>{t(locale, "timeline")}</Kicker>
        {home.timeline.length === 0 ? (
          <Empty>{t(locale, "emptyTimeline")}</Empty>
        ) : (
          <ul className="grid gap-2">
            {home.timeline.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between rounded-xl border border-line bg-surface px-3 py-2.5"
              >
                <div>
                  <p className="text-sm font-medium">
                    {row.type === "check_in" ? t(locale, "checkIn") : t(locale, "checkOut")}
                    <span className="ms-2 text-muted">{row.site_name}</span>
                  </p>
                  <p className="font-mono text-xs text-faint">
                    {new Date(row.created_at).toLocaleTimeString()} · {Math.round(row.distance_meters)} m
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className={`text-xs ${row.status === "inside" ? "text-ok" : "text-warn"}`}>
                    {row.status === "inside" ? t(locale, "inside") : t(locale, "outside")}
                  </span>
                  <FlagChip reason={row.flag_reason} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function HistoryTab({ locale }: { locale: Locale }) {
  const [page, setPage] = useState(0);
  const q = useQuery({
    queryKey: ["htn-history", page],
    queryFn: () => loadHistory({ data: { page } }),
  });
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (!q.data) return <Empty>{t(locale, "loadError")}</Empty>;
  const { monthly, hours, rows, total, pageSize } = q.data;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-line bg-surface px-3 py-3">
          <p className="text-xs uppercase tracking-widest text-muted">{t(locale, "daysPresent")}</p>
          <p className="mt-1 font-mono text-xl">
            {monthly.daysPresent}/{monthly.daysInMonth}
          </p>
        </div>
        <div className="rounded-lg border border-line bg-surface px-3 py-3">
          <p className="text-xs uppercase tracking-widest text-muted">{t(locale, "monthlyHours")}</p>
          <p className="mt-1 font-mono text-xl">{hours.totalHours}h</p>
        </div>
      </div>
      <Panel>
        <Kicker>{t(locale, "hoursHeat")}</Kicker>
        <HoursHeat days={hours.days} />
      </Panel>
      <p className="text-xs text-faint">{t(locale, "flaggedExplain")}</p>
      {rows.length === 0 ? (
        <Empty>{t(locale, "emptyTimeline")}</Empty>
      ) : (
        <ul className="grid gap-2">
          {rows.map((row) => (
            <li key={row.id} className="rounded-xl border border-line bg-surface px-3 py-2.5">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">
                  {row.type === "check_in" ? t(locale, "checkIn") : t(locale, "checkOut")} · {row.site_name}
                </p>
                <FlagChip reason={row.flag_reason} />
              </div>
              <p className="mt-1 font-mono text-xs text-faint">
                {new Date(row.created_at).toLocaleString()} · {Math.round(row.distance_meters)} m · {row.status}
              </p>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 ? (
        <div className="flex justify-between">
          <Button variant="ghost" disabled={page <= 0} onClick={() => setPage((p) => p - 1)}>
            {t(locale, "prev")}
          </Button>
          <span className="font-mono text-xs text-faint">
            {page + 1}/{pages}
          </span>
          <Button variant="ghost" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
            {t(locale, "next")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function JobsTab({ locale }: { locale: Locale }) {
  const q = useQuery({
    queryKey: ["htn-jobs"],
    queryFn: () => loadAssignments(),
  });
  if (q.isLoading) return <Skeleton className="h-40" />;
  const rows = q.data?.rows ?? [];
  const mates = q.data?.teammates ?? [];
  if (!rows.length) return <Empty>{t(locale, "noJobs")}</Empty>;
  return (
    <div className="grid gap-4">
    <ul className="grid gap-2">
      {rows.map((row) => (
        <li key={row.id} className="rounded-xl border border-line bg-surface p-4">
          <p className="flex items-center gap-2 font-display text-base font-semibold">
            <MapPin className="size-4 text-muted" />
            {row.site_name}
          </p>
          {row.task ? <p className="mt-1 text-sm text-muted">{row.task}</p> : null}
          <p className="mt-2 font-mono text-xs text-faint">
            {row.start_date} → {row.end_date}
          </p>
        </li>
      ))}
    </ul>
    <Panel>
      <Kicker>{t(locale, "teammates")}</Kicker>
      {mates.length === 0 ? (
        <p className="text-sm text-muted">{t(locale, "noTeammates")}</p>
      ) : (
        <ul className="grid gap-1 text-sm">
          {mates.map((m) => (
            <li key={`${m.full_name}-${m.site_name}`}>
              {m.full_name} <span className="text-muted">· {m.site_name}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
    </div>
  );
}

function ReportsTab({ home, locale }: { home: HomeData; locale: Locale }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const q = useQuery({ queryKey: ["htn-reports"], queryFn: () => loadReports() });
  const submit = useMutation({
    mutationFn: () =>
      submitReport({ data: { title, body, siteId: home.todayAssign[0]?.site_id ?? home.sites[0]?.id } }),
    onSuccess: () => {
      toast.success(t(locale, "reportSubmitted"));
      setTitle("");
      setBody("");
      void q.refetch();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  return (
    <div className="grid gap-4">
      <SurveyList locale={locale} />
      <Panel>
        <Kicker>{t(locale, "reports")}</Kicker>
        <input
          className="h-11 w-full rounded-lg border border-line bg-elevated px-3 text-sm"
          placeholder={t(locale, "reportTitle")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className="mt-2 min-h-28 w-full rounded-lg border border-line bg-elevated px-3 py-2 text-sm"
          placeholder={t(locale, "reportBody")}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <Button className="mt-3 w-full" disabled={submit.isPending} onClick={() => submit.mutate()}>
          {t(locale, "submitReport")}
        </Button>
      </Panel>
      {q.data?.rows.length ? (
        <ul className="grid gap-2">
          {q.data.rows.map((row) => (
            <li key={row.id} className="rounded-xl border border-line bg-surface p-3">
              <p className="text-sm font-medium">{row.title}</p>
              <p className="mt-1 text-sm text-muted">{row.body}</p>
              <p className="mt-2 font-mono text-xs text-faint">
                {row.status} · {row.site_name ?? "—"} · {new Date(row.created_at).toLocaleString()}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>{t(locale, "noReports")}</Empty>
      )}
    </div>
  );
}

function MeTab({
  home,
  locale,
  onHome,
}: {
  home: HomeData;
  locale: Locale;
  onHome: (next: HomeData) => void;
}) {
  const [name, setName] = useState(home.me.full_name);
  const [phone, setPhone] = useState(home.me.phone ?? "");
  const notes = useQuery({ queryKey: ["htn-notes"], queryFn: () => loadNotifications() });
  const save = useMutation({
    mutationFn: () => updateProfile({ data: { fullName: name, phone, locale } }),
    onSuccess: (next) => {
      onHome(next);
      toast.success(t(locale, "saved"));
    },
  });
  const readAll = useMutation({
    mutationFn: () => markNotificationsRead(),
    onSuccess: () => void notes.refetch(),
  });
  return (
    <div className="grid gap-4">
      <Panel>
        <Kicker>{t(locale, "profile")}</Kicker>
        <label className="block text-xs text-muted">
          {t(locale, "fullName")}
          <input
            className="mt-1 h-11 w-full rounded-lg border border-line bg-elevated px-3 text-sm text-fg"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="mt-3 block text-xs text-muted">
          {t(locale, "phone")}
          <input
            className="mt-1 h-11 w-full rounded-lg border border-line bg-elevated px-3 text-sm text-fg"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </label>
        <p className="mt-3 font-mono text-xs text-faint">
          {home.me.device_approved ? "device bound" : t(locale, "pendingDevice")}
        </p>
        <Button className="mt-3 w-full" disabled={save.isPending} onClick={() => save.mutate()}>
          {t(locale, "save")}
        </Button>
      </Panel>
      <section>
        <div className="mb-2 flex items-center justify-between">
          <Kicker>{t(locale, "alerts")}</Kicker>
          <button type="button" className="text-xs text-muted" onClick={() => readAll.mutate()}>
            {t(locale, "markRead")}
          </button>
        </div>
        {notes.data?.rows.length ? (
          <ul className="grid gap-2">
            {notes.data.rows.map((n) => (
              <li key={n.id} className="rounded-xl border border-line bg-surface px-3 py-2.5">
                <p className="text-sm font-medium">{n.title}</p>
                <p className="text-sm text-muted">{n.body}</p>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{t(locale, "noAlerts")}</Empty>
        )}
      </section>
    </div>
  );
}
