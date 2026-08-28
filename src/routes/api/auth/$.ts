import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/lib/auth/server";
import { assertNotLocked, LockedOutError, recordLoginOutcome } from "@/lib/server/lockout";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => auth.handler(request),
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const isEmailSignIn = /sign-in\/email\/?$/i.test(url.pathname);
        if (!isEmailSignIn) return auth.handler(request);

        const clone = request.clone();
        let email = "";
        try {
          const body = (await clone.json()) as { email?: string };
          email = String(body?.email ?? "");
        } catch {
          /* ignore */
        }
        try {
          await assertNotLocked(email);
        } catch (err) {
          const minutes = err instanceof LockedOutError ? err.retryAfterMin : 15;
          return new Response(JSON.stringify({ message: `LOCKED_OUT:${minutes}` }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        const res = await auth.handler(request);
        await recordLoginOutcome(email, res.ok);
        return res;
      },
    },
  },
});
