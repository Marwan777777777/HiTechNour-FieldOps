import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { authenticate, errorResponse, json } from "@/lib/server/http";
import { loadLiveMap } from "@/lib/server/live-map";

/**
 * GET /api/v1/sites/live-map
 *
 * Active sites of the caller's organization (coordinates + geofence radius in
 * metres) with the engineers currently checked in at each (check-in time, role,
 * title). Phone numbers are included for admins only. Requires a session.
 */
export const Route = createFileRoute("/api/v1/sites/live-map")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const actor = await authenticate(request);
          const map = await loadLiveMap(await getSql(), actor);
          return json(map, 200, { "cache-control": "private, no-store" });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },
  },
});
