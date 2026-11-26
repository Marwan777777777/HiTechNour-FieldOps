import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planPunch } from "./punch-plan.ts";
import { evaluateGpsAdvisory } from "./geo-advisory.ts";

function plan(d: number, r: number, a: number, extra: Partial<Parameters<typeof planPunch>[0]> = {}) {
  const adv = evaluateGpsAdvisory(d, r, a);
  return planPunch({
    isCheckedIn: false, pending: [], state: adv.state, canPunch: adv.canPunch,
    distance: d, radius: r, accuracy: a, ...extra,
  });
}

describe("planPunch", () => {
  it("good fix checks in directly", () => assert.equal(plan(10, 500, 8).mode, "direct"));
  it("approximate fix touching the site is pending", () => assert.equal(plan(0, 500, 2000).mode, "pending"));
  it("indoor 50-150m fix is pending", () => assert.equal(plan(40, 50, 120).mode, "pending"));
  it("approximate fix far from the site is blocked", () => assert.equal(plan(26000, 500, 2000).mode, "blocked"));
  it("mock reading cannot request a check-in", () => assert.equal(plan(0, 500, 2000, { mock: true }).mode, "blocked"));
  it("precise outside is blocked", () => assert.equal(plan(900, 500, 10).mode, "blocked"));
  it("poor-fix check-out goes through", () =>
    assert.deepEqual(plan(0, 500, 2000, { isCheckedIn: true }), { type: "check_out", mode: "direct" }));
  it("after a pending check-in, check-out is also pending", () => {
    const pending = [{ type: "check_in" }];
    assert.deepEqual(plan(10, 500, 8, { pending }), { type: "check_out", mode: "pending" });
    assert.deepEqual(plan(0, 500, 2000, { pending }), { type: "check_out", mode: "pending" });
  });
  it("does not allow a second check-out request", () =>
    assert.equal(plan(10, 500, 8, { isCheckedIn: true, pending: [{ type: "check_out" }] }).mode, "waiting"));
});
