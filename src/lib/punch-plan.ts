import type { GpsAdvisoryState } from "./geo-advisory.ts";

/** At or above this, the fix is almost certainly "approximate location". */
export const APPROXIMATE_ACCURACY_M = 1000;

export type PunchType = "check_in" | "check_out";

export type PunchPlan = {
  type: PunchType;
  /** direct: recorded now. pending: sent for admin approval, unpaid until then.
   * waiting: a check-out request is already pending. blocked: no punch. */
  mode: "direct" | "pending" | "waiting" | "blocked";
};

export function planPunch(input: {
  isCheckedIn: boolean;
  /** Today's pending review requests, newest first. */
  pending: { type: string }[];
  state: GpsAdvisoryState;
  canPunch: boolean;
  distance: number | null;
  radius: number;
  accuracy: number | null;
  mock?: boolean;
}): PunchPlan {
  const latest = input.pending[0]?.type;
  if (input.isCheckedIn && latest === "check_out") return { type: "check_out", mode: "waiting" };

  // The shift only exists as a request so far: the server would refuse a direct
  // check-out, so the check-out has to be a request too.
  const checkInPending = !input.isCheckedIn && latest === "check_in";
  const type: PunchType = input.isCheckedIn || checkInPending ? "check_out" : "check_in";
  const plan = (mode: PunchPlan["mode"]): PunchPlan => ({ type, mode });

  const { distance, radius, accuracy } = input;
  if (distance == null || accuracy == null || !(accuracy > 0)) return plan("blocked");
  if (input.canPunch) return plan(checkInPending ? "pending" : "direct");

  const poor = input.state === "indoor_review" || input.state === "insufficient_accuracy";
  // The accuracy circle must at least touch the site.
  if (!poor || distance - accuracy > radius) return plan("blocked");
  if (type === "check_in") return plan(input.mock ? "blocked" : "pending");
  // Check-outs go through (server flags them) so shifts do not stay open.
  return plan(checkInPending ? "pending" : "direct");
}
