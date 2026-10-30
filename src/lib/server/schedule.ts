import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, withTransaction } from "@/lib/db";
import { requireAdmin } from "./admin-guard";
import { notifyAndPush } from "./notify";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ScheduleRow = {
  id: number;
  user_id: string;
  full_name: string;
  phone: string | null;
  title: string | null;
  site_id: number;
  site_name: string;
  task: string | null;
  notes: string | null;
  status: "draft" | "published";
  assigned_by: string | null;
  assigned_by_name: string | null;
  start_date: string;
  end_date: string;
  created_at: string;
  updated_at: string;
};

export type SiteAssignmentGroup = {
  site_id: number;
  site_name: string;
  address: string | null;
  group_name: string | null;
  assigned_count: number;
  assignments: {
    id: number;
    user_id: string;
    full_name: string;
    phone: string | null;
    title: string | null;
    task: string | null;
    notes: string | null;
    status: "draft" | "published";
    assigned_by: string | null;
    assigned_by_name: string | null;
    created_at: string;
    updated_at: string;
  }[];
};

export type AvailableWorker = {
  user_id: string;
  full_name: string;
  phone: string | null;
  title: string | null;
  assigned_site_id: number | null;
  assigned_site_name: string | null;
  assignment_id: number | null;
  assignment_status: "draft" | "published" | null;
  on_leave: boolean;
  leave_kind: string | null;
  skills: { name: string; level: number }[];
};

export type DailyPlanData = {
  date: string;
  sites: SiteAssignmentGroup[];
  availableWorkers: AvailableWorker[];
  unassignedCount: number;
  assignedCount: number;
  draftCount: number;
  publishedCount: number;
  totalWorkers: number;
};

export const listSchedule = createServerFn({ method: "GET" })
  .validator((d: { from: string; to: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    if (!DATE.test(data.from) || !DATE.test(data.to)) throw new Error("Invalid date range.");
    const sql = await getSql();
    const rows = await sql<ScheduleRow>`
      select a.id, a.user_id, p.full_name, p.phone, p.title, a.site_id, s.name as site_name,
             a.task, a.notes, coalesce(a.status, 'published') as status,
             a.assigned_by, adm.full_name as assigned_by_name,
             a.start_date::text as start_date, a.end_date::text as end_date,
             a.created_at::text as created_at,
             coalesce(a.updated_at, a.created_at)::text as updated_at
      from assignments a
      join profiles p on p.user_id = a.user_id
      join sites s on s.id = a.site_id
      left join profiles adm on adm.user_id = a.assigned_by
      where a.end_date >= ${data.from}::date and a.start_date <= ${data.to}::date
      order by a.start_date, s.name, p.full_name`;
    return { rows };
  });

export const getDailyAssignmentPlan = createServerFn({ method: "GET" })
  .validator((d: { date: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }): Promise<DailyPlanData> => {
    await requireAdmin(context.userId);
    if (!DATE.test(data.date)) throw new Error("Invalid date format.");
    const sql = await getSql();
    const targetDate = data.date;

    // 1. Fetch active sites with group info
    const sites = await sql<{
      id: number;
      name: string;
      address: string | null;
      group_name: string | null;
    }>`
      select s.id, s.name, s.address, g.name as group_name
      from sites s
      left join site_groups g on g.id = s.group_id
      where s.active = true
      order by g.name nulls last, s.name`;

    // 2. Fetch all active employees
    const workers = await sql<{
      user_id: string;
      full_name: string;
      phone: string | null;
      title: string | null;
    }>`
      select user_id, full_name, phone, title
      from profiles
      where role = 'employee' and active = true
      order by full_name`;

    // 3. Fetch all approved leave for targetDate
    const leave = await sql<{ user_id: string; kind: string }>`
      select user_id, kind
      from leave_requests
      where status = 'approved'
        and start_date <= ${targetDate}::date
        and end_date >= ${targetDate}::date`;
    const leaveByUser = new Map(leave.map((l) => [l.user_id, l.kind]));

    // 4. Fetch worker skills
    const skills = await sql<{ user_id: string; name: string; level: number }>`
      select ws.user_id, s.name, ws.level
      from worker_skills ws
      join skills s on s.id = ws.skill_id
      order by ws.level desc`;
    const skillsByUser = new Map<string, { name: string; level: number }[]>();
    for (const s of skills) {
      const list = skillsByUser.get(s.user_id) ?? [];
      list.push({ name: s.name, level: s.level });
      skillsByUser.set(s.user_id, list);
    }

    // 5. Fetch all assignments active on targetDate
    const assignments = await sql<{
      id: number;
      user_id: string;
      full_name: string;
      phone: string | null;
      title: string | null;
      site_id: number;
      site_name: string;
      task: string | null;
      notes: string | null;
      status: "draft" | "published";
      assigned_by: string | null;
      assigned_by_name: string | null;
      created_at: string;
      updated_at: string;
    }>`
      select a.id, a.user_id, p.full_name, p.phone, p.title,
             a.site_id, s.name as site_name, a.task, a.notes,
             coalesce(a.status, 'published') as status,
             a.assigned_by, adm.full_name as assigned_by_name,
             a.created_at::text as created_at,
             coalesce(a.updated_at, a.created_at)::text as updated_at
      from assignments a
      join profiles p on p.user_id = a.user_id
      join sites s on s.id = a.site_id
      left join profiles adm on adm.user_id = a.assigned_by
      where a.start_date <= ${targetDate}::date
        and a.end_date >= ${targetDate}::date
      order by s.name, p.full_name`;

    // Map assignments by site
    const assignmentsBySite = new Map<number, typeof assignments>();
    const assignedByUser = new Map<string, typeof assignments[0]>();
    let draftCount = 0;
    let publishedCount = 0;

    for (const a of assignments) {
      const list = assignmentsBySite.get(a.site_id) ?? [];
      list.push(a);
      assignmentsBySite.set(a.site_id, list);
      assignedByUser.set(a.user_id, a);
      if (a.status === "draft") draftCount++;
      else publishedCount++;
    }

    // Build site groups
    const siteGroups: SiteAssignmentGroup[] = sites.map((s) => {
      const siteAssigns = assignmentsBySite.get(s.id) ?? [];
      return {
        site_id: s.id,
        site_name: s.name,
        address: s.address,
        group_name: s.group_name,
        assigned_count: siteAssigns.length,
        assignments: siteAssigns.map((a) => ({
          id: a.id,
          user_id: a.user_id,
          full_name: a.full_name,
          phone: a.phone,
          title: a.title,
          task: a.task,
          notes: a.notes,
          status: a.status,
          assigned_by: a.assigned_by,
          assigned_by_name: a.assigned_by_name,
          created_at: a.created_at,
          updated_at: a.updated_at,
        })),
      };
    });

    // Build worker availability pool
    const availableWorkers: AvailableWorker[] = workers.map((w) => {
      const assigned = assignedByUser.get(w.user_id);
      const leaveKind = leaveByUser.get(w.user_id) ?? null;
      return {
        user_id: w.user_id,
        full_name: w.full_name,
        phone: w.phone,
        title: w.title,
        assigned_site_id: assigned?.site_id ?? null,
        assigned_site_name: assigned?.site_name ?? null,
        assignment_id: assigned?.id ?? null,
        assignment_status: assigned?.status ?? null,
        on_leave: leaveKind !== null,
        leave_kind: leaveKind,
        skills: skillsByUser.get(w.user_id) ?? [],
      };
    });

    const assignedCount = assignedByUser.size;
    const unassignedCount = workers.length - assignedCount;

    return {
      date: targetDate,
      sites: siteGroups,
      availableWorkers,
      unassignedCount,
      assignedCount,
      draftCount,
      publishedCount,
      totalWorkers: workers.length,
    };
  });

export const bulkAssignSite = createServerFn({ method: "POST" })
  .validator(
    (d: {
      siteId: number;
      userIds: string[];
      date: string;
      endDate?: string;
      task?: string;
      notes?: string;
      asDraft?: boolean;
      overrideConflicts?: boolean;
    }) => d,
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    if (!DATE.test(data.date)) throw new Error("Invalid start date.");
    const endDate = data.endDate && DATE.test(data.endDate) ? data.endDate : data.date;
    if (endDate < data.date) throw new Error("End date cannot precede start date.");
    if (!data.userIds || data.userIds.length === 0) throw new Error("Select at least one employee.");

    const task = data.task?.trim() || null;
    const notes = data.notes?.trim() || null;
    const status = data.asDraft ? "draft" : "published";

    return withTransaction(async (tx) => {
      const siteRows = await tx<{ name: string }>`select name from sites where id = ${data.siteId}`;
      const site = siteRows[0];
      if (!site) throw new Error("SITE_NOT_FOUND");

      const assignedNames: string[] = [];
      const notificationsToSend: { userId: string; body: string }[] = [];

      for (const userId of data.userIds) {
        // Find existing assignments overlapping with this date range
        const existing = await tx<{ id: number; site_id: number; site_name: string }>`
          select a.id, a.site_id, s.name as site_name
          from assignments a
          join sites s on s.id = a.site_id
          where a.user_id = ${userId}
            and a.start_date <= ${endDate}::date
            and a.end_date >= ${data.date}::date
          for update`;

        if (existing.length > 0) {
          if (!data.overrideConflicts) {
            // If conflict override not allowed and assigned to a different site, skip or throw
            const otherSite = existing.find((e) => e.site_id !== data.siteId);
            if (otherSite) {
              throw new Error(`CONFLICT: Employee already assigned to ${otherSite.site_name}. Enable override to transfer.`);
            }
          }
          // Remove existing overlapping assignments to re-assign cleanly
          for (const ex of existing) {
            await tx`delete from assignments where id = ${ex.id}`;
          }
        }

        // Insert new assignment
        await tx`
          insert into assignments (
            user_id, site_id, task, notes, status, start_date, end_date, assigned_by, updated_at
          ) values (
            ${userId}, ${data.siteId}, ${task}, ${notes}, ${status},
            ${data.date}::date, ${endDate}::date, ${context.userId}, now()
          )`;

        const profile = await tx<{ full_name: string }>`select full_name from profiles where user_id = ${userId}`;
        if (profile[0]) assignedNames.push(profile[0].full_name);

        if (status === "published") {
          const range = endDate !== data.date ? `${data.date} → ${endDate}` : data.date;
          const body = `You are assigned to ${site.name} (${range})${task ? ` · ${task}` : ""}${notes ? ` · Note: ${notes}` : ""}`;
          notificationsToSend.push({ userId, body });
        }
      }

      // Log activity
      await tx`
        insert into activity_logs (user_id, kind, detail)
        values (
          ${context.userId},
          'assignment_bulk_assign',
          ${`Assigned ${assignedNames.length} workers to ${site.name} for ${data.date} (${status}): ${assignedNames.join(", ")}`}
        )`;

      // If published immediately, send notifications
      for (const item of notificationsToSend) {
        await notifyAndPush(tx, [item.userId], "New assignment", item.body, "assignment");
      }

      return { ok: true, assignedCount: assignedNames.length, siteName: site.name };
    });
  });

export const publishAssignments = createServerFn({ method: "POST" })
  .validator((d: { date: string; siteId?: number }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    if (!DATE.test(data.date)) throw new Error("Invalid date.");

    return withTransaction(async (tx) => {
      // Find all draft assignments for target date (and optionally siteId)
      const drafts = await tx<{
        id: number;
        user_id: string;
        full_name: string;
        site_name: string;
        start_date: string;
        end_date: string;
        task: string | null;
        notes: string | null;
      }>`
        select a.id, a.user_id, p.full_name, s.name as site_name,
               a.start_date::text as start_date, a.end_date::text as end_date,
               a.task, a.notes
        from assignments a
        join profiles p on p.user_id = a.user_id
        join sites s on s.id = a.site_id
        where a.status = 'draft'
          and a.start_date <= ${data.date}::date
          and a.end_date >= ${data.date}::date
          and (${data.siteId === undefined} or a.site_id = ${data.siteId ?? 0})
        for update`;

      if (drafts.length === 0) {
        return { ok: true, publishedCount: 0 };
      }

      const draftIds = drafts.map((d) => d.id);
      await tx`
        update assignments
        set status = 'published',
            updated_at = now()
        where id = any(${draftIds})`;

      // Log publishing
      await tx`
        insert into activity_logs (user_id, kind, detail)
        values (
          ${context.userId},
          'assignment_publish',
          ${`Published ${drafts.length} assignments for ${data.date}`}
        )`;

      // Notify workers
      for (const d of drafts) {
        const range = d.end_date !== d.start_date ? `${d.start_date} → ${d.end_date}` : d.start_date;
        const body = `Your assignment at ${d.site_name} (${range}) has been published${d.task ? ` · ${d.task}` : ""}${d.notes ? ` · Note: ${d.notes}` : ""}`;
        await notifyAndPush(tx, [d.user_id], "Assignment Published", body, "assignment");
      }

      return { ok: true, publishedCount: drafts.length };
    });
  });

export const updateAssignmentDetails = createServerFn({ method: "POST" })
  .validator((d: { id: number; task?: string; notes?: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const task = data.task?.trim() || null;
    const notes = data.notes?.trim() || null;

    const updated = await sql<{ id: number; full_name: string; site_name: string }>`
      update assignments a
      set task = ${task},
          notes = ${notes},
          updated_at = now()
      from profiles p, sites s
      where a.id = ${data.id}
        and p.user_id = a.user_id
        and s.id = a.site_id
      returning a.id, p.full_name, s.name as site_name`;

    if (!updated[0]) throw new Error("ASSIGNMENT_NOT_FOUND");

    await sql`
      insert into activity_logs (user_id, kind, detail)
      values (
        ${context.userId},
        'assignment_update',
        ${`Updated assignment #${data.id} (${updated[0].full_name} at ${updated[0].site_name}): ${task ?? "no task"}`}
      )`;

    return { ok: true };
  });

export const upsertAssignment = createServerFn({ method: "POST" })
  .validator(
    (d: {
      id?: number;
      userId: string;
      siteId: number;
      task?: string;
      notes?: string;
      startDate: string;
      endDate: string;
      asDraft?: boolean;
    }) => d,
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    if (!DATE.test(data.startDate) || !DATE.test(data.endDate)) throw new Error("Dates required.");
    if (data.endDate < data.startDate) throw new Error("endDate can't be before startDate.");
    const task = data.task?.trim() || null;
    const notes = data.notes?.trim() || null;
    const status = data.asDraft ? "draft" : "published";
    const sql = await getSql();

    if (data.id) {
      await sql`update assignments set
        user_id = ${data.userId},
        site_id = ${data.siteId},
        task = ${task},
        notes = ${notes},
        status = ${status},
        start_date = ${data.startDate}::date,
        end_date = ${data.endDate}::date,
        updated_at = now()
        where id = ${data.id}`;

      await sql`
        insert into activity_logs (user_id, kind, detail)
        values (${context.userId}, 'assignment_edit', ${`Edited assignment #${data.id}`})`;
    } else {
      await sql`insert into assignments (user_id, site_id, task, notes, status, start_date, end_date, assigned_by, updated_at)
        values (${data.userId}, ${data.siteId}, ${task}, ${notes}, ${status}, ${data.startDate}::date, ${data.endDate}::date, ${context.userId}, now())`;

      await sql`
        insert into activity_logs (user_id, kind, detail)
        values (${context.userId}, 'assignment_create', ${`Created assignment for user ${data.userId} at site ${data.siteId}`})`;

      if (status === "published") {
        const site = await sql<{ name: string }>`select name from sites where id = ${data.siteId}`;
        const range =
          data.endDate !== data.startDate ? `${data.startDate} → ${data.endDate}` : data.startDate;
        const body = `You are assigned to ${site[0]?.name ?? "a site"} (${range})${task ? ` · ${task}` : ""}${notes ? ` · Note: ${notes}` : ""}`;
        await notifyAndPush(sql, [data.userId], "New assignment", body, "assignment");
      }
    }
    return { ok: true };
  });

export const deleteAssignment = createServerFn({ method: "POST" })
  .validator((d: { id: number }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();

    const info = await sql<{ full_name: string; site_name: string; start_date: string }>`
      select p.full_name, s.name as site_name, a.start_date::text as start_date
      from assignments a
      join profiles p on p.user_id = a.user_id
      join sites s on s.id = a.site_id
      where a.id = ${data.id}`;

    await sql`delete from assignments where id = ${data.id}`;

    if (info[0]) {
      await sql`
        insert into activity_logs (user_id, kind, detail)
        values (
          ${context.userId},
          'assignment_delete',
          ${`Deleted assignment #${data.id} for ${info[0].full_name} at ${info[0].site_name} (${info[0].start_date})`}
        )`;
    }
    return { ok: true };
  });

export const exportDailyAssignmentSheet = createServerFn({ method: "GET" })
  .validator((d: { date: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    if (!DATE.test(data.date)) throw new Error("Invalid date.");
    const sql = await getSql();
    const targetDate = data.date;

    const sitesWithAssignments = await sql<{
      site_id: number;
      site_name: string;
      site_address: string | null;
      worker_name: string;
      worker_title: string | null;
      worker_phone: string | null;
      task: string | null;
      notes: string | null;
      status: string;
      assigned_by_name: string | null;
    }>`
      select s.id as site_id, s.name as site_name, s.address as site_address,
             p.full_name as worker_name, p.title as worker_title, p.phone as worker_phone,
             a.task, a.notes, coalesce(a.status, 'published') as status,
             adm.full_name as assigned_by_name
      from assignments a
      join sites s on s.id = a.site_id
      join profiles p on p.user_id = a.user_id
      left join profiles adm on adm.user_id = a.assigned_by
      where a.start_date <= ${targetDate}::date
        and a.end_date >= ${targetDate}::date
      order by s.name, p.full_name`;

    // Group by site
    const grouped = new Map<number, {
      name: string;
      address: string | null;
      workers: {
        name: string;
        title: string | null;
        phone: string | null;
        task: string | null;
        notes: string | null;
        status: string;
        assignedBy: string | null;
      }[];
    }>();

    for (const row of sitesWithAssignments) {
      const g = grouped.get(row.site_id) ?? {
        name: row.site_name,
        address: row.site_address,
        workers: [],
      };
      g.workers.push({
        name: row.worker_name,
        title: row.worker_title,
        phone: row.worker_phone,
        task: row.task,
        notes: row.notes,
        status: row.status,
        assignedBy: row.assigned_by_name,
      });
      grouped.set(row.site_id, g);
    }

    const sitesList = Array.from(grouped.values());

    // Generate Word Document HTML (with page break per site)
    const htmlPages = sitesList.map((site, idx) => `
      <div class="site-page" style="page-break-after: always; padding: 24px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
        <div style="border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 16px;">
          <table style="width: 100%;">
            <tr>
              <td>
                <h1 style="margin: 0; font-size: 20pt; color: #0f172a;">HiTechNour Field Operations</h1>
                <p style="margin: 4px 0 0 0; color: #64748b; font-size: 11pt;">Daily Site Assignment Sheet · ${targetDate}</p>
              </td>
              <td style="text-align: right; vertical-align: top;">
                <span style="display: inline-block; padding: 6px 12px; background: #f1f5f9; border-radius: 6px; font-weight: bold; font-size: 10pt;">
                  Site ${idx + 1} of ${sitesList.length}
                </span>
              </td>
            </tr>
          </table>
        </div>

        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin-bottom: 20px;">
          <table style="width: 100%;">
            <tr>
              <td style="width: 65%;">
                <span style="font-size: 9pt; text-transform: uppercase; color: #64748b; font-weight: bold; letter-spacing: 0.5px;">Site Name</span>
                <h2 style="margin: 2px 0 0 0; font-size: 16pt; color: #0284c7;">${site.name}</h2>
                ${site.address ? `<p style="margin: 4px 0 0 0; font-size: 10pt; color: #475569;">📍 ${site.address}</p>` : ""}
              </td>
              <td style="width: 35%; text-align: right;">
                <span style="font-size: 9pt; text-transform: uppercase; color: #64748b; font-weight: bold; letter-spacing: 0.5px;">Assigned Personnel</span>
                <p style="margin: 2px 0 0 0; font-size: 18pt; font-weight: bold; color: #0f172a;">${site.workers.length} Members</p>
              </td>
            </tr>
          </table>
        </div>

        <h3 style="font-size: 12pt; text-transform: uppercase; color: #334155; margin-bottom: 8px; letter-spacing: 0.5px;">Assigned Team & Tasks</h3>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
          <thead>
            <tr style="background: #0f172a; color: #ffffff; text-align: left; font-size: 9pt;">
              <th style="padding: 10px; border: 1px solid #0f172a;">#</th>
              <th style="padding: 10px; border: 1px solid #0f172a;">Employee Name</th>
              <th style="padding: 10px; border: 1px solid #0f172a;">Role / Title</th>
              <th style="padding: 10px; border: 1px solid #0f172a;">Contact Phone</th>
              <th style="padding: 10px; border: 1px solid #0f172a;">Assigned Task</th>
              <th style="padding: 10px; border: 1px solid #0f172a;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${site.workers.map((w, wIdx) => `
              <tr style="background: ${wIdx % 2 === 0 ? "#ffffff" : "#f8fafc"}; font-size: 10pt;">
                <td style="padding: 8px 10px; border: 1px solid #cbd5e1; text-align: center; font-weight: bold;">${wIdx + 1}</td>
                <td style="padding: 8px 10px; border: 1px solid #cbd5e1; font-weight: 600;">${w.name}</td>
                <td style="padding: 8px 10px; border: 1px solid #cbd5e1; color: #475569;">${w.title || "Technician"}</td>
                <td style="padding: 8px 10px; border: 1px solid #cbd5e1; font-family: monospace;">${w.phone || "—"}</td>
                <td style="padding: 8px 10px; border: 1px solid #cbd5e1;">${w.task || "General Field Ops"}</td>
                <td style="padding: 8px 10px; border: 1px solid #cbd5e1; text-align: center;">
                  <span style="display: inline-block; padding: 2px 8px; font-size: 8pt; font-weight: bold; border-radius: 4px; background: ${w.status === "published" ? "#dcfce7; color: #15803d" : "#fef3c7; color: #b45309"};">
                    ${w.status.toUpperCase()}
                  </span>
                </td>
              </tr>
              ${w.notes ? `
                <tr style="background: ${wIdx % 2 === 0 ? "#ffffff" : "#f8fafc"}; font-size: 9pt; color: #64748b;">
                  <td style="border: 1px solid #cbd5e1;"></td>
                  <td colspan="5" style="padding: 4px 10px; border: 1px solid #cbd5e1;">
                    <em>Instructions: ${w.notes}</em>
                  </td>
                </tr>
              ` : ""}
            `).join("")}
          </tbody>
        </table>

        <div style="border: 1px dashed #cbd5e1; border-radius: 8px; padding: 12px; margin-top: 16px;">
          <h4 style="margin: 0 0 6px 0; font-size: 10pt; color: #475569; text-transform: uppercase;">Site Supervisor / Team Leader Sign-off</h4>
          <table style="width: 100%; margin-top: 12px;">
            <tr>
              <td style="width: 50%; color: #64748b; font-size: 9pt;">
                Signature: __________________________
              </td>
              <td style="width: 50%; color: #64748b; font-size: 9pt; text-align: right;">
                Date & Time: ________________________
              </td>
            </tr>
          </table>
        </div>
      </div>
    `).join("");

    const fullDocHtml = `
      <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
      <head>
        <meta charset='utf-8'>
        <title>HiTechNour Daily Assignment Sheet - ${targetDate}</title>
        <!--[if gte mso 9]>
        <xml>
          <w:WordDocument>
            <w:View>Print</w:View>
            <w:Zoom>100</w:Zoom>
            <w:DoNotOptimizeForBrowser/>
          </w:WordDocument>
        </xml>
        <![endif]-->
        <style>
          @page { size: A4 portrait; margin: 15mm; }
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; }
          .site-page { page-break-after: always; }
          .site-page:last-child { page-break-after: avoid; }
        </style>
      </head>
      <body>
        ${htmlPages.length > 0 ? htmlPages : `<div style="padding: 40px; text-align: center; font-family: sans-serif;"><h2>No site assignments planned for ${targetDate}</h2></div>`}
      </body>
      </html>
    `;

    return {
      date: targetDate,
      totalSites: sitesList.length,
      totalWorkersAssigned: sitesWithAssignments.length,
      html: fullDocHtml,
      base64Doc: Buffer.from(fullDocHtml, "utf8").toString("base64"),
      filename: `daily-assignment-sheet-${targetDate}.doc`,
    };
  });
