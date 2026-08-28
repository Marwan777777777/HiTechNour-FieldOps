import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";

type Vapid = { publicKey: string; privateKey: string };

async function loadVapid(): Promise<Vapid> {
  const sql = await getSql();
  const rows = await sql<{ public_key: string; private_key: string }>`
    select public_key, private_key from vapid_keys where id = 1`;
  if (rows[0]) return { publicKey: rows[0].public_key, privateKey: rows[0].private_key };
  const webpush = await import("web-push");
  const keys = webpush.generateVAPIDKeys();
  await sql`
    insert into vapid_keys (id, public_key, private_key)
    values (1, ${keys.publicKey}, ${keys.privateKey})
    on conflict (id) do nothing`;
  const again = await sql<{ public_key: string; private_key: string }>`
    select public_key, private_key from vapid_keys where id = 1`;
  return { publicKey: again[0].public_key, privateKey: again[0].private_key };
}

export const vapidPublicKey = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => {
    const keys = await loadVapid();
    return { publicKey: keys.publicKey };
  });

export const savePushSubscription = createServerFn({ method: "POST" })
  .validator((d: { endpoint: string; p256dh: string; auth: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const endpoint = data.endpoint.trim();
    const p256dh = data.p256dh.trim();
    const auth = data.auth.trim();
    if (!endpoint || !p256dh || !auth) throw new Error("Invalid subscription.");
    if (endpoint.length > 2000 || p256dh.length > 200 || auth.length > 200) {
      throw new Error("Invalid subscription.");
    }
    const sql = await getSql();
    await sql`
      insert into push_subscriptions (user_id, endpoint, p256dh, auth)
      values (${context.userId}, ${endpoint}, ${p256dh}, ${auth})
      on conflict (endpoint) do update set
        user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`;
    return { ok: true };
  });

export async function sendWebPush(userIds: string[], title: string, body: string) {
  if (!userIds.length) return;
  const sql = await getSql();
  const subs = await sql<{ id: number; endpoint: string; p256dh: string; auth: string; user_id: string }>`
    select id, endpoint, p256dh, auth, user_id from push_subscriptions`;
  const wanted = new Set(userIds);
  const mine = subs.filter((s) => wanted.has(s.user_id));
  if (!mine.length) return;
  const keys = await loadVapid();
  const webpush = await import("web-push");
  webpush.setVapidDetails("mailto:ops@hitechnour.local", keys.publicKey, keys.privateKey);
  const payload = JSON.stringify({ title, body, url: "/" });
  for (const sub of mine) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { TTL: 60 * 60 * 12 },
      );
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await sql`delete from push_subscriptions where id = ${sub.id}`;
      }
    }
  }
}
