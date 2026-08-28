import { Bell } from "lucide-react";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Empty, Kicker } from "@/components/chrome";
import { type Locale, t } from "@/lib/i18n";
import { loadNotifications, markNotificationsRead } from "@/lib/server/field";

export function AlertsBell({ locale, unread }: { locale: Locale; unread: number }) {
  const [open, setOpen] = useState(false);
  const notes = useQuery({
    queryKey: ["htn-notes-bell"],
    queryFn: () => loadNotifications(),
    enabled: open,
  });
  const readAll = useMutation({
    mutationFn: () => markNotificationsRead(),
    onSuccess: () => void notes.refetch(),
  });
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
