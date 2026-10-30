import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Copy,
  Download,
  Flag,
  History,
  LayoutDashboard,
  MapPin,
  Megaphone,
  MoreHorizontal,
  Palmtree,
  ScrollText,
  Sparkles,
  Users,
} from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Empty, FlagChip, Kicker, Panel, Stat, BrandMark } from "@/components/chrome";
import { Skeleton } from "@/components/ui/skeleton";
import { cairoDate, cairoTimeStr, cairoToIso, needsMapsExpand, parseGoogleMapsUrl } from "@/lib/geo";
import { type Locale, type Msg, t } from "@/lib/i18n";
import {
  activityLog,
  adminOverview,
  adminReports,
  approveDevice,
  closeOpenShift,
  createManualAttendance,
  exportAttendanceCsv,
  exportPayrollCsv,
  forceLogout,
  listAttendanceRequests,
  listFlagged,
  listSites,
  listSiteGroups,
  listSkills,
  listWorkers,
  liveMap,
  resolveMapsLink,
  resetDevice,
  reviewCheckin,
  reviewReport,
  reverseManualAttendance,
  reviewAttendanceRequest,
  saveAssignment,
  saveSite,
  saveSiteGroup,
  deleteSite,
  setWorkerActive,
  deleteWorker,
  setWorkerSkill,
  workerAttendanceCsv,
  workerAttendanceHistory,
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
import { exportAttendanceExcel } from "@/lib/server/attendance-excel";
import type { HomeData } from "@/lib/server/field";
import { Sheet } from "@/components/ui/sheet";
import { AdminBroadcast } from "./admin-broadcast";
import { AdminSchedule } from "./admin-schedule";
import { HoursHeat } from "./hours-heat";
import { OpsMap } from "./ops-map";
import { WorkerApp } from "./worker-app";

import { formatDurationMinutes } from "@/lib/duration";
import { StatusChip } from "@/components/ui/status-chip";

type AdminTab =
  | "overview"
  | "queue"
  | "people"
  | "attendance"
  | "schedule"
  | "sites"
  | "skills"
  | "reports"
  | "leave"
  | "broadcast"
  | "log"
  | "export"
  | "field";

interface NavItem {
  id: AdminTab;
  label: Msg;
  icon: typeof LayoutDashboard;
}

const NAV_SECTIONS: {
  titleKey: Msg;
  items: NavItem[];
}[] = [
  {
    titleKey: "navOperations",
    items: [
      { id: "overview", label: "overview", icon: LayoutDashboard },
      { id: "queue", label: "queue", icon: Flag },
      { id: "attendance", label: "attendance", icon: History },
      { id: "schedule", label: "schedule", icon: CalendarDays },
      { id: "sites", label: "sites", icon: MapPin },
    ],
  },
  {
    titleKey: "navWorkforce",
    items: [
      { id: "people", label: "people", icon: Users },
      { id: "skills", label: "skills", icon: Sparkles },
      { id: "leave", label: "leave", icon: Palmtree },
    ],
  },
  {
    titleKey: "navFieldComms",
    items: [
      { id: "reports", label: "reports", icon: ClipboardList },
      { id: "broadcast", label: "broadcast", icon: Megaphone },
      { id: "field", label: "fieldPunch", icon: MapPin },
    ],
  },
  {
    titleKey: "navSystem",
    items: [
      { id: "log", label: "log", icon: ScrollText },
      { id: "export", label: "export", icon: Download },
    ],
  },
];

const ALL_NAV_ITEMS = NAV_SECTIONS.flatMap((s) => s.items);

// Mobile thumb-reachable primary tabs
const MOBILE_PRIMARY: AdminTab[] = ["overview", "queue", "people", "attendance", "sites"];

function loginName(row: { username?: string | null; email?: string | null }) {
  const u = row.username?.trim();
  if (u) return u;
  const email = row.email?.trim();
  if (email) return email.split("@")[0] ?? email;
  return "—";
}

async function copyText(value: string, okLabel = "Copied") {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(okLabel);
  } catch {
    toast.error("Copy failed");
  }
}

function randomPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  crypto.getRandomValues(new Uint32Array(10)).forEach((n) => {
    out += chars[n % chars.length];
  });
  return out;
}

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
  const [moreOpen, setMoreOpen] = useState(false);
  const moreTabs = ALL_NAV_ITEMS.filter((item) => !MOBILE_PRIMARY.includes(item.id));
  const activeInMore = moreTabs.some((item) => item.id === tab);

  // Live overview metrics for navigation badges (shares query cache with Overview component)
  const overviewQuery = useQuery({
    queryKey: ["htn-overview"],
    queryFn: () => adminOverview(),
    refetchInterval: 30_000,
  });

  const getBadgeCount = (itemKey: AdminTab): number | undefined => {
    if (!overviewQuery.data) return undefined;
    if (itemKey === "queue") {
      const count =
        (overviewQuery.data.flagged ?? 0) +
        (overviewQuery.data.pendingRequests ?? 0) +
        (overviewQuery.data.rejectedPunchesCount ?? 0) +
        (overviewQuery.data.pendingDevices ?? 0);
      return count > 0 ? count : undefined;
    }
    if (itemKey === "leave") {
      return overviewQuery.data.pendingLeave > 0 ? overviewQuery.data.pendingLeave : undefined;
    }
    if (itemKey === "reports") {
      return overviewQuery.data.openReports > 0 ? overviewQuery.data.openReports : undefined;
    }
    return undefined;
  };

  const moreBadgeTotal = moreTabs.reduce((acc, item) => acc + (getBadgeCount(item.id) ?? 0), 0);

  return (
    <div className="flex min-h-dvh">
      {/* Desktop Grouped Sidebar Navigation */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col overflow-y-auto border-e border-line bg-surface md:flex">
        <div className="flex items-center gap-3 px-4 py-4 border-b border-line/60">
          <BrandMark className="h-10 w-auto" />
          <div>
            <p className="font-display text-sm font-bold tracking-tight text-fg">{t(locale, "adminDesk")}</p>
            <span className="font-mono text-[10px] text-faint">HiTechNour FieldOps</span>
          </div>
        </div>
        <nav className="flex-1 space-y-4 px-2.5 py-3">
          {NAV_SECTIONS.map((section) => (
            <div key={section.titleKey} className="space-y-0.5">
              <h3 className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-muted/70">
                {t(locale, section.titleKey)}
              </h3>
              {section.items.map((item) => {
                const Icon = item.icon;
                const active = tab === item.id;
                const badge = getBadgeCount(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setTab(item.id)}
                    className={`flex min-h-10 w-full items-center justify-between rounded-lg px-3 text-sm font-medium transition-colors ${
                      active
                        ? "bg-elevated font-semibold text-fg shadow-xs"
                        : "text-muted hover:bg-elevated/40 hover:text-fg"
                    }`}
                  >
                    <span className="flex items-center gap-2.5">
                      <Icon className={`size-4 ${active ? "text-primary" : "text-muted"}`} />
                      <span>{t(locale, item.label)}</span>
                    </span>
                    {badge != null ? (
                      <span className="rounded-full bg-warn/20 px-1.5 py-0.2 font-mono text-[10px] font-bold text-warn">
                        {badge}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 overflow-auto p-4 pb-24 md:p-6 md:pb-6">
          {tab === "overview" ? <Overview locale={locale} onNavigate={(nextTab) => setTab(nextTab)} /> : null}
          {tab === "queue" ? <Queue locale={locale} /> : null}
          {tab === "people" ? <People locale={locale} home={home} /> : null}
          {tab === "attendance" ? <Attendance locale={locale} /> : null}
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

      {/* Mobile bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        <ul className="grid grid-cols-6">
          {ALL_NAV_ITEMS.filter((item) => MOBILE_PRIMARY.includes(item.id)).map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            const badge = getBadgeCount(item.id);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={`relative flex min-h-14 w-full flex-col items-center justify-center gap-1 px-0.5 text-[11px] font-medium transition-colors ${
                    active ? "font-bold text-fg" : "text-faint hover:text-muted"
                  }`}
                >
                  <div className="relative">
                    <Icon className="size-4" />
                    {badge != null ? (
                      <span className="absolute -top-1 -end-2.5 flex min-w-3.5 items-center justify-center rounded-full bg-warn px-1 font-mono text-[9px] font-bold text-bg">
                        {badge}
                      </span>
                    ) : null}
                  </div>
                  <span className="truncate max-w-[52px]">{t(locale, item.label)}</span>
                </button>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              className={`relative flex min-h-14 w-full flex-col items-center justify-center gap-1 px-0.5 text-[11px] font-medium transition-colors ${
                activeInMore ? "font-bold text-fg" : "text-faint hover:text-muted"
              }`}
            >
              <div className="relative">
                <MoreHorizontal className="size-4" />
                {moreBadgeTotal > 0 ? (
                  <span className="absolute -top-1 -end-2 flex min-w-3 items-center justify-center rounded-full bg-warn px-0.5 font-mono text-[8px] font-bold text-bg">
                    {moreBadgeTotal}
                  </span>
                ) : null}
              </div>
              <span>{t(locale, "more")}</span>
            </button>
          </li>
        </ul>
      </nav>

      {/* Mobile More Sheet */}
      <Sheet open={moreOpen} onOpenChange={setMoreOpen} title={t(locale, "moreMenuTitle")}>
        <ul className="grid gap-1">
          {moreTabs.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            const badge = getBadgeCount(item.id);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    setTab(item.id);
                    setMoreOpen(false);
                  }}
                  className={`flex min-h-12 w-full items-center justify-between rounded-lg px-3 text-sm font-medium transition-colors ${
                    active ? "bg-elevated font-semibold text-fg" : "text-muted hover:bg-elevated/40 hover:text-fg"
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <Icon className="size-4" />
                    <span>{t(locale, item.label)}</span>
                  </span>
                  {badge != null ? (
                    <span className="rounded-full bg-warn/20 px-2 py-0.5 font-mono text-xs font-bold text-warn">
                      {badge}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </Sheet>
    </div>
  );
}

function Overview({
  locale,
  onNavigate,
}: {
  locale: Locale;
  onNavigate: (tab: AdminTab) => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["htn-overview"], queryFn: () => adminOverview(), refetchInterval: 15_000 });
  const map = useQuery({ queryKey: ["htn-live-map"], queryFn: () => liveMap(), refetchInterval: 20_000 });
  const closeShift = useMutation({
    mutationFn: (userId: string) => closeOpenShift({ data: { userId } }),
    onSuccess: () => {
      toast.success(t(locale, "saved"));
      void qc.invalidateQueries({ queryKey: ["htn-overview"] });
      void qc.invalidateQueries({ queryKey: ["htn-live-map"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (!q.data) return <Empty>{t(locale, "loadError")}</Empty>;
  const d = q.data;

  const totalUrgent =
    (d.flagged ?? 0) +
    (d.pendingRequests ?? 0) +
    (d.rejectedPunchesCount ?? 0) +
    (d.staleShiftsCount ?? 0) +
    (d.pendingLeave ?? 0) +
    (d.pendingDevices ?? 0);

  return (
    <div className="grid gap-6">
      {/* Header with Quick Navigation */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold text-fg">{t(locale, "overview")}</h1>
          <p className="mt-0.5 font-mono text-xs text-muted">
            {d.today} · Cairo (UTC+2)
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs font-medium"
            onClick={() => onNavigate("attendance")}
          >
            <History className="me-1.5 size-3.5" />
            {t(locale, "attendance")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs font-medium"
            onClick={() => onNavigate("queue")}
          >
            <Flag className="me-1.5 size-3.5" />
            {t(locale, "queue")}
            {(d.flagged + (d.pendingRequests ?? 0) + (d.rejectedPunchesCount ?? 0)) > 0 ? (
              <span className="ms-1.5 rounded-full bg-warn/20 px-1.5 py-0.2 font-mono text-[10px] font-bold text-warn">
                {d.flagged + (d.pendingRequests ?? 0) + (d.rejectedPunchesCount ?? 0)}
              </span>
            ) : null}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs font-medium"
            onClick={() => onNavigate("reports")}
          >
            <ClipboardList className="me-1.5 size-3.5" />
            {t(locale, "reports")}
            {(d.openReports ?? 0) > 0 ? (
              <span className="ms-1.5 rounded-full bg-warn/20 px-1.5 py-0.2 font-mono text-[10px] font-bold text-warn">
                {d.openReports}
              </span>
            ) : null}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs font-medium"
            onClick={() => onNavigate("people")}
          >
            <Users className="me-1.5 size-3.5" />
            {t(locale, "people")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs font-medium"
            onClick={() => onNavigate("sites")}
          >
            <MapPin className="me-1.5 size-3.5" />
            {t(locale, "sites")}
          </Button>
        </div>
      </div>

      {/* Action Center / Operational Issues Card */}
      <div className={`rounded-2xl border p-4 transition-all ${
        totalUrgent > 0
          ? "border-amber-500/30 bg-amber-500/5 dark:bg-amber-950/10"
          : "border-line bg-surface"
      }`}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className={`flex size-2 rounded-full ${totalUrgent > 0 ? "bg-amber-500 animate-pulse" : "bg-ok"}`} />
            <h2 className="font-display text-sm font-bold uppercase tracking-wider text-fg">
              {t(locale, "actionCenter")}
            </h2>
            {totalUrgent > 0 ? (
              <StatusChip size="sm" variant="warn">
                {totalUrgent} {t(locale, "attentionNeeded")}
              </StatusChip>
            ) : (
              <StatusChip size="sm" variant="ok">
                {t(locale, "cleanOperations")}
              </StatusChip>
            )}
          </div>
        </div>

        {totalUrgent > 0 ? (
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {/* Unclosed stale shifts */}
            {(d.staleShiftsCount ?? 0) > 0 ? (
              <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-xs text-rose-700 dark:text-rose-400">
                    {t(locale, "staleShifts")}
                  </span>
                  <StatusChip size="sm" variant="bad">
                    {d.staleShiftsCount}
                  </StatusChip>
                </div>
                <p className="text-[11px] text-muted leading-tight">
                  {t(locale, "staleShiftDesc")}
                </p>
                <div className="space-y-1.5 pt-1">
                  {(d.staleShiftsList ?? []).slice(0, 3).map((stale) => (
                    <div key={stale.user_id} className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate font-medium text-fg max-w-[140px]">{stale.full_name}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[10px] text-rose-600 hover:text-rose-700"
                        disabled={closeShift.isPending}
                        onClick={() => closeShift.mutate(stale.user_id)}
                      >
                        {t(locale, "closeShift")}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Attendance review requests */}
            {(d.pendingRequests ?? 0) > 0 ? (
              <button
                type="button"
                onClick={() => onNavigate("queue")}
                className="flex flex-col justify-between rounded-xl border border-line bg-surface p-3 text-start hover:bg-elevated/40 transition-colors"
              >
                <div className="flex items-center justify-between w-full">
                  <span className="font-semibold text-xs text-fg">{t(locale, "reviewRequestsTab")}</span>
                  <StatusChip size="sm" variant="warn">
                    {d.pendingRequests}
                  </StatusChip>
                </div>
                <p className="text-[11px] text-muted mt-1 leading-snug">
                  {t(locale, "pendingReviewRequest")}
                </p>
                <span className="text-[11px] font-semibold text-primary mt-2">
                  {t(locale, "viewDetails")} →
                </span>
              </button>
            ) : null}

            {/* Suspicious / Flagged punches */}
            {(d.flagged ?? 0) > 0 ? (
              <button
                type="button"
                onClick={() => onNavigate("queue")}
                className="flex flex-col justify-between rounded-xl border border-line bg-surface p-3 text-start hover:bg-elevated/40 transition-colors"
              >
                <div className="flex items-center justify-between w-full">
                  <span className="font-semibold text-xs text-fg">{t(locale, "flaggedPunchesTab")}</span>
                  <StatusChip size="sm" variant="warn">
                    {d.flagged}
                  </StatusChip>
                </div>
                <p className="text-[11px] text-muted mt-1 leading-snug">
                  {t(locale, "outside")} / mock / suspicious GPS
                </p>
                <span className="text-[11px] font-semibold text-primary mt-2">
                  {t(locale, "viewDetails")} →
                </span>
              </button>
            ) : null}

            {/* Rejected punch attempts */}
            {(d.rejectedPunchesCount ?? 0) > 0 ? (
              <button
                type="button"
                onClick={() => onNavigate("queue")}
                className="flex flex-col justify-between rounded-xl border border-line bg-surface p-3 text-start hover:bg-elevated/40 transition-colors"
              >
                <div className="flex items-center justify-between w-full">
                  <span className="font-semibold text-xs text-fg">{t(locale, "rejectedPunchesTab")}</span>
                  <StatusChip size="sm" variant="bad">
                    {d.rejectedPunchesCount}
                  </StatusChip>
                </div>
                <p className="text-[11px] text-muted mt-1 leading-snug">
                  Automatic geofence rejections
                </p>
                <span className="text-[11px] font-semibold text-primary mt-2">
                  {t(locale, "viewDetails")} →
                </span>
              </button>
            ) : null}

            {/* Pending Leave Requests */}
            {(d.pendingLeave ?? 0) > 0 ? (
              <button
                type="button"
                onClick={() => onNavigate("leave")}
                className="flex flex-col justify-between rounded-xl border border-line bg-surface p-3 text-start hover:bg-elevated/40 transition-colors"
              >
                <div className="flex items-center justify-between w-full">
                  <span className="font-semibold text-xs text-fg">{t(locale, "pendingLeave")}</span>
                  <StatusChip size="sm" variant="warn">
                    {d.pendingLeave}
                  </StatusChip>
                </div>
                <p className="text-[11px] text-muted mt-1 leading-snug">
                  Leave requests awaiting approval
                </p>
                <span className="text-[11px] font-semibold text-primary mt-2">
                  {t(locale, "viewDetails")} →
                </span>
              </button>
            ) : null}

            {/* Pending Devices / Inactive Workers */}
            {(d.pendingDevices ?? 0) > 0 ? (
              <button
                type="button"
                onClick={() => onNavigate("people")}
                className="flex flex-col justify-between rounded-xl border border-line bg-surface p-3 text-start hover:bg-elevated/40 transition-colors"
              >
                <div className="flex items-center justify-between w-full">
                  <span className="font-semibold text-xs text-fg">{t(locale, "pendingApprovalsTab")}</span>
                  <StatusChip size="sm" variant="neutral">
                    {d.pendingDevices}
                  </StatusChip>
                </div>
                <p className="text-[11px] text-muted mt-1 leading-snug">
                  Worker device registrations & activations
                </p>
                <span className="text-[11px] font-semibold text-primary mt-2">
                  {t(locale, "viewDetails")} →
                </span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Main Stats (Interactive) */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <button
          type="button"
          onClick={() => onNavigate("attendance")}
          className="text-start focus:outline-none transition-transform hover:scale-[1.01]"
        >
          <Stat label={t(locale, "present")} value={`${d.presentToday}/${d.totalWorkers}`} />
        </button>
        <button
          type="button"
          onClick={() => onNavigate("attendance")}
          className="text-start focus:outline-none transition-transform hover:scale-[1.01]"
        >
          <Stat label={t(locale, "late")} value={d.lateToday} warn={d.lateToday > 0} />
        </button>
        <button
          type="button"
          onClick={() => onNavigate("attendance")}
          className="text-start focus:outline-none transition-transform hover:scale-[1.01]"
        >
          <Stat label={t(locale, "absent")} value={d.absentToday} warn={d.absentToday > 0} />
        </button>
        <button
          type="button"
          onClick={() => onNavigate("queue")}
          className="text-start focus:outline-none transition-transform hover:scale-[1.01]"
        >
          <Stat
            label={t(locale, "flaggedQueue")}
            value={d.flagged + (d.pendingRequests ?? 0) + (d.rejectedPunchesCount ?? 0)}
            warn={(d.flagged + (d.pendingRequests ?? 0) + (d.rejectedPunchesCount ?? 0)) > 0}
          />
        </button>
        <button
          type="button"
          onClick={() => onNavigate("leave")}
          className="text-start focus:outline-none transition-transform hover:scale-[1.01]"
        >
          <Stat label={t(locale, "pendingLeave")} value={d.pendingLeave} warn={d.pendingLeave > 0} />
        </button>
      </div>

      {/* Today's Punches Feed */}
      <Panel>
        <div className="flex items-center justify-between mb-2">
          <Kicker>{t(locale, "todayPunches")}</Kicker>
          <span className="font-mono text-xs text-faint">
            {(d.todayPunches ?? []).length} {t(locale, "allPunches").toLowerCase()}
          </span>
        </div>
        {(d.todayPunches ?? []).length === 0 ? (
          <Empty>{t(locale, "emptyTimeline")}</Empty>
        ) : (
          <ul className="grid gap-0 divide-y divide-line/40">
            {d.todayPunches.map((row) => (
              <li
                key={row.id}
                className={`flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm ${
                  row.isOpenShift ? "bg-elevated/40 px-2 rounded-lg" : ""
                }`}
              >
                <div className="min-w-0">
                  <p className="font-medium">
                    {row.full_name}
                    <span className="ms-2 text-xs font-normal text-muted">
                      {row.type === "check_in" ? t(locale, "checkIn") : t(locale, "checkOut")}
                      {" · "}
                      {row.site_name}
                    </span>
                    {row.isOpenShift ? (
                      <span className={`ms-2 font-mono text-xs font-medium ${row.stale ? "text-warn" : "text-ok"}`}>
                        {row.stale ? t(locale, "staleShift") : formatDurationMinutes(Math.round((row.hoursOpen ?? 0) * 60))}
                      </span>
                    ) : null}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <p className="font-mono text-xs text-faint">
                    {new Date(row.created_at).toLocaleTimeString(locale === "ar" ? "ar-EG" : "en-US")}
                    {" · "}
                    {Math.round(row.distance_meters)} m
                    {row.status === "outside" ? (
                      <span className="ms-2">
                        <StatusChip size="sm" variant="warn">{t(locale, "outside")}</StatusChip>
                      </span>
                    ) : null}
                  </p>
                  {row.isOpenShift ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={closeShift.isPending}
                      onClick={() => closeShift.mutate(row.user_id)}
                    >
                      {t(locale, "closeShift")}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Weekly Chart */}
      <div>
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
      </div>

      {/* Live Map */}
      <Panel className="p-0 overflow-hidden">
        <div className="px-4 pt-4">
          <Kicker>{t(locale, "liveMap")}</Kicker>
        </div>
        <OpsMap
          sites={map.data?.sites}
          people={map.data?.people}
          legend
          className="h-[28rem] rounded-none border-0"
        />
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
                  <li key={m.user_id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2 text-sm">
                    <span>
                      {m.full_name}
                      {m.title ? <span className="text-muted"> · {m.title}</span> : null}
                    </span>
                    <span className="text-end font-mono text-xs text-faint">
                      {m.lastInAt ? (
                        <span className="block">
                          {t(locale, "checkIn")} {new Date(m.lastInAt).toLocaleTimeString()}
                          {m.lastInMeters != null ? ` · ${Math.round(m.lastInMeters)} m` : ""}
                          {m.lastInSite ? ` · ${m.lastInSite}` : ""}
                        </span>
                      ) : (
                        <span className="block text-warn">{t(locale, "noCheckIn")}</span>
                      )}
                      {m.lastOutAt ? (
                        <span className="block">
                          {t(locale, "checkOut")} {new Date(m.lastOutAt).toLocaleTimeString()}
                          {m.lastOutMeters != null ? ` · ${Math.round(m.lastOutMeters)} m` : ""}
                          {m.lastOutSite ? ` · ${m.lastOutSite}` : ""}
                        </span>
                      ) : null}
                      <span className="block">{m.attendancePct}%</span>
                    </span>
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
  const attRequests = useQuery({
    queryKey: ["htn-attendance-requests", "pending"],
    queryFn: () => listAttendanceRequests({ data: { status: "pending", requestKind: "all" } }),
  });
  const [filter, setFilter] = useState<"all" | "review_requests" | "flagged" | "rejected_punches" | "approvals">("all");
  const [reviewModalRequest, setReviewModalRequest] = useState<{
    id: number;
    full_name: string;
    phone: string | null;
    email: string | null;
    site_name: string;
    type: string;
    request_kind?: string;
    attempted_at: string;
    reason: string;
    accuracy_meters: number | null;
    distance_meters: number | null;
  } | null>(null);
  const [adminNotes, setAdminNotes] = useState("");
  const [reviewActionPending, setReviewActionPending] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["htn-queue"] });
    void qc.invalidateQueries({ queryKey: ["htn-attendance-requests"] });
    void qc.invalidateQueries({ queryKey: ["htn-worker-attendance"] });
    void qc.invalidateQueries({ queryKey: ["htn-overview"] });
  };

  if (q.isLoading || attRequests.isLoading) return <Skeleton className="h-64" />;
  const pendingPeople = q.data?.pendingPeople ?? [];
  const flagged = q.data?.flagged ?? [];
  const allRequests = attRequests.data?.rows ?? [];
  const reviewRequests = allRequests.filter((r) => r.request_kind === "review_request");
  const rejectedPunches = allRequests.filter((r) => r.request_kind === "rejected_punch");
  const totalCount = reviewRequests.length + flagged.length + rejectedPunches.length + pendingPeople.length;

  const showReviewRequests = (filter === "all" || filter === "review_requests") && reviewRequests.length > 0;
  const showFlagged = (filter === "all" || filter === "flagged") && flagged.length > 0;
  const showRejected = (filter === "all" || filter === "rejected_punches") && rejectedPunches.length > 0;
  const showApprovals = (filter === "all" || filter === "approvals") && pendingPeople.length > 0;

  const hasVisibleItems = showReviewRequests || showFlagged || showRejected || showApprovals;

  return (
    <div className="grid gap-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold text-fg">{t(locale, "flaggedQueue")}</h1>
          <p className="font-mono text-xs text-muted">
            {totalCount} {t(locale, "attentionNeeded").toLowerCase()}
          </p>
        </div>
        {totalCount > 0 ? (
          <StatusChip size="sm" variant="warn">
            {totalCount} {t(locale, "urgentItems")}
          </StatusChip>
        ) : (
          <StatusChip size="sm" variant="ok">
            {t(locale, "cleanOperations")}
          </StatusChip>
        )}
      </div>

      {/* Segment Filter Tabs */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
        <button
          type="button"
          onClick={() => setFilter("all")}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            filter === "all"
              ? "bg-primary text-primary-fg shadow-xs"
              : "bg-surface text-muted hover:bg-elevated hover:text-fg border border-line/60"
          }`}
        >
          <span>{t(locale, "allQueueItems")}</span>
          <span className="font-mono font-bold">{totalCount}</span>
        </button>

        <button
          type="button"
          onClick={() => setFilter("review_requests")}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            filter === "review_requests"
              ? "bg-primary text-primary-fg shadow-xs"
              : "bg-surface text-muted hover:bg-elevated hover:text-fg border border-line/60"
          }`}
        >
          <span>{t(locale, "reviewRequestsTab")}</span>
          {reviewRequests.length > 0 ? (
            <span className="rounded-full bg-warn/20 px-1.5 font-mono text-[10px] font-bold text-warn">
              {reviewRequests.length}
            </span>
          ) : (
            <span className="font-mono text-[10px]">0</span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setFilter("flagged")}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            filter === "flagged"
              ? "bg-primary text-primary-fg shadow-xs"
              : "bg-surface text-muted hover:bg-elevated hover:text-fg border border-line/60"
          }`}
        >
          <span>{t(locale, "flaggedPunchesTab")}</span>
          {flagged.length > 0 ? (
            <span className="rounded-full bg-warn/20 px-1.5 font-mono text-[10px] font-bold text-warn">
              {flagged.length}
            </span>
          ) : (
            <span className="font-mono text-[10px]">0</span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setFilter("rejected_punches")}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            filter === "rejected_punches"
              ? "bg-primary text-primary-fg shadow-xs"
              : "bg-surface text-muted hover:bg-elevated hover:text-fg border border-line/60"
          }`}
        >
          <span>{t(locale, "rejectedPunchesTab")}</span>
          {rejectedPunches.length > 0 ? (
            <span className="rounded-full bg-rose-500/20 px-1.5 font-mono text-[10px] font-bold text-rose-600 dark:text-rose-400">
              {rejectedPunches.length}
            </span>
          ) : (
            <span className="font-mono text-[10px]">0</span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setFilter("approvals")}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            filter === "approvals"
              ? "bg-primary text-primary-fg shadow-xs"
              : "bg-surface text-muted hover:bg-elevated hover:text-fg border border-line/60"
          }`}
        >
          <span>{t(locale, "pendingApprovalsTab")}</span>
          {pendingPeople.length > 0 ? (
            <span className="rounded-full bg-primary/20 px-1.5 font-mono text-[10px] font-bold text-primary">
              {pendingPeople.length}
            </span>
          ) : (
            <span className="font-mono text-[10px]">0</span>
          )}
        </button>
      </div>

      {!hasVisibleItems ? (
        <Empty>{t(locale, "noFlags")}</Empty>
      ) : (
        <div className="grid gap-6">
          {/* Review Requests Section */}
          {showReviewRequests ? (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Kicker>{t(locale, "reviewRequestsTab")}</Kicker>
                  <StatusChip size="sm" variant="info">
                    {reviewRequests.length}
                  </StatusChip>
                </div>
              </div>
              <ul className="grid gap-2.5">
                {reviewRequests.map((r) => (
                  <li
                    key={r.id}
                    className="rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line/80 space-y-3"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm text-fg">{r.full_name}</span>
                          <span className="font-mono text-xs text-muted">· {r.phone || r.email || ""}</span>
                          <StatusChip size="sm" variant="info">
                            {t(locale, "reviewRequestsTab")}
                          </StatusChip>
                          <span className="rounded bg-elevated px-1.5 py-0.5 text-[10px] font-semibold text-muted uppercase">
                            {r.type === "check_in" ? t(locale, "checkIn") : t(locale, "checkOut")}
                          </span>
                        </div>
                        <p className="text-xs text-muted">
                          <span className="font-semibold text-fg">{r.site_name}</span> ·{" "}
                          <span className="font-mono">
                            {new Date(r.attempted_at).toLocaleString(locale === "ar" ? "ar-EG" : "en-US")}
                          </span>
                        </p>
                        <div className="flex items-center gap-2 font-mono text-[11px] text-faint">
                          <span>{t(locale, "distance")}: {r.distance_meters != null ? `${Math.round(r.distance_meters)}m` : "—"}</span>
                          <span>·</span>
                          <span>{t(locale, "accuracy")}: {r.accuracy_meters != null ? `±${Math.round(r.accuracy_meters)}m` : "—"}</span>
                        </div>
                        <div className="rounded-lg bg-elevated/70 p-2.5 text-xs text-fg border border-line/60">
                          <span className="text-muted block text-[10px] uppercase font-bold tracking-wider mb-0.5">
                            {t(locale, "reasonForRequest")}:
                          </span>
                          <span className="italic">"{r.reason}"</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-9 px-3 text-xs"
                          onClick={async () => {
                            try {
                              await reviewAttendanceRequest({
                                data: { requestId: r.id, decision: "reject" },
                              });
                              toast.success(t(locale, "requestRejected"));
                              refresh();
                            } catch (err) {
                              toast.error(err instanceof Error ? err.message : "Failed to reject request");
                            }
                          }}
                        >
                          {t(locale, "rejectRequest")}
                        </Button>
                        <Button
                          size="sm"
                          className="h-9 px-3 text-xs font-semibold"
                          onClick={() => {
                            setReviewModalRequest(r);
                            setAdminNotes("");
                          }}
                        >
                          {t(locale, "approveRequest")}
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Rejected Punch Attempts Section */}
          {showRejected ? (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Kicker>{t(locale, "rejectedPunchesTab")}</Kicker>
                  <StatusChip size="sm" variant="bad">
                    {rejectedPunches.length}
                  </StatusChip>
                </div>
              </div>
              <ul className="grid gap-2.5">
                {rejectedPunches.map((r) => (
                  <li
                    key={r.id}
                    className="rounded-xl border border-rose-500/20 bg-surface p-4 transition-colors space-y-3"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm text-fg">{r.full_name}</span>
                          <span className="font-mono text-xs text-muted">· {r.phone || r.email || ""}</span>
                          <StatusChip size="sm" variant="bad">
                            {t(locale, "rejectedPunchesTab")}
                          </StatusChip>
                          <span className="rounded bg-elevated px-1.5 py-0.5 text-[10px] font-semibold text-muted uppercase">
                            {r.type === "check_in" ? t(locale, "checkIn") : t(locale, "checkOut")}
                          </span>
                        </div>
                        <p className="text-xs text-muted">
                          <span className="font-semibold text-fg">{r.site_name}</span> ·{" "}
                          <span className="font-mono">
                            {new Date(r.attempted_at).toLocaleString(locale === "ar" ? "ar-EG" : "en-US")}
                          </span>
                        </p>
                        <div className="flex items-center gap-2 font-mono text-[11px] text-faint">
                          <span>{t(locale, "distance")}: {r.distance_meters != null ? `${Math.round(r.distance_meters)}m` : "—"}</span>
                          <span>·</span>
                          <span>{t(locale, "accuracy")}: {r.accuracy_meters != null ? `±${Math.round(r.accuracy_meters)}m` : "—"}</span>
                        </div>
                        <p className="text-xs text-rose-600 dark:text-rose-400 font-mono text-[11px]">
                          {r.reason}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-9 px-3 text-xs"
                          onClick={async () => {
                            try {
                              await reviewAttendanceRequest({
                                data: { requestId: r.id, decision: "reject" },
                              });
                              toast.success(t(locale, "requestRejected"));
                              refresh();
                            } catch (err) {
                              toast.error(err instanceof Error ? err.message : "Failed to dismiss request");
                            }
                          }}
                        >
                          {t(locale, "rejectRequest")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-9 px-3 text-xs"
                          onClick={() => {
                            setReviewModalRequest(r);
                            setAdminNotes("");
                          }}
                        >
                          {t(locale, "approveRequest")}
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Flagged Checkins Section */}
          {showFlagged ? (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Kicker>{t(locale, "flaggedPunchesTab")}</Kicker>
                  <StatusChip size="sm" variant="warn">
                    {flagged.length}
                  </StatusChip>
                </div>
              </div>
              <ul className="grid gap-2">
                {flagged.map((row) => (
                  <li key={row.id} className="rounded-xl border border-line bg-surface p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm text-fg">{row.full_name}</span>
                          <StatusChip size="sm" variant="warn">
                            {t(locale, "flaggedPunchesTab")}
                          </StatusChip>
                        </div>
                        <p className="font-mono text-xs text-muted">
                          {row.site_name} · {row.type} · {Math.round(row.distance_meters)} m
                        </p>
                        <div className="mt-1.5">
                          <FlagChip reason={row.flag_reason} />
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-9 px-3 text-xs shrink-0"
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
            </section>
          ) : null}

          {/* Pending Approvals (Devices & Accounts) */}
          {showApprovals ? (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Kicker>{t(locale, "pendingApprovals")}</Kicker>
                  <StatusChip size="sm" variant="neutral">
                    {pendingPeople.length}
                  </StatusChip>
                </div>
              </div>
              <ul className="grid gap-2">
                {pendingPeople.map((p) => (
                  <li key={p.user_id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3">
                    <div>
                      <p className="text-sm font-semibold text-fg">{p.full_name || p.email}</p>
                      <p className="font-mono text-xs text-faint">
                        {p.pending_device_id ? t(locale, "pendingDeviceTitle") : t(locale, "accountPending")}
                      </p>
                      {p.pending_device_id ? (
                        <p className="font-mono text-[11px] text-faint truncate max-w-[200px]" title={p.pending_device_id}>
                          {p.pending_device_id}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      {p.pending_device_id ? (
                        <Button
                          size="sm"
                          className="h-9 px-3 text-xs"
                          onClick={async () => {
                            try {
                              await approveDevice({
                                data: {
                                  userId: p.user_id,
                                  expectedDeviceId: p.pending_device_id!,
                                },
                              });
                            } catch (err: unknown) {
                              const msg = err instanceof Error ? err.message : String(err);
                              if (msg.includes("DEVICE_REQUEST_CHANGED") || msg.includes("NO_PENDING_DEVICE")) {
                                toast.error(t(locale, "deviceRequestChanged"));
                              } else {
                                toast.error(msg);
                              }
                            }
                            refresh();
                          }}
                        >
                          {t(locale, "approveDevice")}
                        </Button>
                      ) : null}
                      {!p.active ? (
                        <Button
                          size="sm"
                          variant={p.pending_device_id ? "outline" : "primary"}
                          className="h-9 px-3 text-xs"
                          onClick={async () => {
                            await setWorkerActive({ data: { userId: p.user_id, active: true } });
                            refresh();
                          }}
                        >
                          {t(locale, "activate")}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}

      {/* Review Request Approval Modal */}
      {reviewModalRequest ? (
        <Sheet
          open={Boolean(reviewModalRequest)}
          onOpenChange={(open) => !open && setReviewModalRequest(null)}
          title={t(locale, "approveRequest")}
        >
          <div className="grid gap-3 text-xs">
            <p className="text-muted leading-relaxed">
              {t(locale, "confirmManualEntryDesc")}
            </p>
            <div className="rounded-xl border border-line bg-elevated p-3 space-y-1.5">
              <div className="flex justify-between">
                <span className="text-muted">{t(locale, "people")}</span>
                <span className="font-semibold text-fg">{reviewModalRequest.full_name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">{t(locale, "site")}</span>
                <span className="font-semibold text-fg">{reviewModalRequest.site_name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">{t(locale, "eventType")}</span>
                <span className="font-medium text-fg">
                  {reviewModalRequest.type === "check_in" ? t(locale, "checkIn") : t(locale, "checkOut")}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">{t(locale, "actualTime")}</span>
                <span className="font-mono text-fg">
                  {new Date(reviewModalRequest.attempted_at).toLocaleString(locale === "ar" ? "ar-EG" : "en-US")}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">{t(locale, "reasonForRequest")}</span>
                <span className="text-fg italic truncate max-w-[200px]">"{reviewModalRequest.reason}"</span>
              </div>
            </div>

            <div className="grid gap-1">
              <label htmlFor="admin-notes" className="font-medium text-fg">
                {t(locale, "adminNotes")}
              </label>
              <textarea
                id="admin-notes"
                rows={2}
                className="w-full rounded-xl border border-line bg-elevated px-3 py-2 text-xs text-fg placeholder:text-muted/60 focus:border-primary focus:outline-none"
                placeholder={t(locale, "adminNotes")}
                value={adminNotes}
                onChange={(e) => setAdminNotes(e.target.value)}
              />
            </div>

            <div className="mt-2 flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1 text-xs"
                onClick={() => setReviewModalRequest(null)}
                disabled={reviewActionPending}
              >
                {t(locale, "cancel")}
              </Button>
              <Button
                type="button"
                className="flex-1 text-xs"
                disabled={reviewActionPending}
                onClick={async () => {
                  setReviewActionPending(true);
                  try {
                    await reviewAttendanceRequest({
                      data: {
                        requestId: reviewModalRequest.id,
                        decision: "approve",
                        adminNotes: adminNotes.trim() || undefined,
                      },
                    });
                    toast.success(t(locale, "requestApproved"));
                    setReviewModalRequest(null);
                    refresh();
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Failed to approve request");
                  } finally {
                    setReviewActionPending(false);
                  }
                }}
              >
                {reviewActionPending ? t(locale, "submitting") : t(locale, "approveRequest")}
              </Button>
            </div>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}

function People({ locale, home }: { locale: Locale; home: HomeData }) {
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [mobileListOpen, setMobileListOpen] = useState(false);
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
      <div className={selected && !mobileListOpen ? "hidden lg:block" : "block"}>
        <div className="flex items-center justify-between gap-3">
          <h1 className="font-display text-2xl font-semibold">{t(locale, "people")}</h1>
        </div>
        {selected && mobileListOpen ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 text-xs lg:hidden"
            onClick={() => setMobileListOpen(false)}
          >
            ← {t(locale, "viewDetails")}
          </Button>
        ) : null}
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
                  onClick={() => {
                    setSelected(row.user_id);
                    setMobileListOpen(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-start ${
                    selected === row.user_id ? "bg-elevated" : "hover:bg-surface"
                  }`}
                >
                  <span>
                    <span className="block text-sm font-medium">{row.full_name}</span>
                    <span className="font-mono text-xs text-faint">{loginName(row)}</span>
                  </span>
                  <span className={`text-xs ${row.active ? "text-ok" : "text-warn"}`}>
                    {row.active ? "ok" : "off"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        {/* Mobile active employee bar (< lg) */}
        {selected && !mobileListOpen ? (
          <div className="mb-4 flex items-center justify-between rounded-xl border border-primary/30 bg-primary/5 p-3.5 lg:hidden">
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-muted">{t(locale, "selectedWorker")}</p>
              <p className="font-semibold text-sm text-fg truncate">
                {detail.data?.user.full_name ?? selected}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs shrink-0"
              onClick={() => setMobileListOpen(true)}
            >
              {t(locale, "backToList")}
            </Button>
          </div>
        ) : null}

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
  const [revealedPass, setRevealedPass] = useState("");
  const today = cairoDate();
  const uname = loginName(u);
  return (
    <Panel className="grid gap-4">
      <div>
        <h2 className="font-display text-xl font-semibold">{u.full_name}</h2>
        <p className="font-mono text-xs text-muted">{u.email}</p>
      </div>
      <div className="rounded-xl border border-line bg-elevated p-3">
        <Kicker>{t(locale, "loginAs")}</Kicker>
        <div className="mt-2 flex items-center justify-between gap-2">
          <div>
            <p className="text-[11px] uppercase tracking-widest text-faint">{t(locale, "username")}</p>
            <p className="font-mono text-sm font-medium">{uname}</p>
          </div>
          <Button type="button" variant="ghost" className="h-9 px-2" onClick={() => void copyText(uname, t(locale, "copied"))}>
            <Copy className="size-3.5" />
            <span className="sr-only">{t(locale, "copy")}</span>
          </Button>
        </div>
        <p className="mt-2 text-xs text-faint">{t(locale, "passwordHidden")}</p>
        {revealedPass ? (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-ok/30 bg-bg px-3 py-2">
            <div>
              <p className="font-mono text-sm font-medium">{revealedPass}</p>
              <p className="text-[11px] text-ok">{t(locale, "passwordOnce")}</p>
            </div>
            <Button type="button" variant="ghost" className="h-9 px-2" onClick={() => void copyText(revealedPass, t(locale, "copied"))}>
              <Copy className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Stat label={t(locale, "daysPresent")} value={`${data.monthly.daysPresent}/${data.monthly.daysInMonth}`} />
        <Stat label={t(locale, "monthlyHours")} value={`${data.hours.totalHours}h`} />
      </div>
      <div className="flex flex-wrap gap-2">
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
        <Button
          variant="danger"
          onClick={async () => {
            if (!window.confirm(t(locale, "confirmDeleteWorker"))) return;
            try {
              await deleteWorker({ data: { userId: u.user_id } });
              toast.success(t(locale, "workerDeleted"));
              onDone();
            } catch (e) {
              const msg = e instanceof Error ? e.message : "";
              if (msg.startsWith("HAS_ATTENDANCE_HISTORY")) {
                // Deleting is blocked by default because it also erases
                // payroll/attendance history — offer that as an explicit,
                // separate choice instead of silently just deactivating.
                if (window.confirm(t(locale, "confirmForceDeleteWorker"))) {
                  await deleteWorker({ data: { userId: u.user_id, force: true } });
                  toast.success(t(locale, "workerDeleted"));
                } else {
                  toast.error(t(locale, "workerHasHistoryDeactivated"));
                  await setWorkerActive({ data: { userId: u.user_id, active: false } });
                }
                onDone();
              } else {
                toast.error(msg || "Failed");
              }
            }
          }}
        >
          {t(locale, "deleteWorkerPermanently")}
        </Button>
      </div>
      <div className="flex gap-2">
        <input
          className="h-11 flex-1 rounded-lg border border-line bg-elevated px-3 text-sm"
          type="text"
          autoComplete="off"
          placeholder={t(locale, "newPassword")}
          value={newPass}
          onChange={(e) => setNewPass(e.target.value)}
        />
        <Button type="button" variant="ghost" onClick={() => setNewPass(randomPassword())}>
          {t(locale, "generatePassword")}
        </Button>
        <Button
          variant="outline"
          disabled={newPass.length < 8}
          onClick={async () => {
            await resetWorkerPassword({ data: { userId: u.user_id, newPassword: newPass } });
            setRevealedPass(newPass);
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

function dateNDaysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function startOfWeekIso() {
  const d = new Date();
  const day = d.getDay(); // 0 = Sunday
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}
function startOfMonthIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function Attendance({ locale }: { locale: Locale }) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [from, setFrom] = useState(dateNDaysAgo(30));
  const [to, setTo] = useState(todayIso());
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [mobileWorkerListOpen, setMobileWorkerListOpen] = useState(false);
  const [mapPunch, setMapPunch] = useState<{
    lat: number;
    lng: number;
    site_name: string;
    created_at: string;
    type: string;
  } | null>(null);

  // Manual attendance entry state
  const [manualOpen, setManualOpen] = useState(false);
  const [manualStep, setManualStep] = useState<"form" | "confirm">("form");
  const [manualUserId, setManualUserId] = useState("");
  const [manualSiteId, setManualSiteId] = useState<number | "">("");
  const [manualType, setManualType] = useState<"check_in" | "check_out">("check_in");
  const [manualDate, setManualDate] = useState(cairoDate());
  const [manualTime, setManualTime] = useState(() => cairoTimeStr());
  const [manualReason, setManualReason] = useState("");
  const [manualSubmitting, setManualSubmitting] = useState(false);

  // Reversal state
  const [reversalPunch, setReversalPunch] = useState<{
    id: number;
    site_name: string;
    type: string;
    time: string;
  } | null>(null);
  const [reversalReason, setReversalReason] = useState("");
  const [reversalSubmitting, setReversalSubmitting] = useState(false);

  const overview = useQuery({
    queryKey: ["htn-overview"],
    queryFn: () => adminOverview(),
  });

  const list = useQuery({
    queryKey: ["htn-workers", q],
    queryFn: () => listWorkers({ data: { q, includeInactive: true } }),
  });

  const sites = useQuery({
    queryKey: ["htn-sites"],
    queryFn: () => listSites(),
  });

  const history = useQuery({
    queryKey: ["htn-worker-attendance", selected?.id, from, to],
    queryFn: () => workerAttendanceHistory({ data: { userId: selected!.id, from, to } }),
    enabled: Boolean(selected),
  });

  const applyWorkerDefaults = (uid: string) => {
    // 1. Check overview todayPunches (loaded via loadTodayPunches, which includes today's punches and open shifts)
    const latestToday = overview.data?.todayPunches?.find((p) => p.user_id === uid);
    if (latestToday) {
      setManualType(latestToday.type === "check_in" ? "check_out" : "check_in");
      if ("site_id" in latestToday && latestToday.site_id) {
        setManualSiteId(latestToday.site_id as number);
      } else if (latestToday.site_name) {
        const matchingSite = sites.data?.rows?.find((s) => s.name === latestToday.site_name);
        if (matchingSite) setManualSiteId(matchingSite.id);
      }
      return;
    }

    // 2. Fallback: check selected worker history if this worker is selected
    if (selected?.id === uid && history.data?.days?.length) {
      for (const d of history.data.days) {
        const nonReversed = d.punches.filter((p) => !p.is_reversed);
        if (nonReversed.length > 0) {
          const last = nonReversed[nonReversed.length - 1];
          if (last.type === "check_in") {
            setManualType("check_out");
            const matchingSite = sites.data?.rows?.find((s) => s.name === last.site_name);
            if (matchingSite) setManualSiteId(matchingSite.id);
            return;
          }
          break;
        }
      }
    }

    // Default to check_in and first site
    setManualType("check_in");
    setManualSiteId(sites.data?.rows[0]?.id ?? "");
  };

  const openManualEntry = (prefillUserId?: string) => {
    const targetUserId = prefillUserId ?? selected?.id ?? list.data?.rows[0]?.user_id ?? "";
    setManualUserId(targetUserId);
    applyWorkerDefaults(targetUserId);
    setManualDate(cairoDate());
    setManualTime(cairoTimeStr());
    setManualReason("");
    setManualStep("form");
    setManualOpen(true);
  };

  const handleManualSubmit = async () => {
    if (!manualUserId || !manualSiteId || !manualDate || !manualTime) return;
    const reason = manualReason.trim();
    if (reason.length < 5) {
      toast.error(t(locale, "reviewReasonRequired"));
      return;
    }
    const actualIso = cairoToIso(manualDate, manualTime);
    setManualSubmitting(true);
    try {
      await createManualAttendance({
        data: {
          userId: manualUserId,
          siteId: Number(manualSiteId),
          type: manualType,
          actualTime: actualIso,
          reason,
        },
      });
      toast.success(t(locale, "saved"));
      setManualOpen(false);
      setManualStep("form");
      setManualReason("");
      void history.refetch();
      void qc.invalidateQueries({ queryKey: ["htn-overview"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to record manual attendance");
    } finally {
      setManualSubmitting(false);
    }
  };

  const handleReversalSubmit = async () => {
    if (!reversalPunch) return;
    const reason = reversalReason.trim();
    if (reason.length < 5) {
      toast.error(t(locale, "reviewReasonRequired"));
      return;
    }
    setReversalSubmitting(true);
    try {
      await reverseManualAttendance({
        data: {
          checkinId: reversalPunch.id,
          reason,
        },
      });
      toast.success(t(locale, "saved"));
      setReversalPunch(null);
      setReversalReason("");
      void history.refetch();
      void qc.invalidateQueries({ queryKey: ["htn-overview"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reverse attendance entry");
    } finally {
      setReversalSubmitting(false);
    }
  };

  const applyPreset = (preset: "today" | "yesterday" | "week" | "month" | "30") => {
    if (preset === "today") {
      setTo(todayIso());
      setFrom(todayIso());
    } else if (preset === "yesterday") {
      const y = dateNDaysAgo(1);
      setTo(y);
      setFrom(y);
    } else if (preset === "week") {
      setTo(todayIso());
      setFrom(startOfWeekIso());
    } else if (preset === "month") {
      setTo(todayIso());
      setFrom(startOfMonthIso());
    } else {
      setTo(todayIso());
      setFrom(dateNDaysAgo(30));
    }
  };

  const downloadCsv = async () => {
    if (!selected) return;
    const { csv, filename } = await workerAttendanceCsv({ data: { userId: selected.id, from, to } });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)]">
      <div className={selected && !mobileWorkerListOpen ? "hidden lg:block" : "block"}>
        <div className="flex items-center justify-between gap-2">
          <h1 className="font-display text-2xl font-semibold">{t(locale, "attendance")}</h1>
          <Button size="sm" onClick={() => openManualEntry()}>
            {t(locale, "addManualPunch")}
          </Button>
        </div>
        {selected && mobileWorkerListOpen ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 text-xs lg:hidden"
            onClick={() => setMobileWorkerListOpen(false)}
          >
            ← {t(locale, "backToList")}
          </Button>
        ) : null}
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
                  onClick={() => {
                    setSelected({ id: row.user_id, name: row.full_name });
                    setOpenDay(null);
                    setMobileWorkerListOpen(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-start ${
                    selected?.id === row.user_id ? "bg-elevated" : "hover:bg-surface"
                  }`}
                >
                  <span>
                    <span className="block text-sm font-medium">{row.full_name}</span>
                    <span className="font-mono text-xs text-faint">{loginName(row)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        {/* Mobile active worker banner (< lg) */}
        {selected && !mobileWorkerListOpen ? (
          <div className="mb-4 flex items-center justify-between rounded-xl border border-primary/30 bg-primary/5 p-3.5 lg:hidden">
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-muted">{t(locale, "selectedWorker")}</p>
              <p className="font-semibold text-sm text-fg truncate">{selected.name}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs shrink-0"
              onClick={() => setMobileWorkerListOpen(true)}
            >
              {t(locale, "changeWorker")}
            </Button>
          </div>
        ) : null}

        {!selected ? (
          <Empty>{t(locale, "attPickWorker")}</Empty>
        ) : (
          <div className="grid gap-4">
            <Panel className="grid gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-lg font-semibold">{selected.name}</h2>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => openManualEntry(selected.id)}>
                    {t(locale, "addManualPunch")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={downloadCsv}>
                    <Download className="me-1.5 size-3.5" />
                    {t(locale, "attDownloadCsv")}
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="grid gap-1 text-xs text-muted">
                  {t(locale, "attFrom")}
                  <input
                    type="date"
                    className="h-10 rounded-lg border border-line bg-elevated px-2 text-sm"
                    value={from}
                    max={to}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </label>
                <label className="grid gap-1 text-xs text-muted">
                  {t(locale, "attTo")}
                  <input
                    type="date"
                    className="h-10 rounded-lg border border-line bg-elevated px-2 text-sm"
                    value={to}
                    min={from}
                    max={todayIso()}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </label>
                <div className="flex flex-wrap gap-1.5">
                  <Button variant="ghost" className="h-9 px-2.5 text-xs" onClick={() => applyPreset("today")}>
                    {t(locale, "attPresetToday")}
                  </Button>
                  <Button variant="ghost" className="h-9 px-2.5 text-xs" onClick={() => applyPreset("yesterday")}>
                    {t(locale, "attPresetYesterday")}
                  </Button>
                  <Button variant="ghost" className="h-9 px-2.5 text-xs" onClick={() => applyPreset("week")}>
                    {t(locale, "attPresetWeek")}
                  </Button>
                  <Button variant="ghost" className="h-9 px-2.5 text-xs" onClick={() => applyPreset("month")}>
                    {t(locale, "attPresetMonth")}
                  </Button>
                  <Button variant="ghost" className="h-9 px-2.5 text-xs" onClick={() => applyPreset("30")}>
                    {t(locale, "attPreset30")}
                  </Button>
                </div>
              </div>
            </Panel>

            {history.isLoading || !history.data ? (
              <Skeleton className="h-64" />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Stat label={t(locale, "attDaysPresent")} value={history.data.summary.daysPresent} />
                  <Stat
                    label={t(locale, "attTotalHours")}
                    value={formatDurationMinutes(Math.round(history.data.summary.totalHours * 60))}
                  />
                  <Stat
                    label={t(locale, "attFlaggedCount")}
                    value={history.data.summary.flaggedCount}
                    warn={history.data.summary.flaggedCount > 0}
                  />
                  <Stat
                    label={t(locale, "attOpenShifts")}
                    value={history.data.summary.openShiftDays}
                    warn={history.data.summary.openShiftDays > 0}
                  />
                </div>

                {/* Attendance Review Requests (Reference / Audit) */}
                {history.data.requests && history.data.requests.length > 0 ? (
                  <div className="rounded-xl border border-line bg-surface p-4">
                    <div className="flex items-center justify-between mb-2">
                      <Kicker>{t(locale, "attendanceRequests")}</Kicker>
                      <span className="text-[11px] text-muted font-mono">{history.data.requests.length} total</span>
                    </div>
                    <ul className="grid gap-2">
                      {history.data.requests.map((r) => (
                        <li
                          key={r.id}
                          className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border border-line/60 bg-elevated px-3 py-2 text-xs"
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-fg">
                                {r.type === "check_in" ? t(locale, "checkIn") : t(locale, "checkOut")} · {r.site_name}
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[10px] font-mono font-medium ${
                                  r.status === "approved"
                                    ? "bg-ok/20 text-ok"
                                    : r.status === "rejected"
                                    ? "bg-bad/20 text-bad"
                                    : "bg-amber-500/20 text-amber-500"
                                }`}
                              >
                                {r.status}
                              </span>
                            </div>
                            <p className="mt-0.5 text-muted font-mono text-[11px]">
                              {new Date(r.attempted_at).toLocaleString(locale === "ar" ? "ar-EG" : "en-US")}
                            </p>
                            <p className="mt-0.5 text-muted italic">"{r.reason}"</p>
                          </div>
                          {r.admin_notes ? (
                            <span className="text-[11px] text-faint max-w-[200px] truncate sm:text-end">
                              Note: {r.admin_notes}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {history.data.days.length === 0 ? (
                  <Empty>{t(locale, "attNoData")}</Empty>
                ) : (
                  <div className="grid gap-2">
                    {history.data.days.map((d) => {
                      const isOpen = openDay === d.day;
                      return (
                        <div key={d.day} className="overflow-hidden rounded-lg border border-line bg-elevated">
                          <button
                            type="button"
                            onClick={() => setOpenDay(isOpen ? null : d.day)}
                            className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-start hover:bg-surface/50 transition-colors"
                          >
                            <div className="flex items-center gap-2.5">
                              {isOpen ? <ChevronDown className="size-4 text-faint" /> : <ChevronRight className="size-4 text-faint" />}
                              <span className="font-mono text-sm font-semibold text-fg">{d.day}</span>
                              <span className="text-xs text-muted truncate max-w-[200px]">{d.siteNames.join(", ")}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              {d.flaggedCount > 0 ? (
                                <StatusChip size="sm" variant="warn">
                                  {d.flaggedCount} {t(locale, "attFlaggedCount").toLowerCase()}
                                </StatusChip>
                              ) : null}
                              {d.openShift ? (
                                <StatusChip size="sm" variant="warn">
                                  {t(locale, "attOpenShift")}
                                </StatusChip>
                              ) : null}
                              <span className="font-mono text-sm font-bold text-fg">
                                {formatDurationMinutes(Math.round(d.hours * 60))}
                              </span>
                            </div>
                          </button>
                          {isOpen ? (
                            <div className="border-t border-line bg-surface/30">
                              {/* Desktop Table View (>= 768px) */}
                              <div className="hidden md:block overflow-x-auto">
                                <table className="w-full text-start text-xs">
                                  <thead>
                                    <tr className="border-b border-line/60 bg-surface/50 text-[11px] uppercase tracking-wider text-muted">
                                      <th className="py-2.5 ps-4 text-start font-semibold">{t(locale, "colType")}</th>
                                      <th className="py-2.5 text-start font-semibold">{t(locale, "site")}</th>
                                      <th className="py-2.5 text-start font-semibold">{t(locale, "colTime")}</th>
                                      <th className="py-2.5 text-start font-semibold">{t(locale, "distance")}</th>
                                      <th className="py-2.5 text-start font-semibold">{t(locale, "accuracy")}</th>
                                      <th className="py-2.5 text-start font-semibold">{t(locale, "colStatus")}</th>
                                      <th className="py-2.5 pe-4 text-end font-semibold">{t(locale, "actions")}</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-line/40">
                                    {d.punches.map((p) => (
                                      <tr key={p.id} className="hover:bg-elevated/40 transition-colors">
                                        <td className="py-2.5 ps-4 font-semibold text-fg">
                                          <div className="flex items-center gap-1.5 flex-wrap">
                                            <span className={`size-2 rounded-full ${p.type === "check_in" ? "bg-ok" : "bg-bad"}`} />
                                            <span>{p.type === "check_in" ? t(locale, "checkIn") : t(locale, "checkOut")}</span>
                                            {p.is_manual ? (
                                              <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-sky-600 dark:text-sky-400">
                                                {t(locale, "manualBadge")}
                                              </span>
                                            ) : null}
                                            {p.is_reversed ? (
                                              <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600 dark:text-rose-400 line-through">
                                                {t(locale, "reversedBadge")}
                                              </span>
                                            ) : null}
                                          </div>
                                        </td>
                                        <td className="py-2.5 text-muted">{p.site_name}</td>
                                        <td className="py-2.5 font-mono text-muted">
                                          {new Date(p.actual_time ?? p.created_at).toLocaleTimeString(locale === "ar" ? "ar-EG" : "en-US")}
                                        </td>
                                        <td className="py-2.5 font-mono text-faint">
                                          {p.is_manual ? "—" : (p.distance_meters != null ? `${Math.round(p.distance_meters)} m` : "—")}
                                        </td>
                                        <td className="py-2.5 font-mono text-faint">
                                          {p.is_manual ? "—" : (p.accuracy_meters != null ? `±${Math.round(p.accuracy_meters)} m` : "—")}
                                        </td>
                                        <td className="py-2.5">
                                          {p.is_manual ? (
                                            <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky-600 dark:text-sky-400">
                                              {t(locale, "manualUnverified")}
                                            </span>
                                          ) : (
                                            <FlagChip reason={p.flag_reason} />
                                          )}
                                        </td>
                                        <td className="py-2.5 pe-4 text-end">
                                          <div className="flex items-center justify-end gap-1">
                                            {!p.is_reversed ? (
                                              <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-7 px-2 text-[11px] text-muted hover:text-rose-600"
                                                onClick={() => {
                                                  setReversalPunch({
                                                    id: p.id,
                                                    site_name: p.site_name,
                                                    type: p.type,
                                                    time: new Date(p.actual_time ?? p.created_at).toLocaleTimeString(
                                                      locale === "ar" ? "ar-EG" : "en-US"
                                                    ),
                                                  });
                                                  setReversalReason("");
                                                }}
                                              >
                                                {t(locale, "reversePunch")}
                                              </Button>
                                            ) : (
                                              <span
                                                className="text-[11px] text-muted italic max-w-[120px] truncate"
                                                title={p.reversal_reason ?? ""}
                                              >
                                                {p.reversal_reason ?? t(locale, "reversedBadge")}
                                              </span>
                                            )}
                                            {!p.is_manual && p.lat && p.lng ? (
                                              <Button
                                                variant="ghost"
                                                size="icon"
                                                className="size-7"
                                                onClick={() =>
                                                  setMapPunch({
                                                    lat: p.lat,
                                                    lng: p.lng,
                                                    site_name: p.site_name,
                                                    created_at: p.actual_time ?? p.created_at,
                                                    type: p.type,
                                                  })
                                                }
                                              >
                                                <MapPin className="size-3.5" />
                                              </Button>
                                            ) : null}
                                          </div>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>

                              {/* Mobile Compact Card View (< 768px) */}
                              <ul className="grid gap-2 p-3 md:hidden">
                                {d.punches.map((p) => (
                                  <li
                                    key={p.id}
                                    className="rounded-lg border border-line/60 bg-surface/60 p-2.5 text-xs space-y-1.5"
                                  >
                                    <div className="flex items-center justify-between">
                                      <div className="flex items-center gap-1.5 font-semibold text-fg flex-wrap">
                                        <span className={`size-2 rounded-full ${p.type === "check_in" ? "bg-ok" : "bg-bad"}`} />
                                        <span>{p.type === "check_in" ? t(locale, "checkIn") : t(locale, "checkOut")}</span>
                                        <span className="text-muted font-normal">· {p.site_name}</span>
                                        {p.is_manual ? (
                                          <span className="rounded bg-sky-500/20 px-1 py-0.2 text-[9px] font-semibold text-sky-600 dark:text-sky-400">
                                            {t(locale, "manualBadge")}
                                          </span>
                                        ) : null}
                                        {p.is_reversed ? (
                                          <span className="rounded bg-rose-500/20 px-1 py-0.2 text-[9px] font-semibold text-rose-600 dark:text-rose-400 line-through">
                                            {t(locale, "reversedBadge")}
                                          </span>
                                        ) : null}
                                      </div>
                                      <span className="font-mono text-faint">
                                        {new Date(p.actual_time ?? p.created_at).toLocaleTimeString(locale === "ar" ? "ar-EG" : "en-US")}
                                      </span>
                                    </div>
                                    <div className="flex items-center justify-between pt-1 border-t border-line/40">
                                      <span className="font-mono text-[11px] text-faint">
                                        {p.is_manual
                                          ? "—"
                                          : `${p.distance_meters != null ? `${Math.round(p.distance_meters)}m` : "—"}${
                                              p.accuracy_meters != null ? ` · ±${Math.round(p.accuracy_meters)}m` : ""
                                            }`}
                                      </span>
                                      <div className="flex items-center gap-1.5">
                                        {p.is_manual ? (
                                          <span className="rounded bg-sky-500/10 px-1 py-0.5 text-[9px] font-semibold text-sky-600 dark:text-sky-400">
                                            {t(locale, "manualUnverified")}
                                          </span>
                                        ) : (
                                          <FlagChip reason={p.flag_reason} />
                                        )}
                                        {!p.is_reversed ? (
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-6 px-1.5 text-[10px] text-muted hover:text-rose-600"
                                            onClick={() => {
                                              setReversalPunch({
                                                id: p.id,
                                                site_name: p.site_name,
                                                type: p.type,
                                                time: new Date(p.actual_time ?? p.created_at).toLocaleTimeString(
                                                  locale === "ar" ? "ar-EG" : "en-US"
                                                ),
                                              });
                                              setReversalReason("");
                                            }}
                                          >
                                            {t(locale, "reversePunch")}
                                          </Button>
                                        ) : null}
                                        {!p.is_manual && p.lat && p.lng ? (
                                          <Button
                                            variant="ghost"
                                            size="icon"
                                            className="size-7"
                                            onClick={() =>
                                              setMapPunch({
                                                lat: p.lat,
                                                lng: p.lng,
                                                site_name: p.site_name,
                                                created_at: p.actual_time ?? p.created_at,
                                                type: p.type,
                                              })
                                            }
                                          >
                                            <MapPin className="size-3.5" />
                                          </Button>
                                        ) : null}
                                      </div>
                                    </div>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Manual Attendance Entry Sheet */}
      {manualOpen ? (
        <Sheet
          open={manualOpen}
          onOpenChange={(open) => {
            if (!open) {
              setManualOpen(false);
              setManualStep("form");
            }
          }}
          title={manualStep === "form" ? t(locale, "addManualPunch") : t(locale, "confirmManualEntryTitle")}
        >
          {manualStep === "form" ? (
            <div className="grid gap-3 text-xs">
              <div className="grid gap-1">
                <label className="font-medium text-fg">{t(locale, "people")}</label>
                <select
                  className="h-10 rounded-lg border border-line bg-elevated px-2 text-xs"
                  value={manualUserId}
                  onChange={(e) => {
                    const uid = e.target.value;
                    setManualUserId(uid);
                    applyWorkerDefaults(uid);
                  }}
                >
                  {(list.data?.rows ?? []).map((w) => (
                    <option key={w.user_id} value={w.user_id}>
                      {w.full_name} ({loginName(w)})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid gap-1">
                <label className="font-medium text-fg">{t(locale, "site")}</label>
                <select
                  className="h-10 rounded-lg border border-line bg-elevated px-2 text-xs"
                  value={manualSiteId}
                  onChange={(e) => setManualSiteId(Number(e.target.value))}
                >
                  {(sites.data?.rows ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid gap-1">
                <label className="font-medium text-fg">{t(locale, "eventType")}</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setManualType("check_in")}
                    className={`flex-1 rounded-lg border py-2 text-xs font-semibold transition-colors ${
                      manualType === "check_in" ? "border-ok bg-ok/10 text-ok" : "border-line bg-elevated text-muted"
                    }`}
                  >
                    {t(locale, "checkIn")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setManualType("check_out")}
                    className={`flex-1 rounded-lg border py-2 text-xs font-semibold transition-colors ${
                      manualType === "check_out" ? "border-bad bg-bad/10 text-bad" : "border-line bg-elevated text-muted"
                    }`}
                  >
                    {t(locale, "checkOut")}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1">
                  <span className="font-medium text-fg">{t(locale, "actualDate")}</span>
                  <input
                    type="date"
                    max={cairoDate()}
                    className="h-10 rounded-lg border border-line bg-elevated px-2 text-xs"
                    value={manualDate}
                    onChange={(e) => setManualDate(e.target.value)}
                  />
                </label>
                <label className="grid gap-1">
                  <span className="font-medium text-fg">{t(locale, "actualTime")}</span>
                  <input
                    type="time"
                    className="h-10 rounded-lg border border-line bg-elevated px-2 text-xs"
                    value={manualTime}
                    onChange={(e) => setManualTime(e.target.value)}
                  />
                </label>
              </div>

              <div className="grid gap-1">
                <label htmlFor="manual-reason" className="font-medium text-fg">
                  {t(locale, "reasonForRequest")}
                </label>
                <textarea
                  id="manual-reason"
                  rows={2}
                  className="w-full rounded-lg border border-line bg-elevated px-3 py-2 text-xs text-fg placeholder:text-muted/60 focus:border-primary focus:outline-none"
                  placeholder={t(locale, "manualPunchReasonPlaceholder")}
                  value={manualReason}
                  onChange={(e) => setManualReason(e.target.value)}
                />
              </div>

              <div className="mt-2 flex gap-2">
                <Button variant="outline" className="flex-1 text-xs" onClick={() => setManualOpen(false)}>
                  {t(locale, "cancel")}
                </Button>
                <Button
                  className="flex-1 text-xs"
                  disabled={!manualUserId || !manualSiteId || !manualDate || !manualTime || manualReason.trim().length < 5}
                  onClick={() => setManualStep("confirm")}
                >
                  {t(locale, "continue")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 text-xs">
              <p className="text-muted leading-relaxed">
                {t(locale, "confirmManualEntryDesc")}
              </p>

              <div className="rounded-xl border border-line bg-elevated p-3 space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-muted">{t(locale, "people")}</span>
                  <span className="font-semibold text-fg">
                    {(list.data?.rows ?? []).find((w) => w.user_id === manualUserId)?.full_name ?? manualUserId}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">{t(locale, "site")}</span>
                  <span className="font-semibold text-fg">
                    {(sites.data?.rows ?? []).find((s) => s.id === Number(manualSiteId))?.name ?? manualSiteId}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">{t(locale, "eventType")}</span>
                  <span className="font-semibold text-fg">
                    {manualType === "check_in" ? t(locale, "checkIn") : t(locale, "checkOut")}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">{t(locale, "actualTime")}</span>
                  <span className="font-mono text-fg">{manualDate} {manualTime}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">{t(locale, "reasonForRequest")}</span>
                  <span className="text-fg italic truncate max-w-[200px]">"{manualReason}"</span>
                </div>
              </div>

              <div className="mt-2 flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1 text-xs"
                  onClick={() => setManualStep("form")}
                  disabled={manualSubmitting}
                >
                  {t(locale, "prev")}
                </Button>
                <Button
                  className="flex-1 text-xs"
                  onClick={handleManualSubmit}
                  disabled={manualSubmitting}
                >
                  {manualSubmitting ? t(locale, "submitting") : t(locale, "confirm")}
                </Button>
              </div>
            </div>
          )}
        </Sheet>
      ) : null}

      {/* Reversal Confirmation Modal */}
      {reversalPunch ? (
        <Sheet
          open={Boolean(reversalPunch)}
          onOpenChange={(open) => !open && setReversalPunch(null)}
          title={t(locale, "reversePunch")}
        >
          <div className="grid gap-3 text-xs">
            <p className="text-muted leading-relaxed">
              {t(locale, "reversalReasonPrompt")}
            </p>

            <div className="rounded-xl border border-line bg-elevated p-3 space-y-1.5">
              <div className="flex justify-between">
                <span className="text-muted">{t(locale, "site")}</span>
                <span className="font-semibold text-fg">{reversalPunch.site_name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">{t(locale, "eventType")}</span>
                <span className="font-medium text-fg">
                  {reversalPunch.type === "check_in" ? t(locale, "checkIn") : t(locale, "checkOut")}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">{t(locale, "colTime")}</span>
                <span className="font-mono text-fg">{reversalPunch.time}</span>
              </div>
            </div>

            <div className="grid gap-1">
              <label htmlFor="reversal-reason" className="font-medium text-fg">
                {t(locale, "reversalReasonPrompt")}
              </label>
              <textarea
                id="reversal-reason"
                rows={2}
                className="w-full rounded-xl border border-line bg-elevated px-3 py-2 text-xs text-fg placeholder:text-muted/60 focus:border-primary focus:outline-none"
                placeholder={t(locale, "reversalReasonPlaceholder")}
                value={reversalReason}
                onChange={(e) => setReversalReason(e.target.value)}
              />
            </div>

            <div className="mt-2 flex gap-2">
              <Button
                variant="outline"
                className="flex-1 text-xs"
                onClick={() => setReversalPunch(null)}
                disabled={reversalSubmitting}
              >
                {t(locale, "cancel")}
              </Button>
              <Button
                variant="danger"
                className="flex-1 text-xs"
                onClick={handleReversalSubmit}
                disabled={reversalSubmitting || reversalReason.trim().length < 5}
              >
                {reversalSubmitting ? t(locale, "submitting") : t(locale, "reversePunch")}
              </Button>
            </div>
          </div>
        </Sheet>
      ) : null}

      {mapPunch ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
          onClick={() => setMapPunch(null)}
        >
          <div
            className="w-full max-w-lg rounded-xl border border-line bg-surface p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">
                {mapPunch.site_name} · {new Date(mapPunch.created_at).toLocaleString(locale === "ar" ? "ar-EG" : "en-US")}
              </p>
              <Button variant="ghost" className="h-8 px-2" onClick={() => setMapPunch(null)}>
                {t(locale, "close")}
              </Button>
            </div>
            <OpsMap
              className="h-72"
              people={[
                {
                  user_id: "punch",
                  full_name: selected?.name ?? "",
                  lat: mapPunch.lat,
                  lng: mapPunch.lng,
                  site_name: mapPunch.site_name,
                  created_at: mapPunch.created_at,
                  punch_type: mapPunch.type,
                },
              ]}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Sites({ locale }: { locale: Locale }) {
  const q = useQuery({ queryKey: ["htn-sites"], queryFn: () => listSites() });
  const groupsQ = useQuery({ queryKey: ["htn-site-groups"], queryFn: () => listSiteGroups() });
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const current = useMemo(
    () => (typeof editing === "number" ? q.data?.rows.find((s) => s.id === editing) : null),
    [editing, q.data],
  );
  const sections = useMemo(() => {
    const rows = q.data?.rows ?? [];
    const map = new Map<string, typeof rows>();
    for (const s of rows) {
      const key = s.group_name ?? t(locale, "ungroupedSites");
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [q.data, locale]);
  if (q.isLoading) return <Skeleton className="h-64" />;
  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl font-semibold">{t(locale, "sites")}</h1>
        <Button variant="outline" onClick={() => setEditing("new")}>
          {t(locale, "createSite")}
        </Button>
      </div>
      <div className="mt-4 grid gap-5">
        {sections.length === 0 ? <Empty>{t(locale, "sites")}</Empty> : null}
        {sections.map(([groupName, rows]) => (
          <div key={groupName}>
            <p className="mb-1.5 px-1 text-xs font-medium uppercase tracking-wide text-faint">
              {groupName} · {rows.length}
            </p>
            <ul className="grid gap-2">
              {rows.map((s) => (
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
                    <span className={s.active ? "text-ok" : "text-bad"}>
                      {s.active ? t(locale, "active") : t(locale, "removed")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {/* Create/edit now opens as a sheet instead of a second column that
          sat below the whole site list — on phones that meant scrolling
          past every site before the form even appeared. */}
      <Sheet
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={editing === "new" ? t(locale, "createSite") : t(locale, "editSite")}
      >
        <SiteForm
          locale={locale}
          groups={groupsQ.data?.rows ?? []}
          initial={
            current ?? {
              id: 0,
              name: "",
              address: "",
              lat: 30.0561,
              lng: 31.3395,
              radius_meters: 200,
              active: true,
              group_id: null,
            }
          }
          isNew={editing === "new"}
          onDone={() => {
            setEditing(null);
            void q.refetch();
          }}
        />
      </Sheet>
    </div>
  );
}

function SiteForm({
  locale,
  initial,
  isNew,
  onDone,
  groups,
}: {
  locale: Locale;
  initial: {
    id: number;
    name: string;
    address: string | null;
    lat: number;
    lng: number;
    radius_meters: number;
    active: boolean;
    group_id?: number | null;
  };
  isNew: boolean;
  onDone: () => void;
  groups: { id: number; name: string; active: boolean }[];
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initial.name);
  const [address, setAddress] = useState(initial.address ?? "");
  const [lat, setLat] = useState(String(initial.lat));
  const [lng, setLng] = useState(String(initial.lng));
  const [radius, setRadius] = useState(String(initial.radius_meters));
  const [active, setActive] = useState(initial.active);
  const [groupId, setGroupId] = useState<number | null>(initial.group_id ?? null);
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [mapsUrl, setMapsUrl] = useState("");
  const latN = Number(lat);
  const lngN = Number(lng);
  const createGroup = useMutation({
    mutationFn: (n: string) => saveSiteGroup({ data: { name: n } }),
    onSuccess: (res) => {
      setGroupId(res.id);
      setNewGroupName("");
      setAddingGroup(false);
      void queryClient.invalidateQueries({ queryKey: ["htn-site-groups"] });
      toast.success(t(locale, "groupCreated"));
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  const applyMaps = useMutation({
    mutationFn: async (raw: string) => {
      const local = parseGoogleMapsUrl(raw);
      if (local) return local;
      if (!needsMapsExpand(raw) && !/^https?:/i.test(raw.trim())) {
        throw new Error("NO_COORDS");
      }
      return resolveMapsLink({ data: { url: raw } });
    },
    onSuccess: (pin) => {
      setLat(pin.lat.toFixed(6));
      setLng(pin.lng.toFixed(6));
      if (pin.name && !name.trim()) setName(pin.name);
      toast.success(`${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`);
    },
    onError: () => toast.error(t(locale, "mapsLinkInvalid")),
  });
  const save = useMutation({
    mutationFn: (nextActive?: boolean) =>
      saveSite({
        data: {
          id: isNew ? undefined : initial.id,
          name,
          address,
          lat: latN,
          lng: lngN,
          radius_meters: Number(radius) || 200,
          active: nextActive ?? active,
          group_id: groupId,
        },
      }),
    onSuccess: (_data, nextActive) => {
      toast.success(nextActive === true ? t(locale, "siteRestored") : t(locale, "saved"));
      onDone();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  const remove = useMutation({
    mutationFn: () => deleteSite({ data: { id: initial.id } }),
    onSuccess: () => {
      toast.success(t(locale, "siteDeleted"));
      onDone();
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : "";
      if (msg.startsWith("HAS_HISTORY") && active) {
        // Can't hard-delete a site with attendance/report history — fall back
        // to deactivating it so it still disappears from active use.
        toast.error(t(locale, "siteHasHistoryDeactivated"));
        setActive(false);
        save.mutate(false);
      } else if (msg.startsWith("HAS_HISTORY")) {
        toast.error(t(locale, "siteHasHistory"));
      } else {
        toast.error(msg || "Failed");
      }
    },
  });
  return (
    <div className="grid gap-3">
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-muted">{t(locale, "mapsLink")}</span>
        <div className="flex gap-2">
          <input
            className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-elevated px-3 text-sm"
            value={mapsUrl}
            onChange={(e) => setMapsUrl(e.target.value)}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (text.trim()) {
                setMapsUrl(text);
                applyMaps.mutate(text);
              }
            }}
            placeholder="https://maps.app.goo.gl/…"
          />
          <Button
            type="button"
            variant="outline"
            disabled={!mapsUrl.trim() || applyMaps.isPending}
            onClick={() => applyMaps.mutate(mapsUrl)}
          >
            {t(locale, "applyLink")}
          </Button>
        </div>
        <span className="text-xs text-faint">{t(locale, "mapsLinkHint")}</span>
      </label>
      <input className="h-11 rounded-lg border border-line bg-elevated px-3 text-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder={t(locale, "name")} />
      <input className="h-11 rounded-lg border border-line bg-elevated px-3 text-sm" value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t(locale, "address")} />
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-muted">{t(locale, "siteGroup")}</span>
        {addingGroup ? (
          <div className="flex gap-2">
            <input
              className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-elevated px-3 text-sm"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder={t(locale, "groupName")}
              autoFocus
            />
            <Button
              type="button"
              variant="outline"
              disabled={!newGroupName.trim() || createGroup.isPending}
              onClick={() => createGroup.mutate(newGroupName)}
            >
              {t(locale, "save")}
            </Button>
            <Button type="button" variant="outline" onClick={() => setAddingGroup(false)}>
              {t(locale, "cancel")}
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <select
              className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-elevated px-3 text-sm"
              value={groupId ?? ""}
              onChange={(e) => setGroupId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">{t(locale, "ungroupedSites")}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <Button type="button" variant="outline" onClick={() => setAddingGroup(true)}>
              {t(locale, "newSiteGroup")}
            </Button>
          </div>
        )}
      </label>
      <div className="grid grid-cols-3 gap-2">
        <input className="h-11 rounded-lg border border-line bg-elevated px-3 font-mono text-sm" value={lat} onChange={(e) => setLat(e.target.value)} placeholder={t(locale, "lat")} />
        <input className="h-11 rounded-lg border border-line bg-elevated px-3 font-mono text-sm" value={lng} onChange={(e) => setLng(e.target.value)} placeholder={t(locale, "lng")} />
        <input className="h-11 rounded-lg border border-line bg-elevated px-3 font-mono text-sm" value={radius} onChange={(e) => setRadius(e.target.value)} placeholder={t(locale, "radius")} />
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
      <div className="flex gap-2">
        <Button disabled={save.isPending} onClick={() => save.mutate(undefined)}>
          {t(locale, "save")}
        </Button>
        {!isNew ? (
          active ? (
            <Button
              variant="outline"
              disabled={save.isPending || remove.isPending}
              onClick={() => {
                if (!window.confirm(t(locale, "confirmRemoveSite"))) return;
                remove.mutate();
              }}
            >
              {t(locale, "removeSite")}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={save.isPending || remove.isPending}
                onClick={() => {
                  setActive(true);
                  save.mutate(true);
                }}
              >
                {t(locale, "restoreSite")}
              </Button>
              <Button
                variant="outline"
                disabled={save.isPending || remove.isPending}
                onClick={() => {
                  if (!window.confirm(t(locale, "confirmDeleteSite"))) return;
                  remove.mutate();
                }}
              >
                {t(locale, "deleteSitePermanently")}
              </Button>
            </>
          )
        ) : null}
      </div>
    </div>
  );
}

function Skills({ locale }: { locale: Locale }) {
  const q = useQuery({ queryKey: ["htn-skills"], queryFn: () => listSkills() });
  const workers = useQuery({
    queryKey: ["htn-workers", "skills"],
    queryFn: () => listWorkers({ data: { pageSize: 500, includeInactive: false } }),
  });
  const sites = useQuery({ queryKey: ["htn-sites"], queryFn: () => listSites() });
  const cover = useQuery({ queryKey: ["htn-coverage"], queryFn: () => skillCoverage() });
  const [siteId, setSiteId] = useState(0);
  const [skillId, setSkillId] = useState(0);
  const [need, setNeed] = useState("1");
  const [listOpen, setListOpen] = useState(true);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  if (q.isLoading) return <Skeleton className="h-64" />;
  const skills = q.data?.skills ?? [];
  const byUser = new Map<string, { name: string; levels: Record<number, number> }>();
  for (const w of q.data?.workers ?? []) {
    const cur = byUser.get(w.user_id) ?? { name: w.full_name, levels: {} };
    cur.levels[w.skill_id] = w.level;
    byUser.set(w.user_id, cur);
  }
  const employeeRows = (workers.data?.rows ?? []).filter((r) => r.role === "employee");
  const groups = new Map<string, typeof employeeRows>();
  for (const w of employeeRows) {
    const letter = (w.full_name.trim()[0] ?? "#").toLocaleUpperCase();
    const key = letter || "#";
    const list = groups.get(key) ?? [];
    list.push(w);
    groups.set(key, list);
  }
  const letters = [...groups.keys()].sort();
  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold">{t(locale, "skills")}</h1>
        <Button type="button" variant="outline" onClick={() => setListOpen((v) => !v)}>
          {listOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          {listOpen ? t(locale, "collapseList") : t(locale, "expandList")}
          <span className="text-faint">
            · {employeeRows.length} {t(locale, "workersCount")}
          </span>
        </Button>
      </div>
      {listOpen ? (
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
            {letters.map((letter) => {
              const rows = groups.get(letter) ?? [];
              const shut = collapsed[letter] === true;
              return (
                <Fragment key={letter}>
                  <tr className="border-t border-line bg-surface">
                    <td colSpan={skills.length + 1} className="px-2 py-1">
                      <button
                        type="button"
                        className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-start text-xs font-semibold uppercase tracking-widest text-muted hover:text-fg"
                        onClick={() => setCollapsed((c) => ({ ...c, [letter]: !shut }))}
                      >
                        {shut ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                        {letter}
                        <span className="font-mono text-faint">{rows.length}</span>
                      </button>
                    </td>
                  </tr>
                  {shut
                    ? null
                    : rows.map((w) => (
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
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      ) : (
        <Empty>
          {employeeRows.length} {t(locale, "workersCount")} — {t(locale, "expandList")}
        </Empty>
      )}
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
  const [statusFilter, setStatusFilter] = useState<"all" | "submitted" | "in_progress" | "resolved">("all");
  const [previewPhoto, setPreviewPhoto] = useState<{ url: string; title: string } | null>(null);

  if (q.isLoading) return <Skeleton className="h-64" />;
  const rows = q.data?.rows ?? [];

  const submittedCount = rows.filter((r) => r.status === "submitted").length;
  const inProgressCount = rows.filter((r) => r.status === "in_progress").length;
  const resolvedCount = rows.filter((r) => r.status === "resolved").length;

  const filteredRows = rows.filter((r) => (statusFilter === "all" ? true : r.status === statusFilter));

  const priorityVariant = (p: string): "bad" | "warn" | "neutral" => {
    if (p === "urgent") return "bad";
    if (p === "high") return "warn";
    return "neutral";
  };

  const priorityLabel = (p: string): string => {
    if (p === "urgent") return t(locale, "priorityUrgent");
    if (p === "high") return t(locale, "priorityHigh");
    if (p === "normal") return t(locale, "priorityNormal");
    return t(locale, "priorityLow");
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold text-fg">{t(locale, "reports")}</h1>
          <p className="font-mono text-xs text-muted">
            {submittedCount} {t(locale, "submittedReports").toLowerCase()} · {rows.length} total
          </p>
        </div>
        {submittedCount > 0 ? (
          <StatusChip size="sm" variant="warn">
            {submittedCount} {t(locale, "attentionNeeded")}
          </StatusChip>
        ) : null}
      </div>

      {/* Status Filter Tabs */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
        <button
          type="button"
          onClick={() => setStatusFilter("all")}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            statusFilter === "all"
              ? "bg-primary text-primary-fg shadow-xs"
              : "bg-surface text-muted hover:bg-elevated hover:text-fg border border-line/60"
          }`}
        >
          <span>{t(locale, "allReports")}</span>
          <span className="font-mono font-bold">{rows.length}</span>
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter("submitted")}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            statusFilter === "submitted"
              ? "bg-primary text-primary-fg shadow-xs"
              : "bg-surface text-muted hover:bg-elevated hover:text-fg border border-line/60"
          }`}
        >
          <span>{t(locale, "submittedReports")}</span>
          {submittedCount > 0 ? (
            <span className="rounded-full bg-warn/20 px-1.5 font-mono text-[10px] font-bold text-warn">
              {submittedCount}
            </span>
          ) : (
            <span className="font-mono text-[10px]">0</span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter("in_progress")}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            statusFilter === "in_progress"
              ? "bg-primary text-primary-fg shadow-xs"
              : "bg-surface text-muted hover:bg-elevated hover:text-fg border border-line/60"
          }`}
        >
          <span>{t(locale, "inProgressReports")}</span>
          <span className="font-mono text-[10px]">{inProgressCount}</span>
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter("resolved")}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            statusFilter === "resolved"
              ? "bg-primary text-primary-fg shadow-xs"
              : "bg-surface text-muted hover:bg-elevated hover:text-fg border border-line/60"
          }`}
        >
          <span>{t(locale, "resolvedReports")}</span>
          <span className="font-mono text-[10px]">{resolvedCount}</span>
        </button>
      </div>

      {filteredRows.length === 0 ? (
        <Empty>{t(locale, "noReports")}</Empty>
      ) : (
        <div className="grid gap-3">
          {filteredRows.map((row) => (
            <Panel key={row.id} className="space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="min-w-0 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm text-fg">{row.title}</span>
                    <StatusChip size="sm" variant={priorityVariant(row.priority)}>
                      {priorityLabel(row.priority)}
                    </StatusChip>
                    <span className="rounded bg-elevated px-2 py-0.5 font-mono text-[10px] font-semibold text-muted uppercase">
                      {row.kind}
                    </span>
                    {row.category ? (
                      <span className="rounded bg-elevated px-2 py-0.5 text-[10px] text-muted">
                        {row.category}
                      </span>
                    ) : null}
                  </div>

                  <p className="text-xs text-muted leading-relaxed break-words">{row.body}</p>

                  <div className="flex items-center gap-2 text-xs font-mono text-faint flex-wrap">
                    <span className="text-fg font-medium">{row.full_name}</span>
                    <span>·</span>
                    <span>{row.site_name ?? "—"}</span>
                    <span>·</span>
                    <span>{new Date(row.created_at).toLocaleString(locale === "ar" ? "ar-EG" : "en-US")}</span>
                  </div>

                  {row.photo_data ? (
                    <button
                      type="button"
                      onClick={() => setPreviewPhoto({ url: row.photo_data!, title: row.title })}
                      className="mt-1 block overflow-hidden rounded-lg border border-line hover:opacity-90 transition-opacity"
                    >
                      <img src={row.photo_data} alt="" className="max-h-36 w-auto object-cover rounded-lg" />
                    </button>
                  ) : null}
                </div>

                <div className="flex shrink-0 flex-row sm:flex-col gap-1.5 self-end sm:self-start">
                  {row.status === "submitted" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={async () => {
                        await reviewReport({ data: { id: row.id, status: "in_progress" } });
                        void q.refetch();
                      }}
                    >
                      {t(locale, "inProgress")}
                    </Button>
                  ) : null}
                  {row.status === "submitted" || row.status === "in_progress" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs font-semibold"
                      onClick={async () => {
                        await reviewReport({ data: { id: row.id, status: "resolved" } });
                        void q.refetch();
                      }}
                    >
                      {t(locale, "resolved")}
                    </Button>
                  ) : (
                    <StatusChip size="sm" variant="ok">
                      {t(locale, "resolved")}
                    </StatusChip>
                  )}
                </div>
              </div>
            </Panel>
          ))}
        </div>
      )}

      {/* Photo Preview Sheet */}
      {previewPhoto ? (
        <Sheet
          open={Boolean(previewPhoto)}
          onOpenChange={(open) => !open && setPreviewPhoto(null)}
          title={previewPhoto.title}
        >
          <div className="grid gap-3">
            <img
              src={previewPhoto.url}
              alt={previewPhoto.title}
              className="w-full rounded-xl object-contain max-h-[70vh] border border-line"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPreviewPhoto(null)}
            >
              {t(locale, "cancel")}
            </Button>
          </div>
        </Sheet>
      ) : null}
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
              <div className="mt-2">
                <StatusChip
                  size="sm"
                  variant={
                    row.status === "approved"
                      ? "ok"
                      : row.status === "denied"
                      ? "bad"
                      : "warn"
                  }
                >
                  {row.status}
                </StatusChip>
              </div>
            </div>
            {row.status === "pending" ? (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={async () => {
                    await reviewLeave({ data: { id: row.id, status: "approved" } });
                    void q.refetch();
                  }}
                >
                  {t(locale, "approve")}
                </Button>
                <Button
                  size="sm"
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
  const rows = q.data?.rows ?? [];

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl font-semibold">{t(locale, "log")}</h1>
        <span className="font-mono text-xs text-muted">
          {rows.length} {t(locale, "log").toLowerCase()}
        </span>
      </div>

      {rows.length === 0 ? (
        <Empty>{t(locale, "emptyTimeline")}</Empty>
      ) : (
        <Panel className="p-0 overflow-hidden">
          {/* Desktop Table View (>= 768px) with Sticky Header */}
          <div className="hidden md:block max-h-[75dvh] overflow-y-auto">
            <table className="w-full text-start text-xs">
              <thead className="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur">
                <tr className="text-[11px] uppercase tracking-wider text-muted">
                  <th className="py-3 ps-4 text-start font-semibold">{t(locale, "logTimestamp")}</th>
                  <th className="py-3 text-start font-semibold">{t(locale, "logActor")}</th>
                  <th className="py-3 text-start font-semibold">{t(locale, "logKind")}</th>
                  <th className="py-3 pe-4 text-start font-semibold">{t(locale, "logDetail")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/40">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-elevated/40 transition-colors">
                    <td className="py-2.5 ps-4 font-mono text-[11px] text-faint whitespace-nowrap">
                      {new Date(row.created_at).toLocaleString(locale === "ar" ? "ar-EG" : "en-US")}
                    </td>
                    <td className="py-2.5 font-medium text-fg whitespace-nowrap">
                      {row.full_name ?? row.user_id}
                    </td>
                    <td className="py-2.5 whitespace-nowrap">
                      <StatusChip size="sm" variant="neutral">
                        {row.kind}
                      </StatusChip>
                    </td>
                    <td className="py-2.5 pe-4 text-muted break-words max-w-md">
                      {row.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile Card List (< 768px) */}
          <ul className="grid gap-2 p-3 md:hidden divide-y divide-line/40">
            {rows.map((row) => (
              <li key={row.id} className="pt-2.5 first:pt-0 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-xs text-fg truncate">
                    {row.full_name ?? row.user_id}
                  </span>
                  <StatusChip size="sm" variant="neutral">
                    {row.kind}
                  </StatusChip>
                </div>
                <p className="text-xs text-muted leading-relaxed break-words">
                  {row.detail}
                </p>
                <p className="font-mono text-[10px] text-faint">
                  {new Date(row.created_at).toLocaleString(locale === "ar" ? "ar-EG" : "en-US")}
                </p>
              </li>
            ))}
          </ul>
        </Panel>
      )}
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
  function downloadXlsx(base64: string, filename: string) {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
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
  const attendanceSheet = useMutation({
    mutationFn: () => exportAttendanceExcel({ data: { from, to } }),
    onSuccess: (res) => downloadXlsx(res.base64, res.filename),
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
      <Button variant="outline" disabled={attendanceSheet.isPending} onClick={() => attendanceSheet.mutate()}>
        {t(locale, "exportAttendanceSheet")}
      </Button>
    </Panel>
  );
}
