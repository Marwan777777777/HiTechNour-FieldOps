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
    actual_time?: string;
    site_name: string;
    is_manual: boolean;
    source: string;
  }>`
    with open_shifts as (
      select distinct on (user_id) id, type
      from checkins
      where is_reversed = false
      order by user_id, actual_time desc, id desc
    )
    select c.id, p.user_id, p.full_name, c.type, c.distance_meters, c.status,
           c.created_at::text as created_at, c.actual_time::text as actual_time, s.name as site_name,
           c.is_manual, c.source
    from checkins c
    join profiles p on p.user_id = c.user_id
    join sites s on s.id = c.site_id
    where c.is_reversed = false
      and ((c.actual_time at time zone 'Africa/Cairo')::date = ${today}::date
       -- keep anyone who never checked out on the list, even from a past day,
       -- so the admin can see them and press "Close shift" manually
       or c.id in (select id from open_shifts where type = 'check_in'))
    order by c.actual_time desc
    limit 200`;
}
