import type { Sql } from "@/lib/db";
import { sendWebPush } from "./push";

export async function notifyAndPush(
  sql: Sql,
  userIds: string[],
  title: string,
  body: string,
  kind: string,
) {
  const unique = [...new Set(userIds.filter(Boolean))];
  for (const id of unique) {
    await sql`insert into notifications (user_id, title, body, kind)
      values (${id}, ${title.slice(0, 120)}, ${body.slice(0, 240)}, ${kind})`;
  }
  if (unique.length) {
    void sendWebPush(unique, title, body).catch(() => undefined);
  }
}
