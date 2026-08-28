import { clientEventId } from "@/lib/utils";

const KEY = "htn_offline_checkins";

export type QueuedPunch = {
  siteId: number;
  lat: number;
  lng: number;
  accuracy?: number;
  mock?: boolean;
  deviceId: string;
  type: "check_in" | "check_out";
  clientEventId: string;
  queuedAt: number;
};

function read(): QueuedPunch[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as QueuedPunch[]) : [];
  } catch {
    return [];
  }
}

function write(items: QueuedPunch[]) {
  localStorage.setItem(KEY, JSON.stringify(items.slice(0, 40)));
}

export function queuedCount() {
  return read().length;
}

export function enqueuePunch(payload: Omit<QueuedPunch, "queuedAt" | "clientEventId"> & { clientEventId?: string }) {
  const items = read();
  items.push({
    ...payload,
    clientEventId: payload.clientEventId || clientEventId(),
    queuedAt: Date.now(),
  });
  write(items);
}

export async function flushQueue(send: (item: QueuedPunch) => Promise<unknown>) {
  const items = read();
  if (!items.length) return 0;
  const kept: QueuedPunch[] = [];
  let synced = 0;
  for (const item of items) {
    try {
      await send(item);
      synced += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg === "ALREADY_CHECKED_IN" || msg === "NOT_CHECKED_IN") continue;
      kept.push(item);
    }
  }
  write(kept);
  return synced;
}
