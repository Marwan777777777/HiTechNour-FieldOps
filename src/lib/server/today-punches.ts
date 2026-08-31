import type { Sql } from "@/lib/db";

export async function loadTodayPunches(sql: Sql, today: string) {
  return sql<{
    id: number;
    user_id: string;
    full_name: string;
    type: string;
    distance_meters: number;
    status: string;
    created_at: string;
    site_name: string;
  }>`
    select c.id, p.user_id, p.full_name, c.type, c.distance_meters, c.status,
           c.created_at::text as created_at, s.name as site_name
    from checkins c
    join profiles p on p.user_id = c.user_id
    join sites s on s.id = c.site_id
    where (c.created_at at time zone 'Africa/Cairo')::date = ${today}::date
    order by c.created_at desc
    limit 200`;
}
