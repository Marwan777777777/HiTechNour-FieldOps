import {
  CalendarDays,
  ClipboardList,
  Download,
  Flag,
  LayoutDashboard,
  MapPin,
  Megaphone,
  Palmtree,
  ScrollText,
  Sparkles,
  Users,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Empty, FlagChip, Kicker, Panel, Stat, BrandMark } from "@/components/chrome";
import { Skeleton } from "@/components/ui/skeleton";
import { cairoDate } from "@/lib/geo";
import { type Locale, type Msg, t } from "@/lib/i18n";
import {
  activityLog,
  adminOverview,
  adminReports,
  approveDevice,
  exportAttendanceCsv,
  exportPayrollCsv,
  forceLogout,
  listFlagged,
  listSites,
  listSkills,
  listWorkers,
  liveMap,
  resetDevice,
  reviewCheckin,
  reviewReport,
  saveAssignment,
  saveSite,
  setWorkerActive,
  setWorkerSkill,
  workerDetail,
} from "@/lib/server/admin";
import {
  createWorker,
  resetWorkerPassword,
  setSiteSkillNeed,
  setWorkerRole,
  skillCoverage,
  teamRoster,
} from "@/lib/server/people";
import { adminListLeave, reviewLeave } from "@/lib/server/leave";
import type { HomeData } from "@/lib/server/field";
import { AdminBroadcast } from "./admin-broadcast";
import { AdminSchedule } from "./admin-schedule";
import { HoursHeat } from "./hours-heat";
import { OpsMap } from "./ops-map";
import { WorkerApp } from "./worker-app";

type AdminTab =
  | "overview"
  | "queue"
  | "people"
  | "schedule"
  | "sites"
  | "skills"
  | "reports"
  | "leave"
  | "broadcast"
  | "log"
  | "export"
  | "field";

const NAV: { id: AdminTab; label: Msg; icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "overview", icon: LayoutDashboard },
  { id: "queue", label: "queue", icon: Flag },
  { id: "people", label: "people", icon: Users },
  { id: "schedule", label: "schedule", icon: CalendarDays },
  { id: "sites", label: "sites", icon: MapPin },
  { id: "skills", label: "skills", icon: Sparkles },
  { id: "reports", label: "reports", icon: ClipboardList },
  { id: "leave", label: "leave", icon: Palmtree },
  { id: "broadcast", label: "broadcast", icon: Megaphone },
  { id: "log", label: "log", icon: ScrollText },
  { id: "export", label: "export", icon: Download },
  { id: "field", label: "fieldPunch", icon: MapPin },
];

export function AdminApp({
  home,
  locale,
  onHome,
}: {
  home: HomeData;
  locale: Locale;
  onHome: (next: HomeData) => void;
}) {
  const [tab, setTab] = useState<AdminTab>("overview");

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col overflow-y-auto border-e border-line bg-surface md:flex">
        <div className="flex items-center gap-3 px-3 py-4">
          <BrandMark className="h-12 w-auto" />
          <p className="font-display text-sm font-semibold">{t(locale, "adminDesk")}</p>
        </div>
        <nav className="grid gap-0.5 px-2">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm ${
                  active ? "bg-elevated text-fg" : "text-muted hover:text-fg"
                }`}
              >
                <Icon className="size-4" />
                {t(locale, item.label)}
              </button>
            );
          })}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-line md:hidden">
          <select
            className="h-12 w-full bg-bg px-4 text-sm"
            value={tab}
            onChange={(e) => setTab(e.target.value as AdminTab)}
          >
            {NAV.map((item) => (
              <option key={item.id} value={item.id}>
                {t(locale, item.label)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1 overflow-auto p-4 md:p-6">
          {tab === "overview" ? <Overview locale={locale} /> : null}
          {tab === "queue" ? <Queue locale={locale} /> : null}
          {tab === "people" ? <People locale={locale} home={home} /> : null}
          {tab === "schedule" ? <AdminSchedule locale={locale} /> : null}
          {tab === "sites" ? <Sites locale={locale} /> : null}
          {tab === "skills" ? <Skills locale={locale} /> : null}
          {tab === "reports" ? <Reports locale={locale} /> : null}
          {tab === "leave" ? <LeaveDesk locale={locale} /> : null}
          {tab === "broadcast" ? <AdminBroadcast locale={locale} /> : null}
          {tab === "log" ? <Log locale={locale} /> : null}
          {tab === "export" ? <ExportTab locale={locale} /> : null}
          {tab === "field" ? <WorkerApp home={home} locale={locale} onHome={onHome} embedded /> : null}
        </div>
      </div>
    </div>
  );
}

function Overview({ locale }: { locale: Locale }) {
  const q = useQuery({ queryKey: ["htn-overview"], queryFn: () => adminOverview(), refetchInterval: 15_000 });
  const map = useQuery({ queryKey: ["htn-live-map"], queryFn: () => liveMap(), refetchInterval: 20_000 });
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (!q.data) return <Empty>{t(locale, "loadError")}</Empty>;
  const d = q.data;
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="font-display text-2xl font-semibold">{t(locale, "overview")}</h1>
        <p className="mt-1 font-mono text-xs text-muted">{d.today}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label={t(locale, "present")} value={`${d.presentToday}/${d.totalWorkers}`} />
        <Stat label={t(locale, "late")} value={d.lateToday} warn={d.lateToday > 0} />
        <Stat label={t(locale, "absent")} value={d.absentToday} warn={d.absentToday > 0} />
        <Stat label={t(locale, "flaggedQueue")} value={d.flagged} warn={d.flagged > 0} />
        <Stat label={t(locale, "pendingLeave")} value={d.pendingLeave} warn={d.pendingLeave > 0} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <Kicker>{t(locale, "weekly")}</Kicker>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={d.weekly}>
                <XAxis dataKey="date" tickFormatter={(v: string) => v.slice(8)} stroke="var(--color-faint)" fontSize={11} />
                <YAxis allowDecimals={false} stroke="var(--color-faint)" fontSize={11} width={28} />
                <Tooltip
                  contentStyle={{ background: "var(--color-surface)", border: "1px solid var(--color-line)", fontSize: 12 }}
                />
                <Bar dataKey="present" fill="var(--color-ok)" stackId="a" />
                <Bar dataKey="late" fill="var(--color-warn)" stackId="a" />
                <Bar dataKey="absent" fill="var(--color-faint)" stackId="a" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel>
          <Kicker>{t(locale, "onSiteNow")}</Kicker>
          {d.onSite.length === 0 ? (
            <Empty>{t(locale, "emptyTimeline")}</Empty>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {d.onSite.map((row) => (
                  <tr key={row.user_id} className="border-t border-line">
                    <td className="py-2.5 font-medium">{row.full_name}</td>
                    <td className="py-2.5 text-muted">{row.site_name}</td>
                    <td className="py-2.5 text-end font-mono text-xs text-faint">
                      {new Date(row.created_at).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
      <Panel className="p-0 overflow-hidden">
        <div className="px-4 pt-4">
          <Kicker>{t(locale, "liveMap")}</Kicker>
        </div>
        <OpsMap sites={map.data?.sites} people={map.data?.people} className="h-80 rounded-none border-0" />
      </Panel>
      <TeamToday locale={locale} />
    </div>
  );
}

function TeamToday({ locale }: { locale: Locale }) {
  const q = useQuery({ queryKey: ["htn-team"], queryFn: () => teamRoster() });
  if (q.isLoading) return <Skeleton className="h-40" />;
  const groups = q.data?.groups ?? [];
  return (
    <Panel>
      <Kicker>{t(locale, "teamToday")}</Kicker>
      {groups.length === 0 ? (
        <Empty>{t(locale, "noPeople")}</Empty>
      ) : (
        <div className="grid gap-4">
          {groups.map((g) => (
            <section key={g.siteName}>
              <p className="text-sm font-medium">{g.siteName === "Unassigned" ? t(locale, "unassigned") : g.siteName}</p>
              <ul className="mt-1 grid gap-1">
                {g.members.map((m) => (
                  <li key={m.user_id} className="flex items-center justify-between border-t border-line py-2 text-sm">
                    <span>
                      {m.full_name}
                      {m.title ? <span className="text-muted"> · {m.title}</span> : null}
                    </span>
                    <span className="font-mono text-xs text-faint">{m.attendancePct}%</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}

function Queue({ locale }: { locale: Locale }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["htn-queue"], queryFn: () => listFlagged() });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["htn-queue"] });
  if (q.isLoading) return <Skeleton className="h-64" />;
  const pending = q.data?.pendingPeople ?? [];
  const flagged = q.data?.flagged ?? [];
  return (
    <div className="grid gap-6">
      <h1 className="font-display text-2xl font-semibold">{t(locale, "flaggedQueue")}</h1>
      {pending.length ? (
        <section>
          <Kicker>{t(locale, "pendingApprovals")}</Kicker>
          <ul className="grid gap-2">
            {pending.map((p) => (
              <li key={p.user_id} className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3">
                <div>
                  <p className="text-sm font-medium">{p.full_name || p.email}</p>
                  <p className="font-mono text-xs text-faint">
                    {p.active ? "" : "account · "}
                    {p.device_approved ? "" : "device"}
                  </p>
                </div>
                <Button
                  onClick={async () => {
                    await approveDevice({ data: { userId: p.user_id } });
                    refresh();
                  }}
                >
                  {t(locale, "approveDevice")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {flagged.length === 0 ? (
        <Empty>{t(locale, "noFlags")}</Empty>
      ) : (
        <ul className="grid gap-2">
          {flagged.map((row) => (
            <li key={row.id} className="rounded-xl border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{row.full_name}</p>
                  <p className="font-mono text-xs text-muted">
                    {row.site_name} · {row.type} · {Math.round(row.distance_meters)} m
                  </p>
                  <div className="mt-2">
                    <FlagChip reason={row.flag_reason} />
                  </div>
                </div>
                <Button
                  variant="outline"
                  onClick={async () => {
                    await reviewCheckin({ data: { id: row.id } });
                    refresh();
                  }}
                >
                  {t(locale, "review")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function People({ locale, home }: { locale: Locale; home: HomeData }) {
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["htn-workers", q],
    queryFn: () => listWorkers({ data: { q, includeInactive: true } }),
  });
  const detail = useQuery({
    queryKey: ["htn-worker", selected],
    queryFn: () => workerDetail({ data: { userId: selected! } }),
    enabled: Boolean(selected),
  });
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["htn-workers"] });
    void qc.invalidateQueries({ queryKey: ["htn-worker"] });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h1 className="font-display text-2xl font-semibold">{t(locale, "people")}</h1>
        </div>
        <CreatePerson locale={locale} onDone={refresh} />
        <input
          className="mt-3 h-11 w-full rounded-lg border border-line bg-elevated px-3 text-sm"
          placeholder={t(locale, "search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {list.isLoading ? (
          <Skeleton className="mt-4 h-64" />
        ) : (
          <ul className="mt-3 grid gap-1">
            {(list.data?.rows ?? []).map((row) => (
              <li key={row.user_id}>
                <button
                  type="button"
                  onClick={() => setSelected(row.user_id)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-start ${
                    selected === row.user_id ? "bg-elevated" : "hover:bg-surface"
                  }`}
                >
                  <span>
                    <span className="block text-sm font-medium">{row.full_name}</span>
                    <span className="font-mono text-xs text-faint">{row.email}</span>
                  </span>
                  <span className={`text-xs ${row.active ? "text-ok" : "text-warn"}`}>
                    {row.active ? (row.device_approved ? "ok" : "device") : "off"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        {!selected ? (
          <Empty>{t(locale, "noPeople")}</Empty>
        ) : detail.isLoading || !detail.data ? (
          <Skeleton className="h-80" />
        ) : (
          <WorkerDetail
            locale={locale}
            data={detail.data}
            sites={home.sites}
            onDone={refresh}
          />
        )}
      </div>
    </div>
  );
}

function CreatePerson({ locale, onDone }: { locale: Locale; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const save = useMutation({
    mutationFn: () => createWorker({ data: { username, password, fullName, phone } }),
    onSuccess: () => {
      toast.success(t(locale, "created"));
      setUsername("");
      setPassword("");
      setFullName("");
      setPhone("");
      setOpen(false);
      onDone();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  if (!open) {
    return (
      <Button className="mt-3" variant="outline" onClick={() => setOpen(true)}>
        {t(locale, "addPerson")}
      </Button>
    );
  }
  return (
    <Panel className="mt-3 grid gap-2">
      <input className="h-11 rounded-lg border border-line bg-elevated px-3 text-sm" placeholder={t(locale, "username")} value={username} onChange={(e) => setUsername(e.target.value)} />
      <input className="h-11 rounded-lg border border-line bg-elevated px-3 text-sm" placeholder={t(locale, "fullName")} value={fullName} onChange={(e) => setFullName(e.target.value)} />
      <input className="h-11 rounded-lg border border-line bg-elevated px-3 text-sm" placeholder={t(locale, "phone")} value={phone} onChange={(e) => setPhone(e.target.value)} />
      <input className="h-11 rounded-lg border border-line bg-elevated px-3 text-sm" type="password" placeholder={t(locale, "password")} value={password} onChange={(e) => setPassword(e.target.value)} />
      <div className="flex gap-2">
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {t(locale, "addPerson")}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          {t(locale, "close")}
        </Button>
      </div>
    </Panel>
  );
}

function WorkerDetail({
  locale,
  data,
  sites,
  onDone,
}: {
  locale: Locale;
  data: Awaited<ReturnType<typeof workerDetail>>;
  sites: HomeData["sites"];
  onDone: () => void;
}) {
  const u = data.user;
  const [task, setTask] = useState("");
  const [siteId, setSiteId] = useState(sites[0]?.id ?? 0);
  const [newPass, setNewPass] = useState("");
  const today = cairoDate();
  return (
    <Panel className="grid gap-4">
      <div>
        <h2 className="font-display text-xl font-semibold">{u.full_name}</h2>
        <p className="font-mono text-xs text-muted">{u.email}</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Stat label={t(locale, "daysPresent")} value={`${data.monthly.daysPresent}/${data.monthly.daysInMonth}`} />
        <Stat label={t(locale, "monthlyHours")} value={`${data.hours.totalHours}h`} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={async () => {
            await approveDevice({ data: { userId: u.user_id } });
            onDone();
          }}
        >
          {t(locale, "approveDevice")}
        </Button>
        <Button
          variant="outline"
          onClick={async () => {
            await resetDevice({ data: { userId: u.user_id } });
            onDone();
          }}
        >
          {t(locale, "resetDevice")}
        </Button>
        <Button
          variant="outline"
          onClick={async () => {
            await forceLogout({ data: { userId: u.user_id } });
            toast.success(t(locale, "forceLogout"));
          }}
        >
          {t(locale, "forceLogout")}
        </Button>
        <Button
          variant="danger"
          onClick={async () => {
            await setWorkerActive({ data: { userId: u.user_id, active: !u.active } });
            onDone();
          }}
        >
          {u.active ? t(locale, "deactivate") : t(locale, "activate")}
        </Button>
        <Button
          variant="outline"
          onClick={async () => {
            await setWorkerRole({ data: { userId: u.user_id, role: u.role === "admin" ? "employee" : "admin" } });
            onDone();
          }}
        >
          {u.role === "admin" ? t(locale, "makeWorker") : t(locale, "makeAdmin")}
        </Button>
      </div>
      <div className="flex gap-2">
        <input
          className="h-11 flex-1 rounded-lg border border-line bg-elevated px-3 text-sm"
          type="password"
          placeholder={t(locale, "newPassword")}
          value={newPass}
          onChange={(e) => setNewPass(e.target.value)}
        />
        <Button
          variant="outline"
          disabled={newPass.length < 8}
          onClick={async () => {
            await resetWorkerPassword({ data: { userId: u.user_id, newPassword: newPass } });
            setNewPass("");
            toast.success(t(locale, "passwordReset"));
          }}
        >
          {t(locale, "resetPassword")}
        </Button>
      </div>
      <div>
        <Kicker>{t(locale, "hoursHeat")}</Kicker>
        <HoursHeat days={data.hours.days} />
      </div>
      <div>
        <Kicker>{t(locale, "assign")}</Kicker>
        <div className="grid gap-2 md:grid-cols-2">
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
        </div>
        <Button
          className="mt-2"
          variant="outline"
          onClick={async () => {
            await saveAssignment({
              data: { userId: u.user_id, siteId, task, startDate: today, endDate: today },
            });
            toast.success(t(locale, "saved"));
            onDone();
          }}
        >
          {t(locale, "assign")}
        </Button>
      </div>
      <div>
        <Kicker>{t(locale, "history")}</Kicker>
        <ul className="grid gap-1">
          {data.recent.map((row) => (
            <li key={row.id} className="flex items-center justify-between text-sm">
              <span>
                {row.type} · {row.site_name}
              </span>
              <FlagChip reason={row.flag_reason} />
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

function Sites({ locale }: { locale: Locale }) {
  const q = useQuery({ queryKey: ["htn-sites"], queryFn: () => listSites() });
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const current = useMemo(
    () => (typeof editing === "number" ? q.data?.rows.find((s) => s.id === editing) : null),
    [editing, q.data],
  );
  if (q.isLoading) return <Skeleton className="h-64" />;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div>
        <div className="flex items-center justify-between">
          <h1 className="font-display text-2xl font-semibold">{t(locale, "sites")}</h1>
          <Button variant="outline" onClick={() => setEditing("new")}>
            {t(locale, "createSite")}
          </Button>
        </div>
        <ul className="mt-4 grid gap-2">
          {(q.data?.rows ?? []).map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setEditing(s.id)}
                className="flex w-full items-center justify-between rounded-xl border border-line bg-surface px-4 py-3 text-start"
              >
                <span>
                  <span className="block text-sm font-medium">{s.name}</span>
                  <span className="font-mono text-xs text-faint">
                    {s.lat.toFixed(4)}, {s.lng.toFixed(4)} · {s.radius_meters}m
                  </span>
                </span>
                <span className={s.active ? "text-ok" : "text-faint"}>{s.active ? "on" : "off"}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {editing ? (
        <SiteForm
          locale={locale}
          initial={
            current ?? {
              id: 0,
              name: "",
              address: "",
              lat: 30.0561,
              lng: 31.3395,
              radius_meters: 200,
              active: true,
            }
          }
          isNew={editing === "new"}
          onDone={() => {
            setEditing(null);
            void q.refetch();
          }}
        />
      ) : (
        <Empty>{t(locale, "sites")}</Empty>
      )}
    </div>
  );
}

function SiteForm({
  locale,
  initial,
  isNew,
  onDone,
}: {
  locale: Locale;
  initial: { id: number; name: string; address: string | null; lat: number; lng: number; radius_meters: number; active: boolean };
  isNew: boolean;
  onDone: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [address, setAddress] = useState(initial.address ?? "");
  const [lat, setLat] = useState(String(initial.lat));
  const [lng, setLng] = useState(String(initial.lng));
  const [radius, setRadius] = useState(String(initial.radius_meters));
  const latN = Number(lat);
  const lngN = Number(lng);
  const save = useMutation({
    mutationFn: () =>
      saveSite({
        data: {
          id: isNew ? undefined : initial.id,
          name,
          address,
          lat: latN,
          lng: lngN,
          radius_meters: Number(radius) || 200,
        },
      }),
    onSuccess: () => {
      toast.success(t(locale, "saved"));
      onDone();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  return (
    <Panel className="grid gap-3">
      <h2 className="font-display text-lg font-semibold">{isNew ? t(locale, "createSite") : t(locale, "editSite")}</h2>
      <input className="h-11 rounded-lg border border-line bg-elevated px-3 text-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder={t(locale, "name")} />
      <input className="h-11 rounded-lg border border-line bg-elevated px-3 text-sm" value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t(locale, "address")} />
      <div className="grid grid-cols-3 gap-2">
        <input className="h-11 rounded-lg border border-line bg-elevated px-3 font-mono text-sm" value={lat} onChange={(e) => setLat(e.target.value)} />
        <input className="h-11 rounded-lg border border-line bg-elevated px-3 font-mono text-sm" value={lng} onChange={(e) => setLng(e.target.value)} />
        <input className="h-11 rounded-lg border border-line bg-elevated px-3 font-mono text-sm" value={radius} onChange={(e) => setRadius(e.target.value)} />
      </div>
      <Button
        variant="outline"
        onClick={() => {
          navigator.geolocation.getCurrentPosition((p) => {
            setLat(String(p.coords.latitude));
            setLng(String(p.coords.longitude));
          });
        }}
      >
        {t(locale, "useLocation")}
      </Button>
      <p className="text-xs text-faint">{t(locale, "tapMap")}</p>
      {Number.isFinite(latN) && Number.isFinite(lngN) ? (
        <OpsMap
          sites={[
            {
              id: initial.id || 0,
              name: name || t(locale, "site"),
              lat: latN,
              lng: lngN,
              radius_meters: Number(radius) || 200,
            },
          ]}
          pickable
          onPick={(c) => {
            setLat(c.lat.toFixed(6));
            setLng(c.lng.toFixed(6));
          }}
          className="h-56"
        />
      ) : null}
      <Button disabled={save.isPending} onClick={() => save.mutate()}>
        {t(locale, "save")}
      </Button>
    </Panel>
  );
}

function Skills({ locale }: { locale: Locale }) {
  const q = useQuery({ queryKey: ["htn-skills"], queryFn: () => listSkills() });
  const workers = useQuery({ queryKey: ["htn-workers", "skills"], queryFn: () => listWorkers({ data: {} }) });
  const sites = useQuery({ queryKey: ["htn-sites"], queryFn: () => listSites() });
  const cover = useQuery({ queryKey: ["htn-coverage"], queryFn: () => skillCoverage() });
  const [siteId, setSiteId] = useState(0);
  const [skillId, setSkillId] = useState(0);
  const [need, setNeed] = useState("1");
  if (q.isLoading) return <Skeleton className="h-64" />;
  const skills = q.data?.skills ?? [];
  const byUser = new Map<string, { name: string; levels: Record<number, number> }>();
  for (const w of q.data?.workers ?? []) {
    const cur = byUser.get(w.user_id) ?? { name: w.full_name, levels: {} };
    cur.levels[w.skill_id] = w.level;
    byUser.set(w.user_id, cur);
  }
  return (
    <div className="grid gap-6">
      <h1 className="font-display text-2xl font-semibold">{t(locale, "skills")}</h1>
      <div className="overflow-auto rounded-xl border border-line">
        <table className="w-full min-w-lg text-sm">
          <thead className="bg-elevated text-xs uppercase tracking-widest text-muted">
            <tr>
              <th className="px-3 py-2 text-start">{t(locale, "people")}</th>
              {skills.map((s) => (
                <th key={s.id} className="px-3 py-2 text-start">
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(workers.data?.rows ?? []).filter((r) => r.role === "employee").map((w) => (
              <tr key={w.user_id} className="border-t border-line">
                <td className="px-3 py-2 font-medium">{w.full_name}</td>
                {skills.map((s) => (
                  <td key={s.id} className="px-3 py-2">
                    <select
                      className="h-9 rounded-md border border-line bg-elevated px-2 font-mono text-xs"
                      value={byUser.get(w.user_id)?.levels[s.id] ?? 0}
                      onChange={async (e) => {
                        const level = Number(e.target.value);
                        if (!level) return;
                        await setWorkerSkill({ data: { userId: w.user_id, skillId: s.id, level } });
                        void q.refetch();
                        void cover.refetch();
                      }}
                    >
                      <option value={0}>—</option>
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Panel className="grid gap-2">
        <Kicker>{t(locale, "setNeed")}</Kicker>
        <div className="grid gap-2 md:grid-cols-4">
          <select
            className="h-11 rounded-lg border border-line bg-elevated px-3 text-sm"
            value={siteId}
            onChange={(e) => setSiteId(Number(e.target.value))}
          >
            <option value={0}>{t(locale, "site")}</option>
            {(sites.data?.rows ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            className="h-11 rounded-lg border border-line bg-elevated px-3 text-sm"
            value={skillId}
            onChange={(e) => setSkillId(Number(e.target.value))}
          >
            <option value={0}>{t(locale, "skills")}</option>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input
            className="h-11 rounded-lg border border-line bg-elevated px-3 font-mono text-sm"
            value={need}
            onChange={(e) => setNeed(e.target.value)}
          />
          <Button
            disabled={!siteId || !skillId}
            onClick={async () => {
              await setSiteSkillNeed({ data: { siteId, skillId, workersNeeded: Number(need) || 0 } });
              void q.refetch();
              void cover.refetch();
            }}
          >
            {t(locale, "save")}
          </Button>
        </div>
      </Panel>
      <Panel>
        <Kicker>{t(locale, "coverage")}</Kicker>
        {(cover.data?.rows ?? []).length === 0 ? (
          <Empty>{t(locale, "noGaps")}</Empty>
        ) : (
          <ul className="grid gap-1 text-sm">
            {cover.data?.rows.map((r) => (
              <li key={`${r.site_id}-${r.skill_id}`} className="flex justify-between border-t border-line py-2">
                <span>
                  {r.site_name} · {r.skill_name}
                </span>
                <span className={r.covered < r.workers_needed ? "font-mono text-warn" : "font-mono text-ok"}>
                  {t(locale, "have")} {r.covered} / {t(locale, "need")} {r.workers_needed}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Reports({ locale }: { locale: Locale }) {
  const q = useQuery({ queryKey: ["htn-admin-reports"], queryFn: () => adminReports() });
  if (q.isLoading) return <Skeleton className="h-64" />;
  const rows = q.data?.rows ?? [];
  if (!rows.length) return <Empty>{t(locale, "noReports")}</Empty>;
  return (
    <div className="grid gap-3">
      <h1 className="font-display text-2xl font-semibold">{t(locale, "reports")}</h1>
      {rows.map((row) => (
        <Panel key={row.id}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{row.title}</p>
              <p className="mt-1 text-sm text-muted">{row.body}</p>
              <p className="mt-2 font-mono text-xs text-faint">
                {row.kind} · {row.priority} · {row.category ?? "—"} · {row.full_name} · {row.site_name ?? "—"} · {row.status}
              </p>
              {row.photo_data ? (
                <img src={row.photo_data} alt="" className="mt-2 max-h-40 rounded-lg object-cover" />
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col gap-1">
              {row.status === "submitted" || row.status === "in_progress" ? (
                <>
                  {row.status === "submitted" ? (
                    <Button
                      variant="outline"
                      onClick={async () => {
                        await reviewReport({ data: { id: row.id, status: "in_progress" } });
                        void q.refetch();
                      }}
                    >
                      {t(locale, "inProgress")}
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    onClick={async () => {
                      await reviewReport({ data: { id: row.id, status: "resolved" } });
                      void q.refetch();
                    }}
                  >
                    {t(locale, "resolved")}
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        </Panel>
      ))}
    </div>
  );
}

function LeaveDesk({ locale }: { locale: Locale }) {
  const q = useQuery({ queryKey: ["htn-admin-leave"], queryFn: () => adminListLeave() });
  if (q.isLoading) return <Skeleton className="h-64" />;
  const rows = q.data?.rows ?? [];
  if (!rows.length) return <Empty>{t(locale, "noLeave")}</Empty>;
  return (
    <div className="grid gap-3">
      <h1 className="font-display text-2xl font-semibold">{t(locale, "leave")}</h1>
      {rows.map((row) => (
        <Panel key={row.id}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">
                {row.full_name} · {row.kind}
              </p>
              <p className="mt-1 font-mono text-xs text-muted">
                {row.start_date} → {row.end_date}
              </p>
              {row.reason ? <p className="mt-1 text-sm text-muted">{row.reason}</p> : null}
              <p className="mt-2 font-mono text-xs text-faint">{row.status}</p>
            </div>
            {row.status === "pending" ? (
              <div className="flex gap-2">
                <Button
                  onClick={async () => {
                    await reviewLeave({ data: { id: row.id, status: "approved" } });
                    void q.refetch();
                  }}
                >
                  {t(locale, "approve")}
                </Button>
                <Button
                  variant="outline"
                  onClick={async () => {
                    await reviewLeave({ data: { id: row.id, status: "denied" } });
                    void q.refetch();
                  }}
                >
                  {t(locale, "deny")}
                </Button>
              </div>
            ) : null}
          </div>
        </Panel>
      ))}
    </div>
  );
}

function Log({ locale }: { locale: Locale }) {
  const q = useQuery({ queryKey: ["htn-log"], queryFn: () => activityLog({ data: {} }) });
  if (q.isLoading) return <Skeleton className="h-64" />;
  return (
    <div className="grid gap-3">
      <h1 className="font-display text-2xl font-semibold">{t(locale, "log")}</h1>
      <table className="w-full text-sm">
        <tbody>
          {(q.data?.rows ?? []).map((row) => (
            <tr key={row.id} className="border-t border-line">
              <td className="py-2 font-mono text-xs text-faint">
                {new Date(row.created_at).toLocaleString()}
              </td>
              <td className="py-2">{row.full_name ?? row.user_id}</td>
              <td className="py-2 font-mono text-xs">{row.kind}</td>
              <td className="py-2 text-muted">{row.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExportTab({ locale }: { locale: Locale }) {
  const today = cairoDate();
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  function download(csv: string, filename: string) {
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  const punches = useMutation({
    mutationFn: () => exportAttendanceCsv({ data: { from, to } }),
    onSuccess: (res) => download(res.csv, res.filename),
  });
  const payroll = useMutation({
    mutationFn: () => exportPayrollCsv({ data: { from, to } }),
    onSuccess: (res) => download(res.csv, res.filename),
  });
  return (
    <Panel className="max-w-md grid gap-3">
      <h1 className="font-display text-2xl font-semibold">{t(locale, "export")}</h1>
      <label className="text-xs text-muted">
        {t(locale, "dateFrom")}
        <input className="mt-1 h-11 w-full rounded-lg border border-line bg-elevated px-3 text-sm" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label className="text-xs text-muted">
        {t(locale, "dateTo")}
        <input className="mt-1 h-11 w-full rounded-lg border border-line bg-elevated px-3 text-sm" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </label>
      <Button disabled={punches.isPending} onClick={() => punches.mutate()}>
        {t(locale, "exportPunches")}
      </Button>
      <Button variant="outline" disabled={payroll.isPending} onClick={() => payroll.mutate()}>
        {t(locale, "exportPayroll")}
      </Button>
    </Panel>
  );
}
