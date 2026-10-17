import { createFileRoute } from "@tanstack/react-router";
import { cairoDate, cairoTimeParts } from "@/lib/geo";
import { getSql } from "@/lib/db";
import { loadDailyReport, renderHtml, secretMatches, sendDailyReport } from "@/lib/server/daily-report";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * GET /api/cron/daily-report   (Vercel cron sends `Authorization: Bearer $CRON_SECRET`)
 *   ?dry=1          preview the HTML in the browser/curl, nothing is sent or logged
 *   ?date=YYYY-MM-DD  report for another day (default: today, Cairo)
 *   ?force=1        send now, ignoring the 18:00 guard and the already-sent log
 */
export const Route = createFileRoute("/api/cron/daily-report")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!process.env.CRON_SECRET) return json({ error: "CRON_SECRET not configured" }, 503);
        if (!secretMatches(request.headers.get("authorization"))) return json({ error: "unauthorized" }, 401);

        const q = new URL(request.url).searchParams;
        const date = q.get("date") && DATE.test(q.get("date")!) ? q.get("date")! : cairoDate();
        const force = q.get("force") === "1";

        if (q.get("dry") === "1") {
          const report = await loadDailyReport(await getSql(), date);
          return new Response(renderHtml(report), { headers: { "content-type": "text/html; charset=utf-8" } });
        }

        // Target run time is 18:00+ Cairo (16:00 UTC in winter UTC+2, 19:00 Cairo in summer UTC+3).
        // 5-minute grace window (>= 17:55) prevents Vercel cron timing jitter from skipping in winter.
        const { hour, minute } = cairoTimeParts();
        const isBefore18Cairo = hour < 17 || (hour === 17 && minute < 55);
        if (!force && isBefore18Cairo) return json({ skipped: "before 18:00 Cairo" });

        try {
          return json(await sendDailyReport(date, { force }));
        } catch (err) {
          console.error("[daily-report] failed:", err);
          return json({ error: String(err instanceof Error ? err.message : err) }, 500);
        }
      },
    },
  },
});
