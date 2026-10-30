export type GpsAdvisoryState =
  | "ready"
  | "indoor_review"
  | "insufficient_accuracy"
  | "outside"
  | "locating"
  | "permission_denied";

export function evaluateGpsAdvisory(
  distanceMeters: number | null,
  radiusMeters: number,
  accuracyMeters: number | null | undefined
): {
  state: GpsAdvisoryState;
  distanceToBoundary: number | null;
  inside: boolean;
  canPunch: boolean;
} {
  if (
    distanceMeters == null ||
    !Number.isFinite(distanceMeters) ||
    distanceMeters < 0 ||
    !Number.isFinite(radiusMeters) ||
    radiusMeters <= 0
  ) {
    return { state: "locating", distanceToBoundary: null, inside: false, canPunch: false };
  }

  const D = distanceMeters;
  const R = radiusMeters;
  const delta = D - R;
  const B_auto = 15.0;
  const B_max = 30.0;

  // 1. Accuracy Sanity / Operational Limit / Invalid (<= 0, null, NaN, Infinity, > 150m)
  if (
    accuracyMeters == null ||
    !Number.isFinite(accuracyMeters) ||
    accuracyMeters <= 0 ||
    accuracyMeters > 150.0
  ) {
    return {
      state: "insufficient_accuracy",
      distanceToBoundary: Math.round(delta),
      inside: delta <= 0,
      canPunch: false,
    };
  }

  // Preserve raw measured accuracy with zero silent clamping
  const A = accuracyMeters;

  // 2. Definitive Outside (no overlap)
  if (D - A > R + B_max) {
    return {
      state: "outside",
      distanceToBoundary: Math.round(delta),
      inside: false,
      canPunch: false,
    };
  }

  // 3. Estimated Location Inside Radius (delta <= 0)
  if (delta <= 0) {
    if (A <= 50.0) {
      return {
        state: "ready",
        distanceToBoundary: Math.round(delta),
        inside: true,
        canPunch: true,
      };
    }
    // Degraded accuracy inside (50m < A <= 150m)
    // Note: Backend does not yet support review_decision routing; disable punch submission
    return {
      state: "indoor_review",
      distanceToBoundary: Math.round(delta),
      inside: true,
      canPunch: false,
    };
  }

  // 4. Operational Perimeter Buffer (0 < delta <= B_auto, i.e. 15m)
  if (delta <= B_auto) {
    if (A <= 20.0) {
      return {
        state: "ready",
        distanceToBoundary: Math.round(delta),
        inside: true,
        canPunch: true,
      };
    }
    return {
      state: "indoor_review",
      distanceToBoundary: Math.round(delta),
      inside: false,
      canPunch: false,
    };
  }

  // 5. Outer Perimeter (15m < delta <= 30m) or Overlapping Uncertainty
  if (delta <= B_max || D - A <= R + B_max) {
    return {
      state: "indoor_review",
      distanceToBoundary: Math.round(delta),
      inside: false,
      canPunch: false,
    };
  }

  return {
    state: "outside",
    distanceToBoundary: Math.round(delta),
    inside: false,
    canPunch: false,
  };
}
