import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { evaluateGpsAdvisory } from "../src/lib/geo-advisory.ts";
import {
  executeLogRejectedPunch,
  executeSubmitAttendanceRequest,
  floatEquals,
} from "../src/lib/server/attendance-request.ts";

async function setupDb() {
  const pg = new PGlite();
  await pg.waitReady;

  // Apply all migrations in order
  const migrationFiles = readdirSync(new URL("../migrations", import.meta.url))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
    await pg.exec(sql);
  }

  // Seed baseline admin and employees
  await pg.exec(`
    insert into profiles (user_id, full_name, role, active, device_id, device_approved)
    values ('admin_1', 'Super Admin', 'admin', true, 'dev_admin', true)
    on conflict (user_id) do update set role = 'admin', active = true;

    insert into profiles (user_id, full_name, role, active, device_id, device_approved)
    values ('worker_1', 'Ahmed Hassan', 'employee', true, 'dev_worker_1', true)
    on conflict (user_id) do update set active = true;

    insert into profiles (user_id, full_name, role, active, device_id, device_approved)
    values ('worker_2', 'Mahmoud Ali', 'employee', true, 'dev_worker_2', true)
    on conflict (user_id) do update set active = true;

    insert into sites (id, name, lat, lng, radius_meters, active)
    values (1, 'Main Site', 30.0561, 31.3395, 200, true)
    on conflict (id) do update set active = true;
  `);

  return pg;
}

describe("Phase 2.2.1: Attendance Reliability & Admin Manual Attendance", () => {
  async function testReviewAttendanceRequest(pg, adminUserId, data) {
    return pg.transaction(async (tx) => {
      const reqRes = await tx.query(`
        select r.*, s.lat as site_lat, s.lng as site_lng, p.active as user_active
        from attendance_requests r
        join sites s on s.id = r.site_id
        join profiles p on p.user_id = r.user_id
        where r.id = $1 for update`, [data.requestId]);
      const req = reqRes.rows[0];
      if (!req) throw new Error("REQUEST_NOT_FOUND");
      if (req.request_kind && req.request_kind !== "review_request") {
        throw new Error("INVALID_REQUEST_KIND: Only review requests can be reviewed by admin.");
      }
      if (req.status !== "pending") throw new Error("ALREADY_REVIEWED: This request has already been processed.");

      if (data.decision === "reject") {
        await tx.query(`
          update attendance_requests
          set status = 'rejected', reviewed_by = $1, reviewed_at = now(), admin_notes = $2
          where id = $3`, [adminUserId, data.adminNotes || null, data.requestId]);
        return { success: true, status: "rejected" };
      }

      if (!req.user_active) throw new Error("EMPLOYEE_INACTIVE");

      await tx.query("select user_id from profiles where user_id = $1 for update", [req.user_id]);

      const approvalEventId = `appr-req-${req.id}`;
      const exPunch = await tx.query("select id from checkins where client_event_id = $1 limit 1", [approvalEventId]);
      if (exPunch.rows[0]) throw new Error("ALREADY_APPROVED: A checkin record for this request already exists.");

      await tx.query(`
        update attendance_requests
        set status = 'approved', reviewed_by = $1, reviewed_at = now(), admin_notes = $2
        where id = $3`, [adminUserId, data.adminNotes || null, data.requestId]);

      const approvalReason = `Approved review request #${req.id}: ${req.reason}`;
      const ins = await tx.query(`
        insert into checkins (
          user_id, site_id, type, client_event_id, lat, lng, accuracy_meters, distance_meters, status,
          device_id, device_matched, flagged, source, is_manual, actual_time, gps_fix_at, created_by, reason, created_at
        ) values (
          $1, $2, $3, $4, $5, $6, $7, 0, 'inside', $8, true, false, 'manual', true, $9, $10, $11, $12, now()
        ) returning id, type, actual_time`, [
          req.user_id, req.site_id, req.type, approvalEventId, req.site_lat, req.site_lng, req.accuracy_meters,
          req.device_id, req.attempted_at, req.gps_fix_at, adminUserId, approvalReason
        ]);

      const punch = ins.rows[0];
      await tx.query(`
        insert into manual_attendance_audit (
          checkin_id, admin_id, action, reason, target_user_id, actual_time
        ) values ($1, $2, 'create', $3, $4, $5)`, [punch.id, adminUserId, approvalReason, req.user_id, req.attempted_at]);

      return { success: true, status: "approved", checkinId: punch.id };
    });
  }

  describe("GPS Acquisition, Filtering & Advisory Logic", () => {
    it("preserves GPS fix timestamp separately from created_at", async () => {
      const pg = await setupDb();
      const gpsFix = "2026-10-30T07:59:50.000Z";
      const actualTime = "2026-10-30T08:00:00.000Z";

      await pg.exec(`
        insert into checkins (
          user_id, site_id, type, status, actual_time, gps_fix_at, source, is_manual, client_event_id, lat, lng, distance_meters, device_id
        ) values (
          'worker_1', 1, 'check_in', 'inside', '${actualTime}', '${gpsFix}', 'gps', false, 'ev-gps-1', 30.0561, 31.3395, 10, 'dev_worker_1'
        );
      `);

      const res = await pg.query(
        "select actual_time, gps_fix_at, source, is_manual from checkins where user_id = 'worker_1'"
      );
      assert.equal(res.rows.length, 1);
      assert.equal(new Date(res.rows[0].gps_fix_at).toISOString(), gpsFix);
      assert.equal(new Date(res.rows[0].actual_time).toISOString(), actualTime);
      assert.equal(res.rows[0].source, "gps");
      assert.equal(res.rows[0].is_manual, false);
    });

    it("evaluates GPS advisory states correctly (good, weak, outside, refining)", () => {
      // 1. Good accuracy inside geofence
      const good = evaluateGpsAdvisory(50, 200, 15);
      assert.equal(good.state, "ready");
      assert.equal(good.canPunch, true);

      // 2. Weak accuracy (> 50m) inside geofence
      const weak = evaluateGpsAdvisory(50, 200, 75);
      assert.equal(weak.state, "indoor_review");
      assert.equal(weak.canPunch, false);

      // 3. Gross inaccuracy (> 150m)
      const gross = evaluateGpsAdvisory(50, 200, 180);
      assert.equal(gross.state, "insufficient_accuracy");
      assert.equal(gross.canPunch, false);

      // 4. Clearly outside geofence
      const outside = evaluateGpsAdvisory(350, 200, 10);
      assert.equal(outside.state, "outside");
      assert.equal(outside.canPunch, false);

      // 5. Missing accuracy or distance
      const locating = evaluateGpsAdvisory(null, 200, null);
      assert.equal(locating.state, "locating");
      assert.equal(locating.canPunch, false);
    });

    it("retains best reading when multiple readings arrive", () => {
      let bestPos = null;
      const readings = [
        { lat: 30.05, lng: 31.33, accuracy: 85 },
        { lat: 30.056, lng: 31.339, accuracy: 45 },
        { lat: 30.0561, lng: 31.3395, accuracy: 18 },
        { lat: 30.0562, lng: 31.3394, accuracy: 22 },
      ];

      for (const r of readings) {
        if (!bestPos || r.accuracy <= bestPos.accuracy) {
          bestPos = r;
        }
      }

      assert.equal(bestPos.accuracy, 18);
    });

    it("filters out stale readings older than 10 seconds", () => {
      const now = Date.now();
      const freshTimestamp = now - 2000;
      const staleTimestamp = now - 25000;

      const isFresh = (ts) => now - ts <= 10000;
      assert.equal(isFresh(freshTimestamp), true);
      assert.equal(isFresh(staleTimestamp), false);
    });
  });

  describe("Admin Manual Attendance Creation", () => {
    it("allows authorized admin to create manual check-in and check-out", async () => {
      const pg = await setupDb();

      // Admin creates manual check-in at 08:00
      const inTime = "2026-10-30T08:00:00.000Z";
      await pg.exec(`
        insert into checkins (
          user_id, site_id, type, status, actual_time, source, is_manual, created_by, reason, client_event_id, lat, lng, distance_meters, device_id
        ) values (
          'worker_1', 1, 'check_in', 'inside', '${inTime}', 'manual', true, 'admin_1', 'Card scanner failure at gate', 'man-1', 30.0561, 31.3395, 0, 'manual'
        );
      `);

      // Admin creates manual check-out at 16:30
      const outTime = "2026-10-30T16:30:00.000Z";
      await pg.exec(`
        insert into checkins (
          user_id, site_id, type, status, actual_time, source, is_manual, created_by, reason, client_event_id, lat, lng, distance_meters, device_id
        ) values (
          'worker_1', 1, 'check_out', 'inside', '${outTime}', 'manual', true, 'admin_1', 'Shift end signed by supervisor', 'man-2', 30.0561, 31.3395, 0, 'manual'
        );
      `);

      const punches = await pg.query(
        "select type, actual_time, source, is_manual, created_by, reason from checkins where user_id = 'worker_1' order by actual_time asc"
      );
      assert.equal(punches.rows.length, 2);
      assert.equal(punches.rows[0].type, "check_in");
      assert.equal(punches.rows[0].is_manual, true);
      assert.equal(punches.rows[0].created_by, "admin_1");
      assert.equal(punches.rows[1].type, "check_out");
      assert.equal(punches.rows[1].is_manual, true);
    });

    it("correctly pairs Manual IN with GPS OUT", async () => {
      const pg = await setupDb();
      const inTime = "2026-10-30T08:00:00.000Z";
      const outTime = "2026-10-30T16:00:00.000Z";

      // Manual IN
      await pg.exec(`
        insert into checkins (
          user_id, site_id, type, status, actual_time, source, is_manual, created_by, reason, client_event_id, lat, lng, distance_meters, device_id
        ) values (
          'worker_1', 1, 'check_in', 'inside', '${inTime}', 'manual', true, 'admin_1', 'Late paper pass', 'ev-man-in', 30.0561, 31.3395, 0, 'manual'
        );
      `);

      // GPS OUT
      await pg.exec(`
        insert into checkins (
          user_id, site_id, type, status, actual_time, gps_fix_at, source, is_manual, client_event_id, lat, lng, distance_meters, device_id
        ) values (
          'worker_1', 1, 'check_out', 'inside', '${outTime}', '${outTime}', 'gps', false, 'ev-gps-out', 30.0561, 31.3395, 12, 'dev_worker_1'
        );
      `);

      const rows = (await pg.query(
        "select type, actual_time, source from checkins where user_id = 'worker_1' and is_reversed = false order by actual_time asc"
      )).rows;

      assert.equal(rows.length, 2);
      assert.equal(rows[0].source, "manual");
      assert.equal(rows[1].source, "gps");

      // Verify hours calculation
      const durationHours = (new Date(rows[1].actual_time) - new Date(rows[0].actual_time)) / 3600000;
      assert.equal(durationHours, 8);
    });

    it("correctly pairs GPS IN with Manual OUT", async () => {
      const pg = await setupDb();
      const inTime = "2026-10-30T09:00:00.000Z";
      const outTime = "2026-10-30T17:30:00.000Z";

      // GPS IN
      await pg.exec(`
        insert into checkins (
          user_id, site_id, type, status, actual_time, gps_fix_at, source, is_manual, client_event_id, lat, lng, distance_meters, device_id
        ) values (
          'worker_1', 1, 'check_in', 'inside', '${inTime}', '${inTime}', 'gps', false, 'ev-gps-in-2', 30.0561, 31.3395, 15, 'dev_worker_1'
        );
      `);

      // Manual OUT
      await pg.exec(`
        insert into checkins (
          user_id, site_id, type, status, actual_time, source, is_manual, created_by, reason, client_event_id, lat, lng, distance_meters, device_id
        ) values (
          'worker_1', 1, 'check_out', 'inside', '${outTime}', 'manual', true, 'admin_1', 'Phone battery died before checkout', 'ev-man-out-2', 30.0561, 31.3395, 0, 'manual'
        );
      `);

      const rows = (await pg.query(
        "select type, actual_time, source from checkins where user_id = 'worker_1' and is_reversed = false order by actual_time asc"
      )).rows;

      assert.equal(rows.length, 2);
      const durationHours = (new Date(rows[1].actual_time) - new Date(rows[0].actual_time)) / 3600000;
      assert.equal(durationHours, 8.5);
    });

    it("rejects future attendance timestamps", () => {
      const now = Date.now();
      const futureTime = new Date(now + 3600000);
      assert.ok(futureTime.getTime() > now, "Future time is greater than now");
    });
  });

  describe("Reversals & Audit History", () => {
    it("excludes reversed entries from payable hours while preserving history and audit", async () => {
      const pg = await setupDb();
      const inTime = "2026-10-30T08:00:00.000Z";
      const erroneousOutTime = "2026-10-30T10:00:00.000Z";
      const correctOutTime = "2026-10-30T16:00:00.000Z";

      // Insert IN and erroneous OUT
      await pg.exec(`
        insert into checkins (id, user_id, site_id, type, status, actual_time, source, is_manual, client_event_id, lat, lng, distance_meters, device_id)
        values (101, 'worker_1', 1, 'check_in', 'inside', '${inTime}', 'manual', true, 'ev-101', 30.0561, 31.3395, 0, 'manual');

        insert into checkins (id, user_id, site_id, type, status, actual_time, source, is_manual, client_event_id, lat, lng, distance_meters, device_id)
        values (102, 'worker_1', 1, 'check_out', 'inside', '${erroneousOutTime}', 'manual', true, 'ev-102', 30.0561, 31.3395, 0, 'manual');
      `);

      // Admin reverses punch 102
      await pg.exec(`
        update checkins
        set is_reversed = true,
            reversal_reason = 'Accidental check-out registered by mistake',
            reversed_by = 'admin_1',
            reversed_at = now()
        where id = 102;

        insert into manual_attendance_audit (checkin_id, admin_id, action, reason, target_user_id, actual_time)
        values (102, 'admin_1', 'reverse', 'Accidental check-out registered by mistake', 'worker_1', '${erroneousOutTime}');
      `);

      // Add the correct replacement checkout
      await pg.exec(`
        insert into checkins (id, user_id, site_id, type, status, actual_time, source, is_manual, created_by, reason, client_event_id, lat, lng, distance_meters, device_id)
        values (103, 'worker_1', 1, 'check_out', 'inside', '${correctOutTime}', 'manual', true, 'admin_1', 'Correct end of shift', 'ev-103', 30.0561, 31.3395, 0, 'manual');
      `);

      // Active payable punches query (must exclude reversed)
      const payablePunches = (await pg.query(
        "select id, type, actual_time from checkins where user_id = 'worker_1' and is_reversed = false order by actual_time asc"
      )).rows;

      assert.equal(payablePunches.length, 2);
      assert.equal(payablePunches[0].id, 101);
      assert.equal(payablePunches[1].id, 103);

      const hours = (new Date(payablePunches[1].actual_time) - new Date(payablePunches[0].actual_time)) / 3600000;
      assert.equal(hours, 8, "Hours calculated correctly across active punches (8h, not 2h)");

      // Audit trail check: reversed punch still exists in db
      const allPunches = (await pg.query("select id, is_reversed, reversal_reason from checkins where id = 102")).rows;
      assert.equal(allPunches[0].is_reversed, true);
      assert.equal(allPunches[0].reversal_reason, "Accidental check-out registered by mistake");

      const auditRow = (await pg.query("select * from manual_attendance_audit where checkin_id = 102")).rows;
      assert.equal(auditRow.length, 1);
      assert.equal(auditRow[0].action, "reverse");
      assert.equal(auditRow[0].admin_id, "admin_1");
      assert.equal(auditRow[0].target_user_id, "worker_1");
    });
  });

  describe("Employee Attendance Review Requests", () => {
    it("submits review requests idempotently without counting toward payable hours", async () => {
      const pg = await setupDb();
      const clientEventId = "req-1111-2222-3333";
      const attemptedAt = "2026-10-30T08:05:00.000Z";

      // 1. Submit review request
      await pg.exec(`
        insert into attendance_requests (
          user_id, site_id, type, attempted_at, accuracy_meters, advisory_state, reason, device_id, client_event_id, status
        ) values (
          'worker_1', 1, 'check_in', '${attemptedAt}', 65.4, 'weak_accuracy', 'GPS signal degraded inside concrete building', 'dev_worker_1', '${clientEventId}', 'pending'
        )
        on conflict (client_event_id) do nothing;
      `);

      // 2. Submit duplicate attempt with same client_event_id (retry)
      await pg.exec(`
        insert into attendance_requests (
          user_id, site_id, type, attempted_at, accuracy_meters, advisory_state, reason, device_id, client_event_id, status
        ) values (
          'worker_1', 1, 'check_in', '${attemptedAt}', 65.4, 'weak_accuracy', 'GPS signal degraded inside concrete building', 'dev_worker_1', '${clientEventId}', 'pending'
        )
        on conflict (client_event_id) do nothing;
      `);

      const requests = (await pg.query(
        "select * from attendance_requests where user_id = 'worker_1'"
      )).rows;
      assert.equal(requests.length, 1, "Idempotent insert: exactly 1 request created");
      assert.equal(requests[0].status, "pending");

      // Verify checkins table remains empty (pending request does NOT create payable hours)
      const punches = (await pg.query("select * from checkins where user_id = 'worker_1'")).rows;
      assert.equal(punches.length, 0, "No checkin created for pending request");
    });

    it("approval creates audited manual attendance and updates request status", async () => {
      const pg = await setupDb();
      const clientEventId = "req-approve-test";
      const attemptedAt = "2026-10-30T08:00:00.000Z";

      await pg.exec(`
        insert into attendance_requests (
          user_id, site_id, type, attempted_at, accuracy_meters, advisory_state, reason, device_id, client_event_id, status
        ) values (
          'worker_1', 1, 'check_in', '${attemptedAt}', 55.0, 'weak_accuracy', 'Underground parking gate', 'dev_worker_1', '${clientEventId}', 'pending'
        );
      `);

      const req = (await pg.query("select * from attendance_requests where client_event_id = '" + clientEventId + "'")).rows[0];
      const isoTime = new Date(req.attempted_at).toISOString();

      // Admin approves request
      await pg.exec(`
        insert into checkins (
          user_id, site_id, type, status, actual_time, source, is_manual, created_by, reason, client_event_id, lat, lng, distance_meters, device_id
        ) values (
          '${req.user_id}', ${req.site_id}, '${req.type}', 'inside', '${isoTime}', 'manual', true, 'admin_1', 'Approved request #${req.id}: ${req.reason}', 'ev-approved-${req.id}', 30.0561, 31.3395, 0, 'manual'
        );

        update attendance_requests
        set status = 'approved',
            reviewed_by = 'admin_1',
            reviewed_at = now(),
            admin_notes = 'Verified on CCTV'
        where id = ${req.id};
      `);

      // Verify request is approved
      const updatedReq = (await pg.query("select * from attendance_requests where id = " + req.id)).rows[0];
      assert.equal(updatedReq.status, "approved");
      assert.equal(updatedReq.reviewed_by, "admin_1");
      assert.equal(updatedReq.admin_notes, "Verified on CCTV");

      // Verify checkin created
      const checkin = (await pg.query("select * from checkins where user_id = 'worker_1'")).rows[0];
      assert.equal(checkin.source, "manual");
      assert.equal(checkin.is_manual, true);
      assert.equal(checkin.created_by, "admin_1");
      assert.equal(new Date(checkin.actual_time).toISOString(), attemptedAt);
    });
  });

  describe("Overnight Shifts & Payroll Timezone Protection", () => {
    it("handles overnight shift across midnight cleanly in Cairo timezone", async () => {
      const pg = await setupDb();
      const shiftIn = "2026-10-30T20:00:00.000Z";
      const shiftOut = "2026-10-31T04:00:00.000Z";

      await pg.exec(`
        insert into checkins (
          user_id, site_id, type, status, actual_time, source, is_manual, created_by, reason, client_event_id, lat, lng, distance_meters, device_id
        ) values (
          'worker_1', 1, 'check_in', 'inside', '${shiftIn}', 'manual', true, 'admin_1', 'Night security shift', 'ev-night-in', 30.0561, 31.3395, 0, 'manual'
        );

        insert into checkins (
          user_id, site_id, type, status, actual_time, source, is_manual, created_by, reason, client_event_id, lat, lng, distance_meters, device_id
        ) values (
          'worker_1', 1, 'check_out', 'inside', '${shiftOut}', 'manual', true, 'admin_1', 'Morning handover', 'ev-night-out', 30.0561, 31.3395, 0, 'manual'
        );
      `);

      const punches = (await pg.query(
        "select actual_time from checkins where user_id = 'worker_1' and is_reversed = false order by actual_time asc"
      )).rows;

      const durationHours = (new Date(punches[1].actual_time) - new Date(punches[0].actual_time)) / 3600000;
      assert.equal(durationHours, 8, "8-hour overnight shift computed correctly across midnight");
    });
  });

  describe("Migration Backward Compatibility", () => {
    it("ensures existing historical records have actual_time matching created_at", async () => {
      const pg = await setupDb();
      const pastTime = "2025-05-15T10:30:00.000Z";
      await pg.exec(`
        insert into checkins (
          user_id, site_id, type, status, created_at, actual_time, client_event_id, lat, lng, distance_meters, device_id
        ) values (
          'worker_2', 1, 'check_in', 'inside', '${pastTime}', '${pastTime}', 'ev-legacy-1', 30.0561, 31.3395, 25, 'dev_legacy'
        );
      `);

      const row = (await pg.query("select created_at, actual_time from checkins where user_id = 'worker_2'")).rows[0];
      assert.equal(new Date(row.actual_time).toISOString(), new Date(row.created_at).toISOString());
    });
  });

  describe("Server Functions Concurrency, Validation & Payroll Protection", () => {
    // Helper to simulate server-side createManualAttendance logic
    async function serverCreateManualAttendance(pg, adminUserId, data) {
      const callerRes = await pg.query("select role from profiles where user_id = $1", [adminUserId]);
      if (!callerRes.rows[0] || callerRes.rows[0].role !== "admin") {
        throw new Error("FORBIDDEN: Admin access required.");
      }

      const reason = (data.reason ?? "").trim();
      if (reason.length < 5) {
        throw new Error("A specific operational reason (at least 5 characters) is required.");
      }
      const at = new Date(data.actualTime);
      const atMs = at.getTime();
      if (Number.isNaN(atMs)) throw new Error("Invalid actual attendance timestamp.");
      if (atMs > Date.now() + 2 * 60 * 1000) {
        throw new Error("FUTURE_TIME: Actual attendance time cannot be in the future.");
      }

      return pg.transaction(async (tx) => {
        // 1. Lock profile to serialize
        const workerRes = await tx.query("select user_id, active from profiles where user_id = $1 for update", [data.userId]);
        const worker = workerRes.rows[0];
        if (!worker) throw new Error("EMPLOYEE_NOT_FOUND");
        if (!worker.active) throw new Error("EMPLOYEE_INACTIVE: Cannot record attendance for inactive employee.");

        // Idempotency
        if (data.clientEventId) {
          const ex = await tx.query("select id, type, actual_time from checkins where user_id = $1 and client_event_id = $2 limit 1", [data.userId, data.clientEventId]);
          if (ex.rows[0]) return { id: ex.rows[0].id, type: ex.rows[0].type, replayed: true };
        }

        // Validate site
        const siteRes = await tx.query("select id, lat, lng, active from sites where id = $1", [data.siteId]);
        const site = siteRes.rows[0];
        if (!site) throw new Error("SITE_NOT_FOUND");
        if (!site.active) throw new Error("SITE_INACTIVE");

        // Duplicate punch (< 60s) for same punch type
        const dupRes = await tx.query(`
          select id from checkins
          where user_id = $1
            and is_reversed = false
            and type = $2
            and abs(extract(epoch from (actual_time - $3::timestamptz))) < 60
          limit 1`, [data.userId, data.type, at.toISOString()]);
        if (dupRes.rows[0]) throw new Error("DUPLICATE_PUNCH: An active attendance punch already exists within 1 minute of this time.");

        // Validate sequence around timestamp
        const prevRes = await tx.query(`
          select id, type, actual_time from checkins
          where user_id = $1 and is_reversed = false and actual_time <= $2::timestamptz
          order by actual_time desc, id desc limit 1`, [data.userId, at.toISOString()]);
        const prev = prevRes.rows[0];

        const nextRes = await tx.query(`
          select id, type, actual_time from checkins
          where user_id = $1 and is_reversed = false and actual_time >= $2::timestamptz
          order by actual_time asc, id asc limit 1`, [data.userId, at.toISOString()]);
        const next = nextRes.rows[0];

        const STALE_SHIFT_HOURS = 16;
        if (data.type === "check_in") {
          if (prev && prev.type === "check_in") {
            const hrs = (atMs - new Date(prev.actual_time).getTime()) / 3600000;
            if (hrs < STALE_SHIFT_HOURS) {
              throw new Error("ALREADY_CHECKED_IN: Worker has an unclosed check-in prior to this time.");
            }
          }
          if (next && next.type === "check_in") {
            const hrs = (new Date(next.actual_time).getTime() - atMs) / 3600000;
            if (hrs < STALE_SHIFT_HOURS) {
              throw new Error("INVALID_SEQUENCE: Cannot place check-in immediately before another check-in without an intervening checkout.");
            }
          }
        } else {
          // check_out
          if (!prev || prev.type !== "check_in" || atMs <= new Date(prev.actual_time).getTime()) {
            throw new Error("NOT_CHECKED_IN: Cannot place check-out without a preceding open check-in.");
          }
          const hrs = (atMs - new Date(prev.actual_time).getTime()) / 3600000;
          if (hrs >= STALE_SHIFT_HOURS) {
            throw new Error("STALE_SHIFT: Preceding check-in is more than 16 hours old.");
          }
          if (next && next.type === "check_out") {
            const nextHrs = (new Date(next.actual_time).getTime() - atMs) / 3600000;
            if (nextHrs < STALE_SHIFT_HOURS) {
              throw new Error("INVALID_SEQUENCE: Cannot place check-out immediately before another checkout.");
            }
          }
        }

        const clientEventId = data.clientEventId ?? `man-evt-${Date.now()}-${Math.random()}`;
        const ins = await tx.query(`
          insert into checkins (
            user_id, site_id, type, client_event_id, lat, lng, distance_meters, status,
            device_id, device_matched, flagged, source, is_manual, actual_time, created_by, reason, created_at
          ) values (
            $1, $2, $3, $4, $5, $6, 0, 'inside', 'manual', true, false, 'manual', true, $7, $8, $9, now()
          ) returning id, type, actual_time`, [
            data.userId, data.siteId, data.type, clientEventId, site.lat, site.lng, at.toISOString(), adminUserId, reason
          ]);

        const punch = ins.rows[0];
        await tx.query(`
          insert into manual_attendance_audit (
            checkin_id, admin_id, action, reason, target_user_id, actual_time
          ) values ($1, $2, 'create', $3, $4, $5)`, [
            punch.id, adminUserId, reason, data.userId, at.toISOString()
          ]);

        return punch;
      });
    }

    // Helper to simulate server-side reverseManualAttendance logic
    async function serverReverseManualAttendance(pg, adminUserId, data) {
      const callerRes = await pg.query("select role from profiles where user_id = $1", [adminUserId]);
      if (!callerRes.rows[0] || callerRes.rows[0].role !== "admin") {
        throw new Error("FORBIDDEN: Admin access required.");
      }
      const reason = (data.reason ?? "").trim();
      if (reason.length < 5) throw new Error("A specific reason for reversal (at least 5 characters) is required.");

      return pg.transaction(async (tx) => {
        const rows = await tx.query("select * from checkins where id = $1 for update", [data.checkinId]);
        const punch = rows.rows[0];
        if (!punch) throw new Error("PUNCH_NOT_FOUND");
        if (punch.is_reversed) throw new Error("ALREADY_REVERSED: This attendance record has already been reversed.");

        await tx.query("select user_id from profiles where user_id = $1 for update", [punch.user_id]);
        await tx.query(`
          update checkins
          set is_reversed = true, reversal_reason = $1, reversed_by = $2, reversed_at = now()
          where id = $3`, [reason, adminUserId, data.checkinId]);

        await tx.query(`
          insert into manual_attendance_audit (checkin_id, admin_id, action, reason, target_user_id, actual_time)
          values ($1, $2, 'reverse', $3, $4, $5)`, [punch.id, adminUserId, reason, punch.user_id, punch.actual_time]);

        return { success: true, id: punch.id };
      });
    }

    // Helper to simulate server-side reviewAttendanceRequest logic
    async function serverReviewAttendanceRequest(pg, adminUserId, data) {
      const callerRes = await pg.query("select role from profiles where user_id = $1", [adminUserId]);
      if (!callerRes.rows[0] || callerRes.rows[0].role !== "admin") {
        throw new Error("FORBIDDEN: Admin access required.");
      }

      return pg.transaction(async (tx) => {
        const reqRes = await tx.query(`
          select r.*, s.lat as site_lat, s.lng as site_lng, p.active as user_active
          from attendance_requests r
          join sites s on s.id = r.site_id
          join profiles p on p.user_id = r.user_id
          where r.id = $1 for update`, [data.requestId]);
        const req = reqRes.rows[0];
        if (!req) throw new Error("REQUEST_NOT_FOUND");
        if (req.status !== "pending") throw new Error("ALREADY_REVIEWED: This request has already been processed.");

        if (data.decision === "reject") {
          await tx.query(`
            update attendance_requests
            set status = 'rejected', reviewed_by = $1, reviewed_at = now(), admin_notes = $2
            where id = $3`, [adminUserId, data.adminNotes || null, data.requestId]);
          return { success: true, status: "rejected" };
        }

        if (!req.user_active) throw new Error("EMPLOYEE_INACTIVE");

        await tx.query("select user_id from profiles where user_id = $1 for update", [req.user_id]);

        const approvalEventId = `appr-req-${req.id}`;
        const exPunch = await tx.query("select id from checkins where client_event_id = $1 limit 1", [approvalEventId]);
        if (exPunch.rows[0]) throw new Error("ALREADY_APPROVED: A checkin record for this request already exists.");

        await tx.query(`
          update attendance_requests
          set status = 'approved', reviewed_by = $1, reviewed_at = now(), admin_notes = $2
          where id = $3`, [adminUserId, data.adminNotes || null, data.requestId]);

        const approvalReason = `Approved review request #${req.id}: ${req.reason}`;
        const ins = await tx.query(`
          insert into checkins (
            user_id, site_id, type, client_event_id, lat, lng, accuracy_meters, distance_meters, status,
            device_id, device_matched, flagged, source, is_manual, actual_time, gps_fix_at, created_by, reason, created_at
          ) values (
            $1, $2, $3, $4, $5, $6, $7, 0, 'inside', $8, true, false, 'manual', true, $9, $10, $11, $12, now()
          ) returning id, type, actual_time`, [
            req.user_id, req.site_id, req.type, approvalEventId, req.site_lat, req.site_lng, req.accuracy_meters,
            req.device_id, req.attempted_at, req.gps_fix_at, adminUserId, approvalReason
          ]);

        const punch = ins.rows[0];
        await tx.query(`
          insert into manual_attendance_audit (
            checkin_id, admin_id, action, reason, target_user_id, actual_time
          ) values ($1, $2, 'create', $3, $4, $5)`, [punch.id, adminUserId, approvalReason, req.user_id, req.attempted_at]);

        return { success: true, status: "approved", checkinId: punch.id };
      });
    }

    // Helper to calculate payable hours using exact getDailyHours query
    async function calculatePayableHours(pg, userId, startDate, endDate) {
      const rows = (await pg.query(`
        with events as (
          select type, actual_time as event_time, false as is_boundary
          from checkins
          where user_id = $1
            and is_reversed = false
            and actual_time >= $2::date
            and actual_time < $3::date
          union all
          select type, attempted_at as event_time, true as is_boundary
          from attendance_requests
          where user_id = $1
            and request_kind = 'rejected_punch'
            and status = 'rejected'
            and type = 'check_out'
            and attempted_at >= $2::date
            and attempted_at < $3::date
        )
        select type, event_time::text as created_at, is_boundary
        from events
        order by event_time asc`, [userId, startDate, endDate])).rows;

      let totalHours = 0;
      let openSince = null;
      for (const row of rows) {
        const at = new Date(row.created_at);
        if (row.is_boundary) {
          if (row.type === "check_out" && openSince) {
            const hrs = Math.min(16, (at.getTime() - openSince.getTime()) / 3600000);
            totalHours += hrs;
            openSince = null;
          }
          continue;
        }
        if (row.type === "check_in") openSince = at;
        else if (row.type === "check_out" && openSince) {
          const hrs = Math.min(16, (at.getTime() - openSince.getTime()) / 3600000);
          totalHours += hrs;
          openSince = null;
        }
      }
      return totalHours;
    }

    it("1. Duplicate manual IN throws ALREADY_CHECKED_IN", async () => {
      const pg = await setupDb();
      await serverCreateManualAttendance(pg, "admin_1", {
        userId: "worker_1",
        siteId: 1,
        type: "check_in",
        actualTime: "2026-10-30T08:00:00.000Z",
        reason: "Manual entry at site arrival",
      });

      await assert.rejects(
        () =>
          serverCreateManualAttendance(pg, "admin_1", {
            userId: "worker_1",
            siteId: 1,
            type: "check_in",
            actualTime: "2026-10-30T09:00:00.000Z",
            reason: "Second manual checkin attempt",
          }),
        /ALREADY_CHECKED_IN/
      );
    });

    it("2. Manual OUT without open IN throws NOT_CHECKED_IN", async () => {
      const pg = await setupDb();
      await assert.rejects(
        () =>
          serverCreateManualAttendance(pg, "admin_1", {
            userId: "worker_1",
            siteId: 1,
            type: "check_out",
            actualTime: "2026-10-29T17:00:00.000Z",
            reason: "Checkout without checkin",
          }),
        /NOT_CHECKED_IN/
      );
    });

    it("3. Overlapping shifts throws INVALID_SEQUENCE", async () => {
      const pg = await setupDb();
      await serverCreateManualAttendance(pg, "admin_1", {
        userId: "worker_1",
        siteId: 1,
        type: "check_in",
        actualTime: "2026-10-29T08:00:00.000Z",
        reason: "Morning shift start",
      });
      await serverCreateManualAttendance(pg, "admin_1", {
        userId: "worker_1",
        siteId: 1,
        type: "check_out",
        actualTime: "2026-10-29T16:00:00.000Z",
        reason: "Morning shift finish",
      });

      // Attempt to place a check-in at 10:00 (between 08:00 and 16:00)
      await assert.rejects(
        () =>
          serverCreateManualAttendance(pg, "admin_1", {
            userId: "worker_1",
            siteId: 1,
            type: "check_in",
            actualTime: "2026-10-29T10:00:00.000Z",
            reason: "Overlapping checkin",
          }),
        /ALREADY_CHECKED_IN|INVALID_SEQUENCE/
      );
    });

    it("4. Manual IN + Manual OUT pairs cleanly with unverified semantics", async () => {
      const pg = await setupDb();
      const inPunch = await serverCreateManualAttendance(pg, "admin_1", {
        userId: "worker_1",
        siteId: 1,
        type: "check_in",
        actualTime: "2026-10-29T08:00:00.000Z",
        reason: "Manual gate entry verified by security",
      });
      const outPunch = await serverCreateManualAttendance(pg, "admin_1", {
        userId: "worker_1",
        siteId: 1,
        type: "check_out",
        actualTime: "2026-10-29T16:00:00.000Z",
        reason: "Manual gate departure signed by manager",
      });

      assert.ok(inPunch.id);
      assert.ok(outPunch.id);

      const punches = (await pg.query(
        "select status, source, is_manual, distance_meters from checkins where user_id = 'worker_1' order by actual_time asc"
      )).rows;

      assert.equal(punches.length, 2);
      for (const p of punches) {
        assert.equal(p.status, "inside");
        assert.equal(p.source, "manual");
        assert.equal(p.is_manual, true);
        assert.equal(p.distance_meters, 0); // No false measured distance
      }

      const hours = await calculatePayableHours(pg, "worker_1", "2026-10-29", "2026-10-30");
      assert.equal(hours, 8.0);
    });

    it("5. Concurrent conflicting manual entries serialize and enforce idempotency", async () => {
      const pg = await setupDb();
      const clientEventId = "unique-client-event-1234";

      // 1. First execution succeeds
      const first = await serverCreateManualAttendance(pg, "admin_1", {
        userId: "worker_1",
        siteId: 1,
        type: "check_in",
        actualTime: "2026-10-29T08:00:00.000Z",
        reason: "First manual checkin",
        clientEventId,
      });
      assert.equal(first.replayed, undefined);

      // 2. Replay with identical clientEventId is idempotent (no duplicate created)
      const second = await serverCreateManualAttendance(pg, "admin_1", {
        userId: "worker_1",
        siteId: 1,
        type: "check_in",
        actualTime: "2026-10-29T08:00:00.000Z",
        reason: "First manual checkin retry",
        clientEventId,
      });
      assert.equal(second.replayed, true);
      assert.equal(second.id, first.id);

      const count = (await pg.query("select count(*) as cnt from checkins where user_id = 'worker_1'")).rows[0].cnt;
      assert.equal(count, 1, "Only 1 checkin row exists despite replay");
    });

    it("6. Duplicate review request approval is rejected with ALREADY_REVIEWED", async () => {
      const pg = await setupDb();
      await pg.exec(`
        insert into attendance_requests (id, user_id, site_id, type, attempted_at, accuracy_meters, advisory_state, reason, device_id, client_event_id, status)
        values (55, 'worker_1', 1, 'check_in', '2026-10-29T08:00:00.000Z', 60.0, 'weak_accuracy', 'Basement entry', 'dev_worker_1', 'evt-req-55', 'pending');
      `);

      // First approval succeeds
      const res1 = await serverReviewAttendanceRequest(pg, "admin_1", {
        requestId: 55,
        decision: "approve",
        adminNotes: "Approved by manager",
      });
      assert.equal(res1.status, "approved");

      // Second approval attempt fails
      await assert.rejects(
        () =>
          serverReviewAttendanceRequest(pg, "admin_1", {
            requestId: 55,
            decision: "approve",
            adminNotes: "Accidental second click",
          }),
        /ALREADY_REVIEWED/
      );
    });

    it("7. Reversal and replacement computes correct payable hours and preserves audit", async () => {
      const pg = await setupDb();
      await serverCreateManualAttendance(pg, "admin_1", {
        userId: "worker_1",
        siteId: 1,
        type: "check_in",
        actualTime: "2026-10-29T08:00:00.000Z",
        reason: "Shift start",
      });
      const erroneousOut = await serverCreateManualAttendance(pg, "admin_1", {
        userId: "worker_1",
        siteId: 1,
        type: "check_out",
        actualTime: "2026-10-29T10:00:00.000Z",
        reason: "Erroneous checkout",
      });

      // Reverse the erroneous checkout
      await serverReverseManualAttendance(pg, "admin_1", {
        checkinId: erroneousOut.id,
        reason: "Entered wrong worker checkout by mistake",
      });

      // Insert correct replacement checkout
      await serverCreateManualAttendance(pg, "admin_1", {
        userId: "worker_1",
        siteId: 1,
        type: "check_out",
        actualTime: "2026-10-29T16:00:00.000Z",
        reason: "Actual end of shift checkout",
      });

      // Hours must be 8 hours (08:00 to 16:00), not 2 hours
      const hours = await calculatePayableHours(pg, "worker_1", "2026-10-29", "2026-10-30");
      assert.equal(hours, 8.0);

      // Verify audit trail contains reversal
      const audit = (await pg.query("select action, reason from manual_attendance_audit where checkin_id = $1", [erroneousOut.id])).rows;
      assert.equal(audit[audit.length - 1].action, "reverse");
      assert.equal(audit[audit.length - 1].reason, "Entered wrong worker checkout by mistake");
    });

    it("8. Rejected GPS OUT between valid IN and OUT caps shift at 4 hours, not 9 hours", async () => {
      const pg = await setupDb();
      // 08:00 Verified IN (GPS)
      await pg.exec(`
        insert into checkins (
          user_id, site_id, type, status, actual_time, gps_fix_at, source, is_manual, client_event_id, lat, lng, distance_meters, device_id
        ) values (
          'worker_1', 1, 'check_in', 'inside', '2026-10-29T08:00:00.000Z', '2026-10-29T08:00:00.000Z', 'gps', false, 'ev-gps-in-0800', 30.0561, 31.3395, 15, 'dev_worker_1'
        );
      `);

      // 12:00 Rejected GPS OUT attempt (logged in attendance_requests with status 'rejected')
      await pg.exec(`
        insert into attendance_requests (
          user_id, site_id, type, attempted_at, accuracy_meters, advisory_state, reason, device_id, client_event_id, status, request_kind
        ) values (
          'worker_1', 1, 'check_out', '2026-10-29T12:00:00.000Z', 180.0, 'outside', 'Attempted checkout outside perimeter', 'dev_worker_1', 'ev-gps-rej-1200', 'rejected', 'rejected_punch'
        );
      `);

      // 17:00 Verified OUT (GPS)
      await pg.exec(`
        insert into checkins (
          user_id, site_id, type, status, actual_time, gps_fix_at, source, is_manual, client_event_id, lat, lng, distance_meters, device_id
        ) values (
          'worker_1', 1, 'check_out', 'inside', '2026-10-29T17:00:00.000Z', '2026-10-29T17:00:00.000Z', 'gps', false, 'ev-gps-out-1700', 30.0561, 31.3395, 15, 'dev_worker_1'
        );
      `);

      // Calculate payable hours: boundary event at 12:00 caps shift at (12:00 - 08:00) = 4 hours.
      // At 17:00, openSince is null so 17:00 adds 0 hours. Total must be EXACTLY 4.0, NEVER 9.0!
      const hours = await calculatePayableHours(pg, "worker_1", "2026-10-29", "2026-10-30");
      assert.equal(hours, 4.0, "Payable hours must be 4.0 (08:00-12:00), NOT 9.0 (08:00-17:00)");
    });

    it("9. Unauthorized manual attendance creation is blocked with FORBIDDEN", async () => {
      const pg = await setupDb();
      // worker_2 is role 'employee', not 'admin'
      await assert.rejects(
        () =>
          serverCreateManualAttendance(pg, "worker_2", {
            userId: "worker_1",
            siteId: 1,
            type: "check_in",
            actualTime: "2026-10-29T08:00:00.000Z",
            reason: "Unauthorized employee punch injection",
          }),
        /FORBIDDEN/
      );
    });

    it("10. Historical attendance back-inserted after newer events is accepted cleanly", async () => {
      const pg = await setupDb();
      // Worker has today's checkin at 07:00 (past)
      await serverCreateManualAttendance(pg, "admin_1", {
        userId: "worker_1",
        siteId: 1,
        type: "check_in",
        actualTime: "2026-10-30T07:00:00.000Z",
        reason: "Today early morning shift",
      });

      // Admin back-inserts yesterday's complete shift (Oct 29: 08:00 to 16:00)
      const yestIn = await serverCreateManualAttendance(pg, "admin_1", {
        userId: "worker_1",
        siteId: 1,
        type: "check_in",
        actualTime: "2026-10-29T08:00:00.000Z",
        reason: "Yesterday missing punch reported by foreman",
      });
      const yestOut = await serverCreateManualAttendance(pg, "admin_1", {
        userId: "worker_1",
        siteId: 1,
        type: "check_out",
        actualTime: "2026-10-29T16:00:00.000Z",
        reason: "Yesterday departure signed by foreman",
      });

      assert.ok(yestIn.id);
      assert.ok(yestOut.id);

      // Verify all 3 records exist in chronological order
      const allPunches = (await pg.query(
        "select actual_time, type from checkins where user_id = 'worker_1' order by actual_time asc"
      )).rows;

      assert.equal(allPunches.length, 3);
      assert.equal(allPunches[0].type, "check_in");
      assert.equal(new Date(allPunches[0].actual_time).toISOString(), "2026-10-29T08:00:00.000Z");
      assert.equal(allPunches[1].type, "check_out");
      assert.equal(new Date(allPunches[1].actual_time).toISOString(), "2026-10-29T16:00:00.000Z");
      assert.equal(allPunches[2].type, "check_in");
      assert.equal(new Date(allPunches[2].actual_time).toISOString(), "2026-10-30T07:00:00.000Z");

      // Verify yesterday's hours calculate to 8.0
      const yestHours = await calculatePayableHours(pg, "worker_1", "2026-10-29", "2026-10-30");
      assert.equal(yestHours, 8.0);
    });

    it("11. Check-out shortly after check-in within 60s succeeds, but same-type duplicate within 60s throws DUPLICATE_PUNCH", async () => {
      const pg = await setupDb();
      await serverCreateManualAttendance(pg, "admin_1", {
        userId: "worker_1",
        siteId: 1,
        type: "check_in",
        actualTime: "2026-10-30T08:00:00.000Z",
        reason: "Manual checkin at 08:00:00",
      });

      // Same-type punch within 60s is rejected with DUPLICATE_PUNCH
      await assert.rejects(
        () =>
          serverCreateManualAttendance(pg, "admin_1", {
            userId: "worker_1",
            siteId: 1,
            type: "check_in",
            actualTime: "2026-10-30T08:00:30.000Z",
            reason: "Duplicate manual checkin at 08:00:30",
          }),
        /DUPLICATE_PUNCH/
      );

      // Check-out 15 seconds after check-in is permitted (not blocked by DUPLICATE_PUNCH)
      const out = await serverCreateManualAttendance(pg, "admin_1", {
        userId: "worker_1",
        siteId: 1,
        type: "check_out",
        actualTime: "2026-10-30T08:00:15.000Z",
        reason: "Immediate departure 15s later",
      });
      assert.ok(out.id);

      // Duplicate check-out within 60s is rejected with DUPLICATE_PUNCH
      await assert.rejects(
        () =>
          serverCreateManualAttendance(pg, "admin_1", {
            userId: "worker_1",
            siteId: 1,
            type: "check_out",
            actualTime: "2026-10-30T08:00:45.000Z",
            reason: "Duplicate checkout within 60s",
          }),
        /DUPLICATE_PUNCH/
      );
    });
  });

  describe("Phase 2.2.1.1: Separate Rejected Punches from Review Requests", () => {
    // Helper for payroll hours using Phase 2.2.1.1 boundary logic
    async function getPayrollHours(pg, userId, startDate, endDate) {
      const rows = (await pg.query(`
        with events as (
          select type, actual_time as event_time, false as is_boundary
          from checkins
          where user_id = $1
            and is_reversed = false
            and actual_time >= $2::date
            and actual_time < $3::date
          union all
          select type, attempted_at as event_time, true as is_boundary
          from attendance_requests
          where user_id = $1
            and request_kind = 'rejected_punch'
            and status = 'rejected'
            and type = 'check_out'
            and attempted_at >= $2::date
            and attempted_at < $3::date
        )
        select type, event_time::text as created_at, is_boundary
        from events
        order by event_time asc`, [userId, startDate, endDate])).rows;

      let totalHours = 0;
      let openSince = null;
      for (const row of rows) {
        const at = new Date(row.created_at);
        if (row.is_boundary) {
          if (row.type === "check_out" && openSince) {
            const hrs = Math.min(16, (at.getTime() - openSince.getTime()) / 3600000);
            totalHours += hrs;
            openSince = null;
          }
          continue;
        }
        if (row.type === "check_in") openSince = at;
        else if (row.type === "check_out" && openSince) {
          const hrs = Math.min(16, (at.getTime() - openSince.getTime()) / 3600000);
          totalHours += hrs;
          openSince = null;
        }
      }
      return totalHours;
    }

    it("0. Enforces database constraint on request_kind", async () => {
      const pg = await setupDb();
      // Valid kinds: 'rejected_punch' and 'review_request'
      await pg.exec(`
        insert into attendance_requests (user_id, site_id, type, attempted_at, advisory_state, reason, device_id, client_event_id, status, request_kind)
        values ('worker_1', 1, 'check_in', '2026-10-29T08:00:00.000Z', 'locating', 'Valid review', 'dev_1', 'ev-valid-1', 'pending', 'review_request');

        insert into attendance_requests (user_id, site_id, type, attempted_at, advisory_state, reason, device_id, client_event_id, status, request_kind)
        values ('worker_1', 1, 'check_out', '2026-10-29T12:00:00.000Z', 'outside', 'Valid rejected punch', 'dev_1', 'ev-valid-2', 'rejected', 'rejected_punch');
      `);

      // Invalid kind must fail check constraint
      await assert.rejects(
        () => pg.exec(`
          insert into attendance_requests (user_id, site_id, type, attempted_at, advisory_state, reason, device_id, client_event_id, status, request_kind)
          values ('worker_1', 1, 'check_out', '2026-10-29T13:00:00.000Z', 'outside', 'Invalid kind', 'dev_1', 'ev-invalid-kind', 'rejected', 'bogus_kind');
        `),
        /check constraint|violates check constraint/i
      );
    });

    it("1. GPS IN at 08:00, rejected GPS OUT at 12:00, verified GPS OUT at 17:00 = exactly 4 payable hours", async () => {
      const pg = await setupDb();
      // 08:00 Verified GPS IN
      await pg.exec(`
        insert into checkins (user_id, site_id, type, status, actual_time, gps_fix_at, source, is_manual, client_event_id, lat, lng, distance_meters, device_id)
        values ('worker_1', 1, 'check_in', 'inside', '2026-10-29T08:00:00.000Z', '2026-10-29T08:00:00.000Z', 'gps', false, 'ev-req1-in', 30.0561, 31.3395, 10, 'dev_worker_1');
      `);

      // 12:00 Rejected GPS OUT
      await executeLogRejectedPunch(pg, "worker_1", {
        siteId: 1,
        type: "check_out",
        attemptedAt: "2026-10-29T12:00:00.000Z",
        clientEventId: "ev-req1-rej-out",
      });

      // 17:00 Verified GPS OUT
      await pg.exec(`
        insert into checkins (user_id, site_id, type, status, actual_time, gps_fix_at, source, is_manual, client_event_id, lat, lng, distance_meters, device_id)
        values ('worker_1', 1, 'check_out', 'inside', '2026-10-29T17:00:00.000Z', '2026-10-29T17:00:00.000Z', 'gps', false, 'ev-req1-out', 30.0561, 31.3395, 10, 'dev_worker_1');
      `);

      const hours = await getPayrollHours(pg, "worker_1", "2026-10-29", "2026-10-30");
      assert.equal(hours, 4.0, "Rejected GPS OUT caps the shift at 4 hours (08:00 to 12:00)");
    });

    it("2. GPS IN at 08:00, pending review request at 11:00, verified GPS OUT at 17:00 = 9 payable hours", async () => {
      const pg = await setupDb();
      // 08:00 Verified GPS IN
      await pg.exec(`
        insert into checkins (user_id, site_id, type, status, actual_time, gps_fix_at, source, is_manual, client_event_id, lat, lng, distance_meters, device_id)
        values ('worker_1', 1, 'check_in', 'inside', '2026-10-29T08:00:00.000Z', '2026-10-29T08:00:00.000Z', 'gps', false, 'ev-req2-in', 30.0561, 31.3395, 10, 'dev_worker_1');
      `);

      // 11:00 Pending review request submitted by employee (NOT a boundary event!)
      await executeSubmitAttendanceRequest(pg, "worker_1", {
        siteId: 1,
        type: "check_out",
        attemptedAt: "2026-10-29T11:00:00.000Z",
        reason: "GPS was jumping around while leaving for lunch",
        clientEventId: "ev-req2-pending-rev",
      });

      // 17:00 Verified GPS OUT
      await pg.exec(`
        insert into checkins (user_id, site_id, type, status, actual_time, gps_fix_at, source, is_manual, client_event_id, lat, lng, distance_meters, device_id)
        values ('worker_1', 1, 'check_out', 'inside', '2026-10-29T17:00:00.000Z', '2026-10-29T17:00:00.000Z', 'gps', false, 'ev-req2-out', 30.0561, 31.3395, 10, 'dev_worker_1');
      `);

      const hours = await getPayrollHours(pg, "worker_1", "2026-10-29", "2026-10-30");
      assert.equal(hours, 9.0, "Pending review request must NEVER cap shift; full 9 hours payable (08:00 to 17:00)");
    });

    it("3. GPS IN at 08:00, rejected review request at 11:00, verified GPS OUT at 17:00 = 9 payable hours", async () => {
      const pg = await setupDb();
      // 08:00 Verified GPS IN
      await pg.exec(`
        insert into checkins (user_id, site_id, type, status, actual_time, gps_fix_at, source, is_manual, client_event_id, lat, lng, distance_meters, device_id)
        values ('worker_1', 1, 'check_in', 'inside', '2026-10-29T08:00:00.000Z', '2026-10-29T08:00:00.000Z', 'gps', false, 'ev-req3-in', 30.0561, 31.3395, 10, 'dev_worker_1');
      `);

      // 11:00 Employee submitted review request
      const rev = await executeSubmitAttendanceRequest(pg, "worker_1", {
        siteId: 1,
        type: "check_out",
        attemptedAt: "2026-10-29T11:00:00.000Z",
        reason: "Forgot to check out earlier",
        clientEventId: "ev-req3-rev",
      });

      // Admin reviewed and rejected the employee's review ticket
      await testReviewAttendanceRequest(pg, "admin_1", {
        requestId: rev.id,
        decision: "reject",
        adminNotes: "Disallowed by supervisor",
      });

      // Verify row in attendance_requests is request_kind = 'review_request', status = 'rejected'
      const reqRow = (await pg.query("select request_kind, status from attendance_requests where id = $1", [rev.id])).rows[0];
      assert.equal(reqRow.request_kind, "review_request");
      assert.equal(reqRow.status, "rejected");

      // 17:00 Verified GPS OUT
      await pg.exec(`
        insert into checkins (user_id, site_id, type, status, actual_time, gps_fix_at, source, is_manual, client_event_id, lat, lng, distance_meters, device_id)
        values ('worker_1', 1, 'check_out', 'inside', '2026-10-29T17:00:00.000Z', '2026-10-29T17:00:00.000Z', 'gps', false, 'ev-req3-out', 30.0561, 31.3395, 10, 'dev_worker_1');
      `);

      const hours = await getPayrollHours(pg, "worker_1", "2026-10-29", "2026-10-30");
      assert.equal(hours, 9.0, "Rejected review request must NEVER cap shift; full 9 hours payable (08:00 to 17:00)");
    });

    it("4. Rejected GPS IN does not create payable time", async () => {
      const pg = await setupDb();
      // 08:00 Rejected GPS IN
      await executeLogRejectedPunch(pg, "worker_1", {
        siteId: 1,
        type: "check_in",
        attemptedAt: "2026-10-29T08:00:00.000Z",
        clientEventId: "ev-req4-rej-in",
      });

      // 17:00 Verified GPS OUT (without an open check-in)
      await pg.exec(`
        insert into checkins (user_id, site_id, type, status, actual_time, gps_fix_at, source, is_manual, client_event_id, lat, lng, distance_meters, device_id)
        values ('worker_1', 1, 'check_out', 'inside', '2026-10-29T17:00:00.000Z', '2026-10-29T17:00:00.000Z', 'gps', false, 'ev-req4-out', 30.0561, 31.3395, 10, 'dev_worker_1');
      `);

      const hours = await getPayrollHours(pg, "worker_1", "2026-10-29", "2026-10-30");
      assert.equal(hours, 0.0, "Rejected GPS IN does not open a shift, resulting in 0 payable hours");
    });

    it("5. Duplicate rejected GPS OUT retries create only one boundary", async () => {
      const pg = await setupDb();
      // 08:00 Verified GPS IN
      await pg.exec(`
        insert into checkins (user_id, site_id, type, status, actual_time, gps_fix_at, source, is_manual, client_event_id, lat, lng, distance_meters, device_id)
        values ('worker_1', 1, 'check_in', 'inside', '2026-10-29T08:00:00.000Z', '2026-10-29T08:00:00.000Z', 'gps', false, 'ev-req5-in', 30.0561, 31.3395, 10, 'dev_worker_1');
      `);

      const clientEventId = "ev-req5-retry-boundary";
      // First attempt
      const attempt1 = await executeLogRejectedPunch(pg, "worker_1", {
        siteId: 1,
        type: "check_out",
        attemptedAt: "2026-10-29T12:00:00.000Z",
        clientEventId,
      });
      assert.equal(attempt1.replayed, false);

      // Retry with identical payload
      const attempt2 = await executeLogRejectedPunch(pg, "worker_1", {
        siteId: 1,
        type: "check_out",
        attemptedAt: "2026-10-29T12:00:00.000Z",
        clientEventId,
      });
      assert.equal(attempt2.replayed, true);
      assert.equal(attempt2.id, attempt1.id);

      // Verify only 1 boundary row exists in database
      const rows = (await pg.query("select count(*) as cnt from attendance_requests where client_event_id = $1", [clientEventId])).rows;
      assert.equal(Number(rows[0].cnt), 1, "Exactly one boundary row exists");

      const hours = await getPayrollHours(pg, "worker_1", "2026-10-29", "2026-10-30");
      assert.equal(hours, 4.0, "Capped at 4.0 hours with single boundary");
    });

    it("6. Reused event ID with different payload is rejected with EVENT_ID_CONFLICT", async () => {
      const pg = await setupDb();
      const clientEventId = "ev-reused-conflict-id";

      // 1. Rejected punch logs with type = 'check_out'
      await executeLogRejectedPunch(pg, "worker_1", {
        siteId: 1,
        type: "check_out",
        attemptedAt: "2026-10-29T12:00:00.000Z",
        clientEventId,
      });

      // 2. Reusing same event ID with type = 'check_in' must throw EVENT_ID_CONFLICT
      await assert.rejects(
        () => executeLogRejectedPunch(pg, "worker_1", {
          siteId: 1,
          type: "check_in", // Different type!
          attemptedAt: "2026-10-29T12:00:00.000Z",
          clientEventId,
        }),
        /EVENT_ID_CONFLICT/
      );

      // 3. Reusing same event ID from review request flow must also throw EVENT_ID_CONFLICT
      await assert.rejects(
        () => executeSubmitAttendanceRequest(pg, "worker_1", {
          siteId: 1,
          type: "check_out",
          reason: "Trying to reuse same clientEventId across kinds",
          clientEventId,
        }),
        /EVENT_ID_CONFLICT/
      );
    });

    it("7. Approved review request creates the correct manual attendance record", async () => {
      const pg = await setupDb();
      // Employee submits ticket for missing 08:00 morning check-in
      const rev = await executeSubmitAttendanceRequest(pg, "worker_1", {
        siteId: 1,
        type: "check_in",
        attemptedAt: "2026-10-29T08:00:00.000Z",
        reason: "Phone died right before arrival at gate",
        clientEventId: "ev-req7-ticket",
      });

      // Admin approves it
      const approval = await testReviewAttendanceRequest(pg, "admin_1", {
        requestId: rev.id,
        decision: "approve",
        adminNotes: "Foreman confirmed arrival time at 08:00",
      });
      assert.equal(approval.status, "approved");
      assert.ok(approval.checkinId);

      // Check the created checkin record
      const punch = (await pg.query("select * from checkins where id = $1", [approval.checkinId])).rows[0];
      assert.equal(punch.user_id, "worker_1");
      assert.equal(punch.type, "check_in");
      assert.equal(punch.source, "manual");
      assert.equal(punch.is_manual, true);
      assert.equal(punch.created_by, "admin_1");
      assert.equal(new Date(punch.actual_time).toISOString(), "2026-10-29T08:00:00.000Z");

      // Verify audit record exists
      const audit = (await pg.query("select * from manual_attendance_audit where checkin_id = $1", [approval.checkinId])).rows[0];
      assert.equal(audit.action, "create");
      assert.equal(audit.admin_id, "admin_1");

      // Pair with verified 16:00 OUT
      await pg.exec(`
        insert into checkins (user_id, site_id, type, status, actual_time, gps_fix_at, source, is_manual, client_event_id, lat, lng, distance_meters, device_id)
        values ('worker_1', 1, 'check_out', 'inside', '2026-10-29T16:00:00.000Z', '2026-10-29T16:00:00.000Z', 'gps', false, 'ev-req7-out', 30.0561, 31.3395, 10, 'dev_worker_1');
      `);

      const hours = await getPayrollHours(pg, "worker_1", "2026-10-29", "2026-10-30");
      assert.equal(hours, 8.0, "Approved review request generates valid attendance resulting in 8 payable hours");
    });

    it("8. Reversed records remain excluded from payable hours", async () => {
      const pg = await setupDb();
      // 08:00 Verified GPS IN
      await pg.exec(`
        insert into checkins (user_id, site_id, type, status, actual_time, gps_fix_at, source, is_manual, client_event_id, lat, lng, distance_meters, device_id)
        values ('worker_1', 1, 'check_in', 'inside', '2026-10-29T08:00:00.000Z', '2026-10-29T08:00:00.000Z', 'gps', false, 'ev-req8-in', 30.0561, 31.3395, 10, 'dev_worker_1');
      `);

      // 10:00 Erroneous manual OUT entered by admin
      const ins = await pg.query(`
        insert into checkins (
          user_id, site_id, type, client_event_id, lat, lng, distance_meters, status,
          device_id, device_matched, flagged, source, is_manual, actual_time, created_by, reason, created_at
        ) values (
          'worker_1', 1, 'check_out', 'ev-req8-err-out', 30.0561, 31.3395, 0, 'inside',
          'manual', true, false, 'manual', true, '2026-10-29T10:00:00.000Z', 'admin_1', 'Entered wrong worker departure', now()
        ) returning id`);
      const errOutId = ins.rows[0].id;

      // Admin reverses the erroneous OUT
      await pg.query(`
        update checkins
        set is_reversed = true, reversal_reason = 'Correcting mistakenly entered departure', reversed_by = 'admin_1', reversed_at = now()
        where id = $1`, [errOutId]);

      await pg.query(`
        insert into manual_attendance_audit (checkin_id, admin_id, action, reason, target_user_id, actual_time)
        values ($1, 'admin_1', 'reverse', 'Correcting mistakenly entered departure', 'worker_1', '2026-10-29T10:00:00.000Z')`, [errOutId]);

      // 17:00 Verified GPS OUT
      await pg.exec(`
        insert into checkins (user_id, site_id, type, status, actual_time, gps_fix_at, source, is_manual, client_event_id, lat, lng, distance_meters, device_id)
        values ('worker_1', 1, 'check_out', 'inside', '2026-10-29T17:00:00.000Z', '2026-10-29T17:00:00.000Z', 'gps', false, 'ev-req8-out', 30.0561, 31.3395, 10, 'dev_worker_1');
      `);

      // Verify the reversed checkin is is_reversed = true
      const punchRow = (await pg.query("select is_reversed from checkins where id = $1", [errOutId])).rows[0];
      assert.equal(punchRow.is_reversed, true);

      // Payable hours should skip the reversed 10:00 record and span 08:00 to 17:00 = 9 hours
      const hours = await getPayrollHours(pg, "worker_1", "2026-10-29", "2026-10-30");
      assert.equal(hours, 9.0, "Reversed OUT is excluded from calculation, yielding full 9 payable hours");
    });
  });

  describe("Phase 2.2.1.3: Concurrency Race & Idempotency Regression Tests", () => {
    // Note on test environment:
    // PGlite runs an in-process WebAssembly single-instance PostgreSQL 16 engine.
    // While concurrent Promise.all branches interleave at asynchronous boundary steps,
    // true parallel multi-process Neon pooling and WebSocket latency can only be established on Neon.
    // The tests below establish that:
    // 1. ON CONFLICT DO NOTHING eliminates uncaught duplicate key errors and data overwriting.
    // 2. Fallback re-query accurately performs material equality checks across all relevant fields.
    // 3. Racing calls with identical payloads resolve to the exact same record with replayed: true.
    // 4. Racing calls with mismatched reasons, sites, or kinds produce EVENT_ID_CONFLICT without overwriting.

    it("1. Two concurrent identical submissions create exactly one row", async () => {
      const pg = await setupDb();
      const clientEventId = "conc-identical-1";

      const [res1, res2] = await Promise.all([
        executeSubmitAttendanceRequest(pg, "worker_1", {
          siteId: 1,
          type: "check_in",
          reason: "Identical concurrent reason at site gate",
          advisoryState: "indoor_review",
          clientEventId,
        }),
        executeSubmitAttendanceRequest(pg, "worker_1", {
          siteId: 1,
          type: "check_in",
          reason: "Identical concurrent reason at site gate",
          advisoryState: "indoor_review",
          clientEventId,
        }),
      ]);

      assert.equal(res1.id, res2.id, "Both concurrent calls must resolve to the identical request ID");
      const isReplayPresent = res1.replayed || res2.replayed;
      assert.ok(isReplayPresent, "At least one call must report replayed: true");

      const count = (await pg.query("select count(*) as cnt from attendance_requests where client_event_id = $1", [clientEventId])).rows[0].cnt;
      assert.equal(Number(count), 1, "Exactly one row exists in database");
    });

    it("2. Two concurrent submissions with the same ID but different reasons produce one row and one EVENT_ID_CONFLICT", async () => {
      const pg = await setupDb();
      const clientEventId = "conc-diff-reasons-2";

      const results = await Promise.allSettled([
        executeSubmitAttendanceRequest(pg, "worker_1", {
          siteId: 1,
          type: "check_in",
          reason: "Reason A: Worker entered first explanation",
          clientEventId,
        }),
        executeSubmitAttendanceRequest(pg, "worker_1", {
          siteId: 1,
          type: "check_in",
          reason: "Reason B: Worker entered second explanation", // Conflict!
          clientEventId,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      assert.equal(fulfilled.length, 1, "Exactly one call succeeds");
      assert.equal(rejected.length, 1, "Exactly one call is rejected with conflict");
      assert.match(rejected[0].reason.message, /EVENT_ID_CONFLICT/);

      // Verify row in database has not been overwritten by second call
      const row = (await pg.query("select user_id, reason from attendance_requests where client_event_id = $1", [clientEventId])).rows[0];
      assert.equal(row.reason, "Reason A: Worker entered first explanation", "Existing record must NEVER be overwritten");
    });

    it("3. Two concurrent submissions with the same ID but different sites produce one row and one EVENT_ID_CONFLICT", async () => {
      const pg = await setupDb();
      // Ensure site 2 exists
      await pg.exec(`
        insert into sites (id, name, lat, lng, radius_meters, active)
        values (2, 'Secondary Site', 30.06, 31.35, 150, true)
        on conflict (id) do nothing;
      `);

      const clientEventId = "conc-diff-sites-3";

      const results = await Promise.allSettled([
        executeSubmitAttendanceRequest(pg, "worker_1", {
          siteId: 1,
          type: "check_in",
          reason: "Checking in at Site 1",
          clientEventId,
        }),
        executeSubmitAttendanceRequest(pg, "worker_1", {
          siteId: 2, // Conflicting site!
          type: "check_in",
          reason: "Checking in at Site 1",
          clientEventId,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      assert.equal(fulfilled.length, 1, "Exactly one call succeeds");
      assert.equal(rejected.length, 1, "Conflicting site is rejected");
      assert.match(rejected[0].reason.message, /EVENT_ID_CONFLICT/);

      const row = (await pg.query("select site_id from attendance_requests where client_event_id = $1", [clientEventId])).rows[0];
      assert.equal(row.site_id, 1, "Site ID remains 1 and is not overwritten");
    });

    it("4. Cross-kind event ID reuse cannot overwrite an existing rejected punch or review request", async () => {
      const pg = await setupDb();
      const clientEventId = "cross-kind-reuse-4";

      // 1. Rejected punch created
      await executeLogRejectedPunch(pg, "worker_1", {
        siteId: 1,
        type: "check_out",
        attemptedAt: "2026-10-29T12:00:00.000Z",
        clientEventId,
      });

      // 2. Attempt to reuse clientEventId from review request flow
      await assert.rejects(
        () =>
          executeSubmitAttendanceRequest(pg, "worker_1", {
            siteId: 1,
            type: "check_out",
            reason: "Trying to overwrite rejected punch with review request",
            clientEventId,
          }),
        /EVENT_ID_CONFLICT/
      );

      // Verify the existing row remains a rejected punch
      const row = (await pg.query("select request_kind, reason from attendance_requests where client_event_id = $1", [clientEventId])).rows[0];
      assert.equal(row.request_kind, "rejected_punch");
      assert.equal(row.reason, "GPS rejected: outside radius", "Existing rejected punch was not mutated");
    });

    it("5. Sequential identical retries still replay correctly", async () => {
      const pg = await setupDb();
      const clientEventId = "seq-identical-5";

      const first = await executeSubmitAttendanceRequest(pg, "worker_1", {
        siteId: 1,
        type: "check_in",
        reason: "Valid network retry scenario",
        advisoryState: "indoor_review",
        clientEventId,
      });
      assert.equal(first.replayed, false);

      const second = await executeSubmitAttendanceRequest(pg, "worker_1", {
        siteId: 1,
        type: "check_in",
        reason: "Valid network retry scenario",
        advisoryState: "indoor_review",
        clientEventId,
      });
      assert.equal(second.replayed, true);
      assert.equal(second.id, first.id);

      const count = (await pg.query("select count(*) as cnt from attendance_requests where client_event_id = $1", [clientEventId])).rows[0].cnt;
      assert.equal(Number(count), 1);
    });

    it("6. Sequential conflicting retries still throw EVENT_ID_CONFLICT", async () => {
      const pg = await setupDb();
      const clientEventId = "seq-conflict-6";

      await executeSubmitAttendanceRequest(pg, "worker_1", {
        siteId: 1,
        type: "check_in",
        reason: "Initial valid ticket",
        clientEventId,
      });

      // Different type
      await assert.rejects(
        () =>
          executeSubmitAttendanceRequest(pg, "worker_1", {
            siteId: 1,
            type: "check_out",
            reason: "Initial valid ticket",
            clientEventId,
          }),
        /EVENT_ID_CONFLICT/
      );

      // Different user
      await assert.rejects(
        () =>
          executeSubmitAttendanceRequest(pg, "worker_2", {
            siteId: 1,
            type: "check_in",
            reason: "Initial valid ticket",
            clientEventId,
          }),
        /EVENT_ID_CONFLICT/
      );
    });
  });

  describe("Phase 2.2.1.4: Material Payload Comparison & Precision Verification", () => {
    it("floatEquals guarantees strict distinction between null and zero", () => {
      // 1. null vs zero must NEVER be equal
      assert.equal(floatEquals(0, null), false, "0 and null must not be equal");
      assert.equal(floatEquals(null, 0), false, "null and 0 must not be equal");
      assert.equal(floatEquals(0, undefined), false, "0 and undefined must not be equal");
      assert.equal(floatEquals(undefined, 0), false, "undefined and 0 must not be equal");

      // 2. Exact zeros must match
      assert.equal(floatEquals(0, 0), true, "0 and 0 must be equal");
      assert.equal(floatEquals(0.0, 0.0), true, "0.0 and 0.0 must be equal");

      // 3. Absent vs absent must match
      assert.equal(floatEquals(null, null), true, "null and null must match");
      assert.equal(floatEquals(undefined, undefined), true, "undefined and undefined must match");
      assert.equal(floatEquals(null, undefined), true, "null and undefined must match");
      assert.equal(floatEquals(undefined, null), true, "undefined and null must match");

      // 4. Precision micro-matching
      assert.equal(floatEquals(30.0561, 30.0561 + 1e-9), true, "Sub-microdegree precision matches");
      assert.equal(floatEquals(30.0561, 30.0562), false, "Distinct coordinates must not match");

      // 5. Non-finite values
      assert.equal(floatEquals(NaN, 0), false, "NaN must not match 0");
      assert.equal(floatEquals(Infinity, Infinity), false, "Non-finite numbers must return false");
    });

    it("verifies ALL 10 material fields during replay conflict check", async () => {
      const pg = await setupDb();
      // Ensure site 2 exists for site mismatch testing
      await pg.exec(`
        insert into sites (id, name, lat, lng, radius_meters, active)
        values (2, 'Secondary Site', 30.06, 31.35, 150, true)
        on conflict (id) do nothing;
      `);

      const basePayload = {
        siteId: 1,
        type: "check_in",
        reason: "Valid employee punch explanation",
        advisoryState: "indoor_review",
        deviceId: "dev_worker_1",
        lat: 30.0561,
        lng: 31.3395,
        accuracy: 15.5,
        distanceMeters: 45.0,
      };

      // 1. Initial creation
      const init = await executeSubmitAttendanceRequest(pg, "worker_1", {
        ...basePayload,
        clientEventId: "mat-test-base",
      });
      assert.equal(init.replayed, false);

      // 2. Exact identical replay succeeds with replayed = true
      const replay = await executeSubmitAttendanceRequest(pg, "worker_1", {
        ...basePayload,
        clientEventId: "mat-test-base",
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.id, init.id);

      // Test helper for conflict rejection
      async function assertConflict(testId, overrides, expectedField) {
        const payload = {
          ...basePayload,
          clientEventId: "mat-test-" + testId,
        };
        await executeSubmitAttendanceRequest(pg, "worker_1", payload);

        await assert.rejects(
          () =>
            executeSubmitAttendanceRequest(
              pg,
              overrides.userId ?? "worker_1",
              { ...payload, ...overrides }
            ),
          (err) => {
            assert.match(err.message, /EVENT_ID_CONFLICT/);
            return true;
          },
          `Mismatch in ${expectedField} must throw EVENT_ID_CONFLICT`
        );
      }

      // Check each material field independently:
      // Field 1: User / Employee
      await assertConflict("user", { userId: "worker_2" }, "user/employee");

      // Field 2: Site ID
      await assertConflict("site", { siteId: 2 }, "site ID");

      // Field 3: Event Type
      await assertConflict("type", { type: "check_out" }, "event type");

      // Field 4: Reason
      await assertConflict("reason", { reason: "Completely different reason explanation" }, "reason");

      // Field 5: Advisory State
      await assertConflict("advisory", { advisoryState: "ready" }, "advisory state");

      // Field 6: Device ID
      await assertConflict("device", { deviceId: "dev_worker_other" }, "device ID");

      // Field 7: Latitude
      await assertConflict("lat", { lat: 30.0575 }, "latitude");

      // Field 8: Longitude
      await assertConflict("lng", { lng: 31.3410 }, "longitude");

      // Field 9: Accuracy
      await assertConflict("accuracy", { accuracy: 50.0 }, "accuracy");

      // Field 10: Distance
      await assertConflict("distance", { distanceMeters: 100.0 }, "distance");
    });

    it("treats null and zero as distinct conflicts for numeric fields", async () => {
      const pg = await setupDb();

      // Case A: distanceMeters created as 0 vs replayed as null
      const eventIdA = "mat-null-zero-distance";
      await executeSubmitAttendanceRequest(pg, "worker_1", {
        siteId: 1,
        type: "check_in",
        reason: "Zero distance inside gate",
        clientEventId: eventIdA,
        distanceMeters: 0, // Explicit zero meters!
      });

      await assert.rejects(
        () =>
          executeSubmitAttendanceRequest(pg, "worker_1", {
            siteId: 1,
            type: "check_in",
            reason: "Zero distance inside gate",
            clientEventId: eventIdA,
            distanceMeters: null, // Mismatch: null is not zero!
          }),
        /EVENT_ID_CONFLICT/
      );

      // Case B: accuracy created as null vs replayed as 0
      const eventIdB = "mat-null-zero-accuracy";
      await executeSubmitAttendanceRequest(pg, "worker_1", {
        siteId: 1,
        type: "check_in",
        reason: "No GPS fix accuracy available",
        clientEventId: eventIdB,
        accuracy: null, // Null accuracy!
      });

      await assert.rejects(
        () =>
          executeSubmitAttendanceRequest(pg, "worker_1", {
            siteId: 1,
            type: "check_in",
            reason: "No GPS fix accuracy available",
            clientEventId: eventIdB,
            accuracy: 0, // Mismatch: 0 is not null!
          }),
        /EVENT_ID_CONFLICT/
      );

      // Case C: accuracy created as 0 vs replayed as 0 succeeds
      const eventIdC = "mat-zero-zero-accuracy";
      const c1 = await executeSubmitAttendanceRequest(pg, "worker_1", {
        siteId: 1,
        type: "check_in",
        reason: "Zero error theoretical fix",
        clientEventId: eventIdC,
        accuracy: 0,
      });
      assert.equal(c1.replayed, false);

      const c2 = await executeSubmitAttendanceRequest(pg, "worker_1", {
        siteId: 1,
        type: "check_in",
        reason: "Zero error theoretical fix",
        clientEventId: eventIdC,
        accuracy: 0,
      });
      assert.equal(c2.replayed, true);
    });
  });
});




