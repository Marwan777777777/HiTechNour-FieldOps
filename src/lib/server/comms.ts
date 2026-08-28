import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import type { Profile } from "./types";

async function requireAdmin(userId: string) {
  const sql = await getSql();
  const rows = await sql<Profile>`select * from profiles where user_id = ${userId}`;
  const p = rows[0];
  if (!p || p.role !== "admin" || !p.active) throw new Error("FORBIDDEN");
  return p;
}

export const loadSurveys = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const rows = await sql<{
      id: number;
      title: string;
      body: string;
      answered: boolean;
    }>`
      select s.id, s.title, s.body,
             exists (
               select 1 from survey_answers a
               where a.survey_id = s.id and a.user_id = ${context.userId}
             ) as answered
      from surveys s
      where s.active = true
      order by s.created_at desc`;
    return { rows };
  });

export const answerSurvey = createServerFn({ method: "POST" })
  .validator((d: { surveyId: number; answer: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const answer = data.answer.trim();
    if (!answer || answer.length > 2000) throw new Error("Answer is required (max 2000 chars).");
    const sql = await getSql();
    const me = await sql<Profile>`select * from profiles where user_id = ${context.userId}`;
    if (!me[0]?.active) throw new Error("ACCOUNT_PENDING");
    await sql`
      insert into survey_answers (survey_id, user_id, answer)
      values (${data.surveyId}, ${context.userId}, ${answer})
      on conflict (survey_id, user_id) do update set answer = excluded.answer`;
    return { ok: true };
  });

export const loadAnnouncements = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const me = await sql<Profile>`select * from profiles where user_id = ${context.userId}`;
    if (!me[0]) throw new Error("NO_PROFILE");
    const rows = await sql<{
      id: number;
      title: string;
      body: string;
      created_at: string;
    }>`
      select id, title, body, created_at::text as created_at
      from announcements
      order by created_at desc
      limit 20`;
    return { rows };
  });

export const adminListSurveys = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const surveys = await sql<{
      id: number;
      title: string;
      body: string;
      active: boolean;
      created_at: string;
      answers: number;
    }>`
      select s.id, s.title, s.body, s.active, s.created_at::text as created_at,
             (select count(*)::int from survey_answers a where a.survey_id = s.id) as answers
      from surveys s
      order by s.created_at desc`;
    const replies = await sql<{
      survey_id: number;
      full_name: string;
      answer: string;
      created_at: string;
    }>`
      select a.survey_id, p.full_name, a.answer, a.created_at::text as created_at
      from survey_answers a
      join profiles p on p.user_id = a.user_id
      order by a.created_at desc
      limit 200`;
    return { surveys, replies };
  });

export const createSurvey = createServerFn({ method: "POST" })
  .validator((d: { title: string; body: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const title = data.title.trim();
    const body = data.body.trim();
    if (!title || !body) throw new Error("Title and body are required.");
    const sql = await getSql();
    await sql`insert into surveys (title, body, created_by)
      values (${title}, ${body}, ${context.userId})`;
    await sql`insert into activity_logs (user_id, kind, detail)
      values (${context.userId}, ${"survey"}, ${title})`;
    return { ok: true };
  });

export const closeSurvey = createServerFn({ method: "POST" })
  .validator((d: { id: number; active: boolean }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    await sql`update surveys set active = ${data.active} where id = ${data.id}`;
    return { ok: true };
  });

export const createAnnouncement = createServerFn({ method: "POST" })
  .validator((d: { title: string; body: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const title = data.title.trim();
    const body = data.body.trim();
    if (!title || !body) throw new Error("Title and body are required.");
    const sql = await getSql();
    await sql`insert into announcements (title, body, created_by)
      values (${title}, ${body}, ${context.userId})`;
    const people = await sql<{ user_id: string }>`
      select user_id from profiles where active = true`;
    for (const p of people) {
      await sql`insert into notifications (user_id, title, body, kind)
        values (${p.user_id}, ${title}, ${body.slice(0, 200)}, ${"announcement"})`;
    }
    await sql`insert into activity_logs (user_id, kind, detail)
      values (${context.userId}, ${"announcement"}, ${title})`;
    return { ok: true };
  });

export const adminListAnnouncements = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const rows = await sql<{
      id: number;
      title: string;
      body: string;
      created_at: string;
    }>`
      select id, title, body, created_at::text as created_at
      from announcements order by created_at desc limit 40`;
    return { rows };
  });
