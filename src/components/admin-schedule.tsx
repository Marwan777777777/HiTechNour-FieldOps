import {
  addDays,
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
import {
  AlertTriangle,
  Building2,
  Calendar,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  FileDown,
  FileText,
  Layers,
  MapPin,
  Printer,
  Search,
  Send,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Empty, Kicker, Panel } from "@/components/chrome";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/ui/status-chip";
import { cairoDate } from "@/lib/geo";
import { type Locale, t } from "@/lib/i18n";
import {
  bulkAssignSite,
  deleteAssignment,
  exportDailyAssignmentSheet,
  getDailyAssignmentPlan,
  listSchedule,
  publishAssignments,
  type AvailableWorker,
  type SiteAssignmentGroup,
} from "@/lib/server/schedule";

type ViewMode = "site" | "overview" | "calendar";

export function AdminSchedule({ locale }: { locale: Locale }) {
  const queryClient = useQueryClient();
  const today = cairoDate();
  const [selectedDate, setSelectedDate] = useState(today);
  const [viewMode, setViewMode] = useState<ViewMode>("site");
  const [selectedSiteId, setSelectedSiteId] = useState<number | null>(null);

  // Modals
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);

  // Queries
  const planQuery = useQuery({
    queryKey: ["htn-daily-plan", selectedDate],
    queryFn: () => getDailyAssignmentPlan({ data: { date: selectedDate } }),
  });

  const dailyData = planQuery.data;
  const sites = useMemo(() => dailyData?.sites ?? [], [dailyData?.sites]);
  const availableWorkers = dailyData?.availableWorkers ?? [];

  // Default selected site to the first site once loaded
  useEffect(() => {
    if (sites.length > 0 && selectedSiteId === null) {
      setSelectedSiteId(sites[0].site_id);
    }
  }, [sites, selectedSiteId]);

  const activeSite = sites.find((s) => s.site_id === selectedSiteId) ?? sites[0];

  // Refresh queries helper
  const refreshAll = () => {
    void planQuery.refetch();
    void queryClient.invalidateQueries({ queryKey: ["htn-schedule"] });
  };

  return (
    <div className="grid gap-5">
      {/* 1. Header & Navigation */}
      <div className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4 shadow-xs md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-semibold tracking-tight text-fg">
              {t(locale, "workforcePlanner")}
            </h1>
            {dailyData && dailyData.draftCount > 0 ? (
              <StatusChip variant="info">
                {dailyData.draftCount} {t(locale, "draftAssignments")}
              </StatusChip>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {t(locale, "dailyPlanSummary")} · {selectedDate}
          </p>
        </div>

        {/* Date Selector & Presets */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-xl border border-line bg-elevated p-1 shadow-2xs">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedDate(format(addDays(new Date(`${selectedDate}T12:00:00`), -1), "yyyy-MM-dd"))}
              aria-label="Previous day"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <input
              type="date"
              className="bg-transparent px-2 font-mono text-sm font-medium text-fg outline-hidden"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedDate(format(addDays(new Date(`${selectedDate}T12:00:00`), 1), "yyyy-MM-dd"))}
              aria-label="Next day"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>

          <Button
            variant={selectedDate === today ? "primary" : "outline"}
            size="sm"
            onClick={() => setSelectedDate(today)}
          >
            {t(locale, "today")}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setSelectedDate(format(addDays(new Date(`${today}T12:00:00`), 1), "yyyy-MM-dd"))}
          >
            {locale === "ar" ? "غداً" : "Tomorrow"}
          </Button>
        </div>

        {/* Action Controls: Publish & Export Sheet */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setShowExportModal(true)}
          >
            <FileText className="size-4 text-accent" />
            {t(locale, "dailyAssignmentSheet")}
          </Button>

          <Button
            variant="primary"
            size="sm"
            className="gap-1.5 font-medium"
            disabled={!dailyData || dailyData.draftCount === 0}
            onClick={() => setShowPublishModal(true)}
          >
            <Send className="size-4" />
            {t(locale, "publishPlan")}
            {dailyData && dailyData.draftCount > 0 ? ` (${dailyData.draftCount})` : ""}
          </Button>
        </div>
      </div>

      {/* 2. Operational Metrics Bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Panel className="p-3">
          <Kicker>{t(locale, "totalWorkers")}</Kicker>
          <p className="mt-1 font-mono text-xl font-bold">{dailyData?.totalWorkers ?? "—"}</p>
        </Panel>
        <Panel className="p-3">
          <Kicker>{t(locale, "assigned")}</Kicker>
          <p className="mt-1 font-mono text-xl font-bold text-ok">{dailyData?.assignedCount ?? "—"}</p>
        </Panel>
        <Panel className="p-3">
          <Kicker>{t(locale, "unassigned")}</Kicker>
          <p className="mt-1 font-mono text-xl font-bold text-muted">{dailyData?.unassignedCount ?? "—"}</p>
        </Panel>
        <Panel className="p-3">
          <Kicker>{t(locale, "sites")}</Kicker>
          <p className="mt-1 font-mono text-xl font-bold text-accent">
            {sites.filter((s) => s.assigned_count > 0).length} / {sites.length}
          </p>
        </Panel>
        <Panel className="p-3">
          <Kicker>{t(locale, "draftAssignments")}</Kicker>
          <p className="mt-1 font-mono text-xl font-bold text-accent">
            {dailyData?.draftCount ?? 0}
          </p>
        </Panel>
      </div>

      {/* 3. View Switcher Tabs */}
      <div className="flex border-b border-line">
        <button
          type="button"
          onClick={() => setViewMode("site")}
          className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            viewMode === "site"
              ? "border-accent text-accent"
              : "border-transparent text-muted hover:text-fg"
          }`}
        >
          <Building2 className="size-4" />
          {t(locale, "siteOrientedView")}
        </button>
        <button
          type="button"
          onClick={() => setViewMode("overview")}
          className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            viewMode === "overview"
              ? "border-accent text-accent"
              : "border-transparent text-muted hover:text-fg"
          }`}
        >
          <Layers className="size-4" />
          {t(locale, "dailyPlanSummary")}
        </button>
        <button
          type="button"
          onClick={() => setViewMode("calendar")}
          className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            viewMode === "calendar"
              ? "border-accent text-accent"
              : "border-transparent text-muted hover:text-fg"
          }`}
        >
          <Calendar className="size-4" />
          {t(locale, "calendarView")}
        </button>
      </div>

      {/* 4. Tab Content */}
      {planQuery.isLoading ? (
        <Skeleton className="h-96" />
      ) : viewMode === "site" ? (
        <SitePlannerView
          locale={locale}
          date={selectedDate}
          sites={sites}
          activeSite={activeSite}
          availableWorkers={availableWorkers}
          onSelectSite={(id) => setSelectedSiteId(id)}
          onRefresh={refreshAll}
        />
      ) : viewMode === "overview" ? (
        <DailyOverviewMatrix
          locale={locale}
          date={selectedDate}
          sites={sites}
          availableWorkers={availableWorkers}
          onSelectSite={(id) => {
            setSelectedSiteId(id);
            setViewMode("site");
          }}
          onRefresh={refreshAll}
        />
      ) : (
        <CalendarMonthView locale={locale} initialDate={selectedDate} onDone={refreshAll} />
      )}

      {/* 5. Modals */}
      {showPublishModal ? (
        <PublishPlanModal
          locale={locale}
          date={selectedDate}
          draftCount={dailyData?.draftCount ?? 0}
          onClose={() => setShowPublishModal(false)}
          onSuccess={() => {
            setShowPublishModal(false);
            refreshAll();
          }}
        />
      ) : null}

      {showExportModal ? (
        <ExportDailySheetModal
          locale={locale}
          date={selectedDate}
          onClose={() => setShowExportModal(false)}
        />
      ) : null}
    </div>
  );
}

// =============================================================================
// Site Planner View (Main Site-Oriented Assignment Engine)
// =============================================================================

function SitePlannerView({
  locale,
  date,
  sites,
  activeSite,
  availableWorkers,
  onSelectSite,
  onRefresh,
}: {
  locale: Locale;
  date: string;
  sites: SiteAssignmentGroup[];
  activeSite?: SiteAssignmentGroup;
  availableWorkers: AvailableWorker[];
  onSelectSite: (id: number) => void;
  onRefresh: () => void;
}) {
  const [siteSearch, setSiteSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");

  // Groups list
  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const s of sites) {
      if (s.group_name) set.add(s.group_name);
    }
    return Array.from(set).sort();
  }, [sites]);

  // Filtered sites
  const filteredSites = useMemo(() => {
    return sites.filter((s) => {
      const matchSearch = s.site_name.toLowerCase().includes(siteSearch.toLowerCase());
      const matchGroup = groupFilter === "all" || s.group_name === groupFilter;
      return matchSearch && matchGroup;
    });
  }, [sites, siteSearch, groupFilter]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
      {/* Left Column: Site Selector */}
      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-xs">
        <div className="flex items-center justify-between">
          <Kicker>{t(locale, "sites")}</Kicker>
          <span className="font-mono text-xs text-muted">
            {filteredSites.length} {t(locale, "sites").toLowerCase()}
          </span>
        </div>

        {/* Site Search & Filter */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" />
          <input
            className="h-10 w-full rounded-xl border border-line bg-elevated pl-9 pr-3 text-xs placeholder:text-muted focus:border-accent focus:outline-hidden"
            placeholder={t(locale, "searchSites")}
            value={siteSearch}
            onChange={(e) => setSiteSearch(e.target.value)}
          />
        </div>

        {groups.length > 0 ? (
          <select
            className="h-9 rounded-lg border border-line bg-elevated px-2.5 text-xs text-fg"
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
          >
            <option value="all">{t(locale, "allGroups")}</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        ) : null}

        {/* Site List */}
        <div className="max-h-[580px] space-y-1.5 overflow-y-auto pr-1">
          {filteredSites.map((site) => {
            const isSelected = activeSite?.site_id === site.site_id;
            const hasDraft = site.assignments.some((a) => a.status === "draft");

            return (
              <button
                key={site.site_id}
                type="button"
                onClick={() => onSelectSite(site.site_id)}
                className={`flex w-full items-start justify-between rounded-xl border p-3 text-start transition-all ${
                  isSelected
                    ? "border-accent bg-elevated shadow-xs"
                    : "border-line bg-surface hover:border-line hover:bg-elevated/40"
                }`}
              >
                <div className="min-w-0 pr-2">
                  <p className="truncate text-sm font-semibold text-fg">{site.site_name}</p>
                  {site.group_name ? (
                    <p className="mt-0.5 text-xs text-muted">{site.group_name}</p>
                  ) : null}
                  {site.address ? (
                    <p className="mt-0.5 truncate text-2xs text-faint">{site.address}</p>
                  ) : null}
                </div>

                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 font-mono text-2xs font-semibold ${
                      site.assigned_count > 0
                        ? "bg-accent/15 text-accent"
                        : "bg-elevated text-muted"
                    }`}
                  >
                    {site.assigned_count}
                  </span>
                  {hasDraft ? (
                    <span className="rounded bg-accent/20 px-1 font-mono text-3xs text-accent">
                      {t(locale, "draftBadge")}
                    </span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right Column: Site Detail & Workforce Assignment Hub */}
      {activeSite ? (
        <SiteAssignmentHub
          locale={locale}
          date={date}
          site={activeSite}
          availableWorkers={availableWorkers}
          onRefresh={onRefresh}
        />
      ) : (
        <Panel className="flex flex-col items-center justify-center p-12 text-center">
          <Building2 className="size-12 text-muted" />
          <p className="mt-3 text-sm text-muted">{t(locale, "selectSiteFirst")}</p>
        </Panel>
      )}
    </div>
  );
}

// =============================================================================
// Site Assignment Hub (Roster on Site + Multi-Employee Assignment Pool)
// =============================================================================

function SiteAssignmentHub({
  locale,
  date,
  site,
  availableWorkers,
  onRefresh,
}: {
  locale: Locale;
  date: string;
  site: SiteAssignmentGroup;
  availableWorkers: AvailableWorker[];
  onRefresh: () => void;
}) {
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [commonTask, setCommonTask] = useState("");
  const [commonNotes, setCommonNotes] = useState("");
  const [overrideConflicts, setOverrideConflicts] = useState(false);
  const [workerSearch, setWorkerSearch] = useState("");
  const [workerFilter, setWorkerFilter] = useState<"all" | "unassigned" | "otherSite" | "leave">("all");

  // Filter available workers
  const filteredWorkers = useMemo(() => {
    return availableWorkers.filter((w) => {
      // Don't show workers already assigned to THIS site in the assignment pool
      if (w.assigned_site_id === site.site_id) return false;

      const matchSearch =
        w.full_name.toLowerCase().includes(workerSearch.toLowerCase()) ||
        (w.title && w.title.toLowerCase().includes(workerSearch.toLowerCase()));

      if (!matchSearch) return false;

      if (workerFilter === "unassigned") return w.assigned_site_id === null && !w.on_leave;
      if (workerFilter === "otherSite") return w.assigned_site_id !== null && w.assigned_site_id !== site.site_id;
      if (workerFilter === "leave") return w.on_leave;
      return true;
    });
  }, [availableWorkers, site.site_id, workerSearch, workerFilter]);

  // Bulk assign mutation
  const assignMutation = useMutation({
    mutationFn: (asDraft: boolean) =>
      bulkAssignSite({
        data: {
          siteId: site.site_id,
          userIds: selectedUserIds,
          date,
          task: commonTask,
          notes: commonNotes,
          asDraft,
          overrideConflicts,
        },
      }),
    onSuccess: (res) => {
      toast.success(
        locale === "ar"
          ? `تم تعيين ${res.assignedCount} موظفاً في ${res.siteName}`
          : `Assigned ${res.assignedCount} workers to ${res.siteName}`,
      );
      setSelectedUserIds([]);
      setCommonTask("");
      setCommonNotes("");
      onRefresh();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Assignment failed");
    },
  });

  // Remove worker mutation
  const removeMutation = useMutation({
    mutationFn: (id: number) => deleteAssignment({ data: { id } }),
    onSuccess: () => {
      toast.success(t(locale, "deleted"));
      onRefresh();
    },
  });

  // Toggle selection
  const toggleUser = (userId: string) => {
    setSelectedUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  };

  // Select all unassigned
  const selectAllUnassigned = () => {
    const unassignedIds = availableWorkers
      .filter((w) => w.assigned_site_id === null && !w.on_leave)
      .map((w) => w.user_id);
    setSelectedUserIds(unassignedIds);
  };

  // Has conflict among selected
  const hasConflict = selectedUserIds.some((id) => {
    const w = availableWorkers.find((u) => u.user_id === id);
    return w && w.assigned_site_id !== null && w.assigned_site_id !== site.site_id;
  });

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
      {/* Left: Active Site Roster */}
      <div className="flex flex-col gap-4">
        {/* Site Header Banner */}
        <div className="rounded-2xl border border-line bg-surface p-4 shadow-xs">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-display text-xl font-bold text-fg">{site.site_name}</h2>
                <StatusChip variant={site.assigned_count > 0 ? "ok" : "neutral"}>
                  {site.assigned_count} {t(locale, "assigned").toLowerCase()}
                </StatusChip>
              </div>
              {site.address ? (
                <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                  <MapPin className="size-3.5 text-accent" />
                  {site.address}
                </p>
              ) : null}
            </div>

            <span className="font-mono text-xs text-muted">
              {t(locale, "date")}: {date}
            </span>
          </div>
        </div>

        {/* Current Site Assignments Table / Cards */}
        <div className="rounded-2xl border border-line bg-surface p-4 shadow-xs">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold text-fg">
              {t(locale, "teamMembers")} ({site.assignments.length})
            </h3>
            {site.assignments.some((a) => a.status === "draft") ? (
              <span className="rounded bg-accent/20 px-2 py-0.5 font-mono text-xs font-semibold text-accent">
                {site.assignments.filter((a) => a.status === "draft").length} {t(locale, "draftBadge")}
              </span>
            ) : null}
          </div>

          {site.assignments.length === 0 ? (
            <Empty>{t(locale, "noWorkersOnSite")}</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {site.assignments.map((a) => (
                <li key={a.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-fg">{a.full_name}</p>
                        <StatusChip variant={a.status === "published" ? "ok" : "info"}>
                          {a.status === "published" ? t(locale, "publishedBadge") : t(locale, "draftBadge")}
                        </StatusChip>
                      </div>

                      <p className="mt-0.5 text-xs text-muted">
                        {a.title || "Technician"}
                        {a.phone ? ` · 📞 ${a.phone}` : ""}
                      </p>

                      {a.task ? (
                        <p className="mt-1.5 text-xs font-medium text-fg">
                          <span className="text-muted">{t(locale, "task")}: </span>
                          {a.task}
                        </p>
                      ) : null}

                      {a.notes ? (
                        <p className="mt-1 text-xs text-muted italic">
                          <span className="font-medium not-italic">{t(locale, "instructions")}: </span>
                          {a.notes}
                        </p>
                      ) : null}

                      {a.assigned_by_name ? (
                        <p className="mt-1 text-2xs text-faint">
                          {t(locale, "assignedTo")} {date} by {a.assigned_by_name}
                        </p>
                      ) : null}
                    </div>

                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => removeMutation.mutate(a.id)}
                      disabled={removeMutation.isPending}
                    >
                      <Trash2 className="size-3.5" />
                      <span className="sr-only sm:not-sr-only sm:ml-1">{t(locale, "remove")}</span>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Right: Available Workforce Pool & Bulk Assignment Form */}
      <div className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4 shadow-xs">
        <div>
          <h3 className="font-display text-base font-semibold text-fg">
            {t(locale, "availableWorkersPool")}
          </h3>
          <p className="text-xs text-muted">
            {t(locale, "bulkAssign")} {site.site_name}
          </p>
        </div>

        {/* Search & Filter */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" />
          <input
            className="h-10 w-full rounded-xl border border-line bg-elevated pl-9 pr-3 text-xs placeholder:text-muted focus:border-accent focus:outline-hidden"
            placeholder={t(locale, "searchWorkers")}
            value={workerSearch}
            onChange={(e) => setWorkerSearch(e.target.value)}
          />
        </div>

        {/* Filter Pills */}
        <div className="flex flex-wrap gap-1 text-xs">
          <button
            type="button"
            onClick={() => setWorkerFilter("all")}
            className={`rounded-lg px-2.5 py-1 ${
              workerFilter === "all" ? "bg-elevated font-semibold text-fg" : "text-muted hover:text-fg"
            }`}
          >
            {locale === "ar" ? "الكل" : "All"} ({availableWorkers.length})
          </button>
          <button
            type="button"
            onClick={() => setWorkerFilter("unassigned")}
            className={`rounded-lg px-2.5 py-1 ${
              workerFilter === "unassigned" ? "bg-elevated font-semibold text-ok" : "text-muted hover:text-fg"
            }`}
          >
            {t(locale, "unassigned")}
          </button>
          <button
            type="button"
            onClick={() => setWorkerFilter("otherSite")}
            className={`rounded-lg px-2.5 py-1 ${
              workerFilter === "otherSite" ? "bg-elevated font-semibold text-accent" : "text-muted hover:text-fg"
            }`}
          >
            {locale === "ar" ? "بمواقع أخرى" : "Other Sites"}
          </button>
          <button
            type="button"
            onClick={() => setWorkerFilter("leave")}
            className={`rounded-lg px-2.5 py-1 ${
              workerFilter === "leave" ? "bg-elevated font-semibold text-warn" : "text-muted hover:text-fg"
            }`}
          >
            {t(locale, "onLeaveBadge")}
          </button>
        </div>

        {/* Quick Selection Buttons */}
        <div className="flex items-center justify-between text-xs">
          <Button variant="ghost" size="sm" onClick={selectAllUnassigned}>
            {t(locale, "selectAll")}
          </Button>
          {selectedUserIds.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setSelectedUserIds([])}>
              {t(locale, "deselectAll")} ({selectedUserIds.length})
            </Button>
          ) : null}
        </div>

        {/* Worker Pool List */}
        <div className="max-h-[300px] space-y-1.5 overflow-y-auto pr-1">
          {filteredWorkers.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted">
              {t(locale, "noUnassignedWorkers")}
            </p>
          ) : (
            filteredWorkers.map((w) => {
              const isSelected = selectedUserIds.includes(w.user_id);
              const isAssignedOther = w.assigned_site_id !== null && w.assigned_site_id !== site.site_id;

              return (
                <div
                  key={w.user_id}
                  onClick={() => toggleUser(w.user_id)}
                  className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-2.5 transition-colors ${
                    isSelected
                      ? "border-accent bg-elevated"
                      : "border-line bg-surface hover:bg-elevated/40"
                  }`}
                >
                  <div className="mt-0.5">
                    {isSelected ? (
                      <CheckSquare className="size-4 text-accent" />
                    ) : (
                      <Square className="size-4 text-muted" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1">
                      <p className="truncate text-xs font-semibold text-fg">{w.full_name}</p>
                      {w.on_leave ? (
                        <span className="rounded bg-warn/15 px-1.5 py-0.5 text-3xs font-semibold text-warn">
                          {t(locale, "onLeaveBadge")}
                        </span>
                      ) : isAssignedOther ? (
                        <span className="truncate rounded bg-accent/15 px-1.5 py-0.5 text-3xs font-semibold text-accent">
                          {w.assigned_site_name}
                        </span>
                      ) : (
                        <span className="rounded bg-ok/15 px-1.5 py-0.5 text-3xs font-semibold text-ok">
                          {locale === "ar" ? "متاح" : "Free"}
                        </span>
                      )}
                    </div>

                    <p className="mt-0.5 text-2xs text-muted">
                      {w.title || "Technician"}
                      {w.skills.length > 0
                        ? ` · ${w.skills.slice(0, 2).map((s) => s.name).join(", ")}`
                        : ""}
                    </p>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Reassignment / Conflict Warning */}
        {hasConflict ? (
          <div className="rounded-xl border border-warn/30 bg-warn/10 p-2.5 text-xs text-fg">
            <div className="flex items-center gap-1.5 font-semibold text-warn">
              <AlertTriangle className="size-4" />
              {t(locale, "conflictWarning")}
            </div>
            <p className="mt-1 text-2xs text-muted leading-relaxed">
              {t(locale, "reassignWarningDesc")}
            </p>
            <label className="mt-2 flex items-center gap-2 font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={overrideConflicts}
                onChange={(e) => setOverrideConflicts(e.target.checked)}
                className="rounded accent-accent"
              />
              <span>{locale === "ar" ? "الموافقة على النقل وتحديث التعيين" : "Confirm transfer & reassign"}</span>
            </label>
          </div>
        ) : null}

        {/* Task & Notes Input Form */}
        <div className="space-y-2 border-t border-line pt-3">
          <input
            className="h-10 w-full rounded-xl border border-line bg-elevated px-3 text-xs placeholder:text-muted focus:border-accent focus:outline-hidden"
            placeholder={t(locale, "taskPlaceholder")}
            value={commonTask}
            onChange={(e) => setCommonTask(e.target.value)}
          />

          <textarea
            className="h-16 w-full rounded-xl border border-line bg-elevated p-2.5 text-xs placeholder:text-muted focus:border-accent focus:outline-hidden"
            placeholder={t(locale, "notesPlaceholder")}
            value={commonNotes}
            onChange={(e) => setCommonNotes(e.target.value)}
          />

          <div className="grid grid-cols-2 gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              disabled={selectedUserIds.length === 0 || assignMutation.isPending || (hasConflict && !overrideConflicts)}
              onClick={() => assignMutation.mutate(true)}
            >
              {t(locale, "saveAsDraft")}
            </Button>

            <Button
              variant="primary"
              size="sm"
              disabled={selectedUserIds.length === 0 || assignMutation.isPending || (hasConflict && !overrideConflicts)}
              onClick={() => assignMutation.mutate(false)}
            >
              {t(locale, "assignAndPublish")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Daily Overview Matrix (Site-by-Site Summary Grid)
// =============================================================================

function DailyOverviewMatrix({
  locale,
  date: _date,
  sites,
  availableWorkers,
  onSelectSite,
  onRefresh: _onRefresh,
}: {
  locale: Locale;
  date: string;
  sites: SiteAssignmentGroup[];
  availableWorkers: AvailableWorker[];
  onSelectSite: (id: number) => void;
  onRefresh: () => void;
}) {
  const activeSites = sites.filter((s) => s.assigned_count > 0);
  const unassignedWorkers = availableWorkers.filter((w) => w.assigned_site_id === null);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      {/* Sites that have assignments */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold text-fg">
            {t(locale, "sites")} ({activeSites.length} of {sites.length} active)
          </h2>
        </div>

        {activeSites.length === 0 ? (
          <Empty>{t(locale, "noJobs")}</Empty>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {activeSites.map((site) => (
              <div
                key={site.site_id}
                className="flex flex-col justify-between rounded-2xl border border-line bg-surface p-4 shadow-xs"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="font-display text-base font-bold text-fg">{site.site_name}</h3>
                      {site.group_name ? (
                        <p className="text-xs text-muted">{site.group_name}</p>
                      ) : null}
                    </div>
                    <StatusChip variant="ok">
                      {site.assigned_count} {t(locale, "assigned").toLowerCase()}
                    </StatusChip>
                  </div>

                  <ul className="mt-3 space-y-1.5 text-xs">
                    {site.assignments.map((a) => (
                      <li
                        key={a.id}
                        className="flex items-center justify-between rounded-lg bg-elevated/60 px-2.5 py-1.5"
                      >
                        <span className="font-medium text-fg">{a.full_name}</span>
                        <span className="font-mono text-2xs text-muted">
                          {a.task || a.title || "Technician"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="mt-4 pt-3 border-t border-line">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-center text-xs"
                    onClick={() => onSelectSite(site.site_id)}
                  >
                    {locale === "ar" ? "تعديل تعيينات الموقع" : "Manage Site Roster"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Unassigned Pool Drawer */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-xs">
        <h3 className="font-display text-base font-semibold text-fg">
          {t(locale, "unassigned")} ({unassignedWorkers.length})
        </h3>
        <p className="text-xs text-muted">{t(locale, "attentionNeeded")}</p>

        <ul className="mt-3 divide-y divide-line max-h-[500px] overflow-y-auto">
          {unassignedWorkers.length === 0 ? (
            <p className="py-4 text-xs text-ok">{t(locale, "noUnassignedWorkers")}</p>
          ) : (
            unassignedWorkers.map((w) => (
              <li key={w.user_id} className="py-2.5 text-xs">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-fg">{w.full_name}</p>
                  {w.on_leave ? (
                    <span className="rounded bg-warn/15 px-1.5 py-0.5 font-mono text-3xs text-warn">
                      {w.leave_kind || t(locale, "onLeaveBadge")}
                    </span>
                  ) : (
                    <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-3xs text-muted">
                      {w.title || "Technician"}
                    </span>
                  )}
                </div>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

// =============================================================================
// Calendar Month View (Retained from original AdminSchedule)
// =============================================================================

function CalendarMonthView({
  locale,
  initialDate,
  onDone,
}: {
  locale: Locale;
  initialDate: string;
  onDone: () => void;
}) {
  const today = cairoDate();
  const [cursor, setCursor] = useState(() => new Date(`${initialDate}T12:00:00`));
  const [selected, setSelected] = useState(initialDate);
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

  const rows = q.data?.rows ?? [];
  const onDay = rows.filter((r) => r.start_date <= selected && r.end_date >= selected);
  const countByDay = (iso: string) => rows.filter((r) => r.start_date <= iso && r.end_date >= iso).length;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)]">
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-xl font-semibold">{format(cursor, "MMMM yyyy")}</h2>
          <div className="flex items-center gap-1">
            <Button variant="ghost" onClick={() => setCursor((c) => addMonths(c, -1))} aria-label="prev">
              <ChevronLeft className="size-4" />
            </Button>
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
        <Panel>
          <Kicker>{t(locale, "assignments")} · {selected}</Kicker>
          {q.isLoading ? (
            <Skeleton className="h-40" />
          ) : onDay.length === 0 ? (
            <Empty>{t(locale, "noJobs")}</Empty>
          ) : (
            <ul className="mt-3 space-y-2">
              {onDay.map((row) => (
                <li
                  key={row.id}
                  className="flex items-start justify-between gap-3 rounded-xl border border-line bg-surface p-3"
                >
                  <div>
                    <p className="text-sm font-medium">{row.full_name}</p>
                    <p className="text-xs text-muted">{row.site_name}</p>
                    {row.task ? <p className="mt-1 text-xs text-fg">{row.task}</p> : null}
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={async () => {
                      await deleteAssignment({ data: { id: row.id } });
                      void q.refetch();
                      onDone();
                    }}
                  >
                    {t(locale, "remove")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

// =============================================================================
// Publish Plan Modal
// =============================================================================

function PublishPlanModal({
  locale,
  date,
  draftCount,
  onClose,
  onSuccess,
}: {
  locale: Locale;
  date: string;
  draftCount: number;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const publishMutation = useMutation({
    mutationFn: () => publishAssignments({ data: { date } }),
    onSuccess: (res) => {
      toast.success(
        locale === "ar"
          ? `تم نشر ${res.publishedCount} تعييناً وإشعار الموظفين بنجاح`
          : `Published ${res.publishedCount} assignments and notified employees`,
      );
      onSuccess();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Publish failed");
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-accent">
            <Send className="size-5" />
            <h3 className="font-display text-lg font-semibold text-fg">
              {t(locale, "publishPlan")}
            </h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-muted hover:text-fg">
            <X className="size-5" />
          </button>
        </div>

        <p className="mt-3 text-sm text-muted leading-relaxed">
          {locale === "ar"
            ? `سيتم نشر ${draftCount} تعييناً مسودة للتاريخ ${date}. سيتلقى كافة الموظفين المعنيين إشعارات فورية على هواتفهم بمواقع عملهم ومهامهم.`
            : `Publishing will activate ${draftCount} draft assignments for ${date}. All assigned employees will receive push notifications with their assigned site, team, and instructions.`}
        </p>

        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" onClick={onClose}>
            {t(locale, "cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={publishMutation.isPending}
            onClick={() => publishMutation.mutate()}
          >
            {publishMutation.isPending ? t(locale, "publishing") : t(locale, "confirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Export Daily Assignment Sheet Modal (Print / PDF / DOCX)
// =============================================================================

function ExportDailySheetModal({
  locale,
  date,
  onClose,
}: {
  locale: Locale;
  date: string;
  onClose: () => void;
}) {
  const sheetQuery = useQuery({
    queryKey: ["htn-export-sheet", date],
    queryFn: () => exportDailyAssignmentSheet({ data: { date } }),
  });

  const data = sheetQuery.data;

  // Print via browser
  const handlePrint = () => {
    if (!data) return;
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      toast.error("Pop-up blocked. Please allow pop-ups to print.");
      return;
    }
    printWindow.document.write(data.html);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
    }, 400);
  };

  // Download DOCX/Word file
  const handleDownloadDoc = () => {
    if (!data) return;
    const blob = new Blob([data.html], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = data.filename;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(locale === "ar" ? "تم تحميل كشف التعيينات" : "Assignment sheet downloaded");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl border border-line bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line p-4">
          <div>
            <h3 className="font-display text-lg font-bold text-fg">
              {t(locale, "dailyAssignmentSheet")}
            </h3>
            <p className="text-xs text-muted">
              {t(locale, "dailyPlanSummary")} · {date}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={handleDownloadDoc}
              disabled={!data}
            >
              <FileDown className="size-4" />
              {t(locale, "exportDocx")}
            </Button>

            <Button
              variant="primary"
              size="sm"
              className="gap-1.5"
              onClick={handlePrint}
              disabled={!data}
            >
              <Printer className="size-4" />
              {t(locale, "printPdf")}
            </Button>

            <button
              type="button"
              onClick={onClose}
              className="ml-2 rounded-lg p-1.5 text-muted hover:text-fg"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        {/* Sheet Preview Body */}
        <div className="flex-1 overflow-y-auto bg-elevated/40 p-4">
          {sheetQuery.isLoading ? (
            <Skeleton className="h-96" />
          ) : data ? (
            <div
              className="mx-auto max-w-2xl rounded-xl border border-line bg-surface p-6 shadow-sm font-sans"
              dangerouslySetInnerHTML={{ __html: data.html }}
            />
          ) : (
            <Empty>{t(locale, "noJobs")}</Empty>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-line p-3 text-xs text-muted">
          <span>
            {data ? `${data.totalSites} sites · ${data.totalWorkersAssigned} employees` : ""}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t(locale, "closeSheet")}
          </Button>
        </div>
      </div>
    </div>
  );
}
