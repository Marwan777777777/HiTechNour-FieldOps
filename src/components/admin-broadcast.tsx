import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Empty, Panel } from "@/components/chrome";
import { Skeleton } from "@/components/ui/skeleton";
import { type Locale, t } from "@/lib/i18n";
import {
  adminListAnnouncements,
  adminListSurveys,
  closeSurvey,
  createAnnouncement,
  createSurvey,
} from "@/lib/server/comms";

export function AdminBroadcast({ locale }: { locale: Locale }) {
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <Announce locale={locale} />
      <Surveys locale={locale} />
    </div>
  );
}

function Announce({ locale }: { locale: Locale }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const q = useQuery({ queryKey: ["htn-announcements"], queryFn: () => adminListAnnouncements() });
  const save = useMutation({
    mutationFn: () => createAnnouncement({ data: { title, body } }),
    onSuccess: () => {
      toast.success(t(locale, "saved"));
      setTitle("");
      setBody("");
      void q.refetch();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  return (
    <div className="grid gap-4">
      <h1 className="font-display text-2xl font-semibold">{t(locale, "announcements")}</h1>
      <Panel className="grid gap-2">
        <input
          className="h-11 rounded-lg border border-line bg-elevated px-3 text-sm"
          placeholder={t(locale, "title")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className="min-h-28 rounded-lg border border-line bg-elevated px-3 py-2 text-sm"
          placeholder={t(locale, "body")}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {t(locale, "publish")}
        </Button>
      </Panel>
      {q.isLoading ? (
        <Skeleton className="h-32" />
      ) : q.data?.rows.length ? (
        <ul className="grid gap-2">
          {q.data.rows.map((row) => (
            <li key={row.id} className="rounded-xl border border-line bg-surface p-3">
              <p className="text-sm font-medium">{row.title}</p>
              <p className="mt-1 text-sm text-muted">{row.body}</p>
              <p className="mt-2 font-mono text-xs text-faint">{new Date(row.created_at).toLocaleString()}</p>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>{t(locale, "noAnnouncements")}</Empty>
      )}
    </div>
  );
}

function Surveys({ locale }: { locale: Locale }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const q = useQuery({ queryKey: ["htn-admin-surveys"], queryFn: () => adminListSurveys() });
  const save = useMutation({
    mutationFn: () => createSurvey({ data: { title, body } }),
    onSuccess: () => {
      toast.success(t(locale, "saved"));
      setTitle("");
      setBody("");
      void q.refetch();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  return (
    <div className="grid gap-4">
      <h1 className="font-display text-2xl font-semibold">{t(locale, "surveys")}</h1>
      <Panel className="grid gap-2">
        <input
          className="h-11 rounded-lg border border-line bg-elevated px-3 text-sm"
          placeholder={t(locale, "title")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className="min-h-28 rounded-lg border border-line bg-elevated px-3 py-2 text-sm"
          placeholder={t(locale, "surveyPrompt")}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {t(locale, "createSurvey")}
        </Button>
      </Panel>
      {q.isLoading ? (
        <Skeleton className="h-32" />
      ) : q.data?.surveys.length ? (
        <ul className="grid gap-2">
          {q.data.surveys.map((s) => {
            const replies = q.data.replies.filter((r) => r.survey_id === s.id);
            return (
              <li key={s.id} className="rounded-xl border border-line bg-surface p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{s.title}</p>
                    <p className="text-sm text-muted">{s.body}</p>
                    <p className="mt-1 font-mono text-xs text-faint">
                      {s.answers} {t(locale, "answers")} · {s.active ? t(locale, "live") : t(locale, "closed")}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    onClick={async () => {
                      await closeSurvey({ data: { id: s.id, active: !s.active } });
                      void q.refetch();
                    }}
                  >
                    {s.active ? t(locale, "closeSurvey") : t(locale, "reopen")}
                  </Button>
                </div>
                {replies.length ? (
                  <button
                    type="button"
                    className="mt-2 text-xs text-muted"
                    onClick={() => setOpenId(openId === s.id ? null : s.id)}
                  >
                    {t(locale, "answers")}
                  </button>
                ) : null}
                {openId === s.id ? (
                  <ul className="mt-2 grid gap-1">
                    {replies.map((r, i) => (
                      <li key={`${s.id}-${i}`} className="rounded-md bg-elevated px-2 py-1.5 text-sm">
                        <span className="font-medium">{r.full_name}</span>
                        <span className="text-muted"> — {r.answer}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty>{t(locale, "noSurveys")}</Empty>
      )}
    </div>
  );
}
