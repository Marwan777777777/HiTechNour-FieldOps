import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { EvidenceError } from "@/lib/evidence-core";
import { storeEvidence, type EvidenceInput } from "@/lib/server/evidence";
import { authenticate, errorResponse, json } from "@/lib/server/http";

const MAX_BODY_BYTES = 2_200_000;

const STATUS: Record<string, number> = {
  FORBIDDEN: 403,
  TASK_NOT_FOUND: 404,
  REPORT_NOT_FOUND: 404,
  SITE_NOT_FOUND: 404,
  IMAGE_TOO_LARGE: 413,
};

/**
 * POST /api/v1/evidence   (application/json)
 *   { purpose: "task"|"report"|"expense", taskId?, reportId?, siteId?,
 *     dataUrl: "data:image/jpeg;base64,...", sha256?, lat?, lng?, accuracy?,
 *     capturedAt?, meta? }
 *
 * Stores a photo with a server-computed SHA-256 of the decoded bytes plus the
 * device GPS/timestamp metadata and the server's own distance to the site.
 */
export const Route = createFileRoute("/api/v1/evidence")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const actor = await authenticate(request);
          if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
            return json({ error: "UNSUPPORTED_MEDIA_TYPE" }, 415);
          }
          const declared = Number(request.headers.get("content-length") ?? 0);
          if (declared > MAX_BODY_BYTES) return json({ error: "IMAGE_TOO_LARGE" }, 413);
          const text = await request.text();
          if (text.length > MAX_BODY_BYTES) return json({ error: "IMAGE_TOO_LARGE" }, 413);
          let body: EvidenceInput;
          try {
            body = JSON.parse(text) as EvidenceInput;
          } catch {
            return json({ error: "BAD_JSON" }, 400);
          }
          if (!body || typeof body !== "object") return json({ error: "BAD_JSON" }, 400);
          const stored = await storeEvidence(await getSql(), actor, body);
          return json(stored, stored.duplicate ? 200 : 201);
        } catch (err) {
          if (err instanceof EvidenceError) return json({ error: err.code }, STATUS[err.code] ?? 400);
          return errorResponse(err);
        }
      },
    },
  },
});
