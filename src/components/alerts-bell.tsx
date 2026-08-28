import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Empty, Kicker } from "@/components/chrome";
import { type Locale, t } from "@/lib/i18n";
import { loadNotifications, markNotificationsRead } from "@/lib/server/field";
import { savePushSubscription, vapidPublicKey } from "@/lib/server/push";

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

async function subscribePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return false;
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const { publicKey } = await vapidPublicKey();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;
  await savePushSubscription({
    data: { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
  return true;
}

export function PushNudge({ locale }: { locale: Locale }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission === "default") setShow(true);
  }, []);
  if (!show) return null;
  return (
    <button
      type="button"
      className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-start text-sm text-muted"
      onClick={() => {
        void subscribePush().then((ok) => {
          if (ok) setShow(false);
          else if (typeof Notification !== "undefined" && Notification.permission !== "default") {
            setShow(false);
          }
        });
      }}
    >
      {t(locale, "pushNudge")}
    </button>
  );
}

export function AlertsBell({ locale, unread }: { locale: Locale; unread: number }) {
  const [open, setOpen] = useState(false);
  const [pushState, setPushState] = useState<"off" | "on" | "denied">("off");
  const notes = useQuery({
    queryKey: ["htn-notes-bell"],
    queryFn: () => loadNotifications(),
    enabled: open,
  });
  const readAll = useMutation({
    mutationFn: () => markNotificationsRead(),
    onSuccess: () => void notes.refetch(),
  });

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission === "denied") setPushState("denied");
    else if (Notification.permission === "granted") setPushState("on");
  }, []);

  async function enablePush() {
    const ok = await subscribePush();
    setPushState(ok ? "on" : Notification.permission === "denied" ? "denied" : "off");
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="relative flex size-11 items-center justify-center rounded-full border border-line text-muted"
        onClick={() => setOpen((v) => !v)}
        aria-label={t(locale, "alerts")}
      >
        <Bell className="size-4" />
        {unread > 0 ? (
          <span className="absolute -end-0.5 -top-0.5 min-w-4 rounded-full bg-warn px-1 font-mono text-[10px] text-accent-fg">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="absolute end-0 z-30 mt-2 w-80 rounded-xl border border-line bg-surface p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <Kicker>{t(locale, "alerts")}</Kicker>
            <button type="button" className="text-xs text-muted" onClick={() => readAll.mutate()}>
              {t(locale, "markRead")}
            </button>
          </div>
          {pushState === "on" ? (
            <p className="mb-2 text-xs text-ok">{t(locale, "pushOn")}</p>
          ) : pushState === "denied" ? (
            <p className="mb-2 text-xs text-muted">{t(locale, "pushDenied")}</p>
          ) : (
            <button type="button" className="mb-2 text-xs text-muted underline" onClick={() => void enablePush()}>
              {t(locale, "enablePush")}
            </button>
          )}
          {notes.data?.rows.length ? (
            <ul className="grid max-h-72 gap-2 overflow-auto">
              {notes.data.rows.map((n) => (
                <li key={n.id} className="rounded-lg bg-elevated px-2.5 py-2">
                  <p className="text-sm font-medium">{n.title}</p>
                  <p className="text-xs text-muted">{n.body}</p>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t(locale, "noAlerts")}</Empty>
          )}
        </div>
      ) : null}
    </div>
  );
}
