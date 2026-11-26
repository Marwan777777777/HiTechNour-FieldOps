import type { Sql } from "../db.ts";
import { decodeImageDataUrl, EvidenceError, normalizeCaptureMeta } from "../evidence-core.ts";
import { haversineMeters } from "../geo.ts";
import type { Actor } from "./tenant.ts";

export type EvidenceInput = {
  purpose: "task" | "report" | "expense";
  taskId?: number | null;
  reportId?: number | null;
  siteId?: number | null;
  dataUrl: string;
  /** Optional client hash; if present it must equal the server's hash. */
  sha256?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracy?: number | null;
  capturedAt?: string | null;
  /** Small free-form device info (watermark text, app version). */
  meta?: Record<string, string | number | boolean | null>;
};

export type StoredEvidence = {
  id: number;
  sha256: string;
  byteSize: number;
  mimeType: string;
  distanceToSiteMeters: number | null;
  receivedAt: string;
  duplicate: boolean;
};

const META_MAX_KEYS = 12;
const META_MAX_LEN = 200;

function cleanMeta(meta: EvidenceInput["meta"]): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!meta || typeof meta !== "object") return out;
  for (const [k, v] of Object.entries(meta).slice(0, META_MAX_KEYS)) {
    if (!/^[a-zA-Z0-9_]{1,40}$/.test(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, META_MAX_LEN);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean" || v === null) out[k] = v;
  }
  return out;
}

/**
 * Store a photo as tamper-evident evidence: verify + hash the decoded bytes,
 * check every referenced row belongs to the caller's tenant (and, for
 * employees, to the caller), compute the server's own distance to the site.
 * Re-uploading the same image for the same task/report returns the existing
 * row (`duplicate: true`) instead of creating a second one.
 */
export async function storeEvidence(sql: Sql, actor: Actor, input: EvidenceInput): Promise<StoredEvidence> {
  if (!["task", "report", "expense"].includes(input.purpose)) throw new EvidenceError("BAD_PURPOSE");
  const image = decodeImageDataUrl(input.dataUrl);
  if (input.sha256 && input.sha256.toLowerCase() !== image.sha256) throw new EvidenceError("HASH_MISMATCH");
  const capture = normalizeCaptureMeta(input);

  let taskId: number | null = null;
  let reportId: number | null = null;
  let siteId: number | null = input.siteId ?? null;

  if (input.purpose === "task") {
    if (!input.taskId) throw new EvidenceError("TASK_REQUIRED");
    const rows = await sql<{ id: number; site_id: number | null; assignee_id: string | null }>`
      select id, site_id, assignee_id from tasks
      where id = ${input.taskId} and tenant_id = ${actor.tenantId}`;
    const task = rows[0];
    if (!task) throw new EvidenceError("TASK_NOT_FOUND");
    if (actor.role !== "admin" && task.assignee_id !== actor.userId) throw new EvidenceError("FORBIDDEN");
    taskId = task.id;
    siteId = task.site_id ?? siteId;
  } else if (input.purpose === "report") {
    if (!input.reportId) throw new EvidenceError("REPORT_REQUIRED");
    const rows = await sql<{ id: number; site_id: number | null; user_id: string }>`
      select id, site_id, user_id from reports
      where id = ${input.reportId} and tenant_id = ${actor.tenantId}`;
    const report = rows[0];
    if (!report) throw new EvidenceError("REPORT_NOT_FOUND");
    if (actor.role !== "admin" && report.user_id !== actor.userId) throw new EvidenceError("FORBIDDEN");
    reportId = report.id;
    siteId = report.site_id ?? siteId;
  }

  let distance: number | null = null;
  if (siteId != null) {
    const site = await sql<{ lat: number; lng: number }>`
      select lat, lng from sites where id = ${siteId} and tenant_id = ${actor.tenantId}`;
    if (!site[0]) throw new EvidenceError("SITE_NOT_FOUND");
    if (capture.lat != null && capture.lng != null) {
      distance = Math.round(haversineMeters(capture.lat, capture.lng, site[0].lat, site[0].lng));
    }
  }

  if (taskId != null || reportId != null) {
    const dup = await sql<{ id: number; distance_to_site_meters: number | null; received_at: string }>`
      select id, distance_to_site_meters, received_at::text as received_at from evidence_photos
      where sha256 = ${image.sha256}
        and ((${taskId}::int is not null and task_id = ${taskId}::int)
          or (${reportId}::int is not null and report_id = ${reportId}::int))
      limit 1`;
    if (dup[0]) {
      return {
        id: dup[0].id,
        sha256: image.sha256,
        byteSize: image.bytes.length,
        mimeType: image.mime,
        distanceToSiteMeters: dup[0].distance_to_site_meters,
        receivedAt: dup[0].received_at,
        duplicate: true,
      };
    }
  }

  const meta = { ...cleanMeta(input.meta), uploadDelaySeconds: capture.uploadDelaySeconds };
  const inserted = await sql<{ id: number; received_at: string }>`
    insert into evidence_photos (
      tenant_id, user_id, purpose, task_id, report_id, site_id, sha256, mime_type, byte_size,
      data_url, lat, lng, accuracy_meters, distance_to_site_meters, captured_at, client_meta
    ) values (
      ${actor.tenantId}, ${actor.userId}, ${input.purpose}, ${taskId}, ${reportId}, ${siteId},
      ${image.sha256}, ${image.mime}, ${image.bytes.length}, ${input.dataUrl},
      ${capture.lat}, ${capture.lng}, ${capture.accuracy}, ${distance}, ${capture.capturedAt},
      ${JSON.stringify(meta)}::jsonb
    )
    returning id, received_at::text as received_at`;
  await sql`insert into activity_logs (user_id, kind, detail)
    values (${actor.userId}, ${"evidence_upload"}, ${`${input.purpose} #${taskId ?? reportId ?? "-"} sha256:${image.sha256.slice(0, 12)}`})`;
  return {
    id: inserted[0]!.id,
    sha256: image.sha256,
    byteSize: image.bytes.length,
    mimeType: image.mime,
    distanceToSiteMeters: distance,
    receivedAt: inserted[0]!.received_at,
    duplicate: false,
  };
}
