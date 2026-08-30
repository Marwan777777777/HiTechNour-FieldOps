import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { cairoDate } from "@/lib/geo";
import { requireAdmin } from "./admin-guard";
import type { Profile } from "./types";

function toAuthEmail(username: string) {
  const value = username.trim().toLowerCase();
  if (value.includes("@")) return value;
  return `${value}@hitechnour.local`;
}

export const createWorker = createServerFn({ method: "POST" })
  .validator(
    (d: {
      username: string;
      password: string;
      fullName: string;
      phone?: string;
      role?: "admin" | "employee";
    }) => d,
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const username = data.username.trim();
    const fullName = data.fullName.trim();
    const password = data.password;
    if (!username || !fullName) throw new Error("Username and full name are required.");
    if (password.length < 8) throw new Error("Password must be at least 8 characters.");
    const email = toAuthEmail(username);
    const role = data.role === "admin" ? "admin" : "employee";
    const sql = await getSql();
    const taken = await sql<{ id: string }>`select id from "user" where email = ${email}`;
    if (taken[0]) throw new Error("That username is already taken.");
    const id = randomUUID();
    const hash = await hashPassword(password);
    await sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${id}, ${fullName}, ${email}, ${true}, now(), now())`;
    await sql`insert into "account" (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
      values (${randomUUID()}, ${id}, ${"credential"}, ${id}, ${hash}, now(), now())`;
    await sql`insert into profiles (
        user_id, email, username, full_name, phone, role, active, device_approved
      ) values (
        ${id}, ${email}, ${username.slice(0, 40)}, ${fullName}, ${data.phone?.trim() || null},
        ${role}, ${true}, ${true}
      )`;
    await sql`insert into activity_logs (user_id, kind, detail)
      values (${context.userId}, ${"create_user"}, ${username})`;
    return { ok: true, userId: id };
  });

export const resetWorkerPassword = createServerFn({ method: "POST" })
  .validator((d: { userId: string; newPassword: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    if (data.newPassword.length < 8) throw new Error("Password must be at least 8 characters.");
    const sql = await getSql();
    const hash = await hashPassword(data.newPassword);
    const updated = await sql<{ id: string }>`
      update "account" set password = ${hash}, "updatedAt" = now()
      where "userId" = ${data.userId} and "providerId" = 'credential'
      returning id`;
    if (!updated[0]) {
      await sql`insert into "account" (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
        values (${randomUUID()}, ${data.userId}, ${"credential"}, ${data.userId}, ${hash}, now(), now())`;
    }
    await sql`update profiles set token_version = token_version + 1 where user_id = ${data.userId}`;
    await sql`delete from "session" where "userId" = ${data.userId}`;
    await sql`insert into activity_logs (user_id, kind, detail)
      values (${context.userId}, ${"reset_password"}, ${data.userId})`;
    return { ok: true };
  });

export const setWorkerRole = createServerFn({ method: "POST" })
  .validator((d: { userId: string; role: "admin" | "employee"; title?: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    if (data.userId === context.userId && data.role !== "admin") {
      throw new Error("You cannot demote yourself.");
    }
    const sql = await getSql();
    if (data.role !== "admin") {
      const admins = await sql<{ c: number }>`
        select count(*)::int as c from profiles where role = 'admin' and active = true`;
      const target = await sql<{ role: string }>`select role from profiles where user_id = ${data.userId}`;
      if (target[0]?.role === "admin" && (admins[0]?.c ?? 0) <= 1) {
        throw new Error("Cannot demote the last admin.");
      }
    }
    await sql`update profiles set role = ${data.role}, title = ${data.title ?? null}
      where user_id = ${data.userId}`;
    return { ok: true };
  });

export const teamRoster = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const today = cairoDate();
    const workers = await sql<{
      user_id: string;
      full_name: string;
      title: string | null;
      username: string | null;
    }>`
      select user_id, full_name, title, username from profiles
      where role = 'employee' and active = true
      order by full_name`;
    const assigns = await sql<{ user_id: string; site_name: string }>`
      select a.user_id, s.name as site_name
      from assignments a join sites s on s.id = a.site_id
      where a.start_date <= ${today}::date and a.end_date >= ${today}::date`;
    const skills = await sql<{ user_id: string; name: string; level: number }>`
      select ws.user_id, s.name, ws.level
      from worker_skills ws join skills s on s.id = ws.skill_id
      order by ws.level desc`;
    const monthStart = `${today.slice(0, 7)}-01`;
    const attendance = await sql<{ user_id: string; days: number }>`
      select user_id, count(distinct (created_at at time zone 'Africa/Cairo')::date)::int as days
      from checkins
      where type = 'check_in' and created_at >= ${monthStart}::date
      group by user_id`;
    const siteByUser = new Map(assigns.map((a) => [a.user_id, a.site_name]));
    const skillsByUser = new Map<string, { name: string; level: number }[]>();
    for (const s of skills) {
      const list = skillsByUser.get(s.user_id) ?? [];
      list.push({ name: s.name, level: s.level });
      skillsByUser.set(s.user_id, list);
    }
    const daysByUser = new Map(attendance.map((a) => [a.user_id, a.days]));
    const daysInMonth = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
    const grouped: Record<string, {
      user_id: string;
      full_name: string;
      title: string | null;
      skills: { name: string; level: number }[];
      attendancePct: number;
    }[]> = {};
    for (const w of workers) {
      const site = siteByUser.get(w.user_id) ?? "Unassigned";
      if (!grouped[site]) grouped[site] = [];
      grouped[site].push({
        user_id: w.user_id,
        full_name: w.full_name,
        title: w.title,
        skills: skillsByUser.get(w.user_id) ?? [],
        attendancePct: Math.round(((daysByUser.get(w.user_id) ?? 0) / daysInMonth) * 100),
      });
    }
    return {
      today,
      groups: Object.entries(grouped).map(([siteName, members]) => ({ siteName, members })),
    };
  });

export const setSiteSkillNeed = createServerFn({ method: "POST" })
  .validator((d: { siteId: number; skillId: number; workersNeeded: number }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const needed = Math.max(0, Math.floor(data.workersNeeded));
    const sql = await getSql();
    if (needed === 0) {
      await sql`delete from site_skill_requirements
        where site_id = ${data.siteId} and skill_id = ${data.skillId}`;
    } else {
      await sql`
        insert into site_skill_requirements (site_id, skill_id, workers_needed)
        values (${data.siteId}, ${data.skillId}, ${needed})
        on conflict (site_id, skill_id) do update set workers_needed = ${needed}`;
    }
    return { ok: true };
  });

export const skillCoverage = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const today = cairoDate();
    const rows = await sql<{
      site_id: number;
      site_name: string;
      skill_id: number;
      skill_name: string;
      workers_needed: number;
      covered: number;
    }>`
      select r.site_id, s.name as site_name, r.skill_id, k.name as skill_name, r.workers_needed,
             (
               select count(*)::int
               from assignments a
               join worker_skills ws
                 on ws.user_id = a.user_id and ws.skill_id = r.skill_id and ws.level >= 3
               where a.site_id = r.site_id
                 and a.start_date <= ${today}::date
                 and a.end_date >= ${today}::date
             ) as covered
      from site_skill_requirements r
      join sites s on s.id = r.site_id
      join skills k on k.id = r.skill_id
      order by s.name, k.name`;
    return { rows };
  });
