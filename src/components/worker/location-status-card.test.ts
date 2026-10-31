import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateGpsAdvisory } from "../../lib/geo-advisory.ts";

describe("evaluateGpsAdvisory Unit Tests (Phase 1B.0.6 Specification)", () => {
  const R = 50; // 50m site radius

  it("1. Verified clean inside: D <= R and A <= 50m", () => {
    // Original Case A: R=50, D=25, A=12
    const res = evaluateGpsAdvisory(25, R, 12);
    assert.equal(res.state, "ready");
    assert.equal(res.inside, true);
    assert.equal(res.canPunch, true);
    assert.equal(res.distanceToBoundary, -25);
  });

  it("2. Verified exact boundary inside: D = R and A = 50m", () => {
    const res = evaluateGpsAdvisory(50, R, 50);
    assert.equal(res.state, "ready");
    assert.equal(res.inside, true);
    assert.equal(res.canPunch, true);
    assert.equal(res.distanceToBoundary, 0);
  });

  it("3. Verified perimeter allowance: 0 < delta <= 15m and A <= 20m", () => {
    // Original Case B: R=50, D=65 (delta = 15m), A=10
    const res = evaluateGpsAdvisory(65, R, 10);
    assert.equal(res.state, "ready");
    assert.equal(res.inside, true);
    assert.equal(res.canPunch, true);
    assert.equal(res.distanceToBoundary, 15);
  });

  it("4. Verified perimeter allowance exact boundary: delta = 15m and A = 20m", () => {
    const res = evaluateGpsAdvisory(65, R, 20);
    assert.equal(res.state, "ready");
    assert.equal(res.inside, true);
    assert.equal(res.canPunch, true);
    assert.equal(res.distanceToBoundary, 15);
  });

  it("4b. Exceeded perimeter allowance: delta = 30m and A = 20m (15m < delta <= 30m) -> pending review, NOT verified", () => {
    // R=50, D=80 (delta = 30m), A=20: outer perimeter requires review
    const res = evaluateGpsAdvisory(80, R, 20);
    assert.equal(res.state, "indoor_review");
    assert.equal(res.inside, false);
    assert.equal(res.canPunch, false); // Pending review punch submission disabled
    assert.equal(res.distanceToBoundary, 30);
  });

  it("5. Pending review degraded indoor: D <= R and 50m < A <= 150m", () => {
    // Original Case C: R=50, D=40, A=120
    const res = evaluateGpsAdvisory(40, R, 120);
    assert.equal(res.state, "indoor_review");
    assert.equal(res.inside, true);
    assert.equal(res.canPunch, false); // Disabled until backend migration 0007
    assert.equal(res.distanceToBoundary, -10);
  });

  it("6. Pending review perimeter uncertainty: 0 < delta <= 15m and A > 20m", () => {
    const res = evaluateGpsAdvisory(60, R, 35);
    assert.equal(res.state, "indoor_review");
    assert.equal(res.inside, false);
    assert.equal(res.canPunch, false);
    assert.equal(res.distanceToBoundary, 10);
  });

  it("7. Pending review outer perimeter: 15m < delta <= 30m and A <= 150m", () => {
    const res = evaluateGpsAdvisory(75, R, 25);
    assert.equal(res.state, "indoor_review");
    assert.equal(res.inside, false);
    assert.equal(res.canPunch, false);
    assert.equal(res.distanceToBoundary, 25);
  });

  it("8. Pending review overlapping uncertainty: delta > 30m but D - A <= R + 30m", () => {
    // R=50, D=81, A=30 => D - A = 51m <= R + 30m (80m)
    const res = evaluateGpsAdvisory(81, R, 30);
    assert.equal(res.state, "indoor_review");
    assert.equal(res.inside, false);
    assert.equal(res.canPunch, false);
    assert.equal(res.distanceToBoundary, 31);
  });

  it("9. Definitive outside: D - A > R + 30m (Circle does not touch permitted perimeter)", () => {
    // Original Case D: R=50, D=120, A=20 => D - A = 100m > 80m
    const res = evaluateGpsAdvisory(120, R, 20);
    assert.equal(res.state, "outside");
    assert.equal(res.inside, false);
    assert.equal(res.canPunch, false);
    assert.equal(res.distanceToBoundary, 70);
  });

  it("10. Definitive outside far: R=50, D=250, A=20", () => {
    // Original Case E
    const res = evaluateGpsAdvisory(250, R, 20);
    assert.equal(res.state, "outside");
    assert.equal(res.inside, false);
    assert.equal(res.canPunch, false);
    assert.equal(res.distanceToBoundary, 200);
  });

  it("11. Operational limit exceeded: A > 150m (cellular fallback)", () => {
    // Original Case F: R=50, D=10, A=350m
    const res = evaluateGpsAdvisory(10, R, 350);
    assert.equal(res.state, "insufficient_accuracy");
    assert.equal(res.canPunch, false);
  });

  it("12. Operational limit exact boundary: A = 150.1m", () => {
    const res = evaluateGpsAdvisory(25, R, 150.1);
    assert.equal(res.state, "insufficient_accuracy");
    assert.equal(res.canPunch, false);
  });

  it("13. Sub-metre accuracy valid without silent clamping: R=50, D=25, A=0.8m", () => {
    const res = evaluateGpsAdvisory(25, R, 0.8);
    assert.equal(res.state, "ready");
    assert.equal(res.inside, true);
    assert.equal(res.canPunch, true);
  });

  it("14. Sensor invalid: A <= 0, null, NaN, Infinity", () => {
    assert.equal(evaluateGpsAdvisory(25, R, 0).state, "insufficient_accuracy");
    assert.equal(evaluateGpsAdvisory(25, R, -5).state, "insufficient_accuracy");
    assert.equal(evaluateGpsAdvisory(25, R, Number.NaN).state, "insufficient_accuracy");
    assert.equal(evaluateGpsAdvisory(25, R, Number.POSITIVE_INFINITY).state, "insufficient_accuracy");
    assert.equal(evaluateGpsAdvisory(25, R, null).state, "insufficient_accuracy");
    assert.equal(evaluateGpsAdvisory(25, R, undefined).state, "insufficient_accuracy");
  });

  it("15. Coordinates / Site invalid: null distance, negative distance, zero or negative radius", () => {
    assert.equal(evaluateGpsAdvisory(null, R, 10).state, "locating");
    assert.equal(evaluateGpsAdvisory(-10, R, 10).state, "locating");
    assert.equal(evaluateGpsAdvisory(25, 0, 10).state, "locating");
    assert.equal(evaluateGpsAdvisory(25, -50, 10).state, "locating");
    assert.equal(evaluateGpsAdvisory(Number.NaN, R, 10).state, "locating");
  });
});

import { formatDurationMinutes } from "../../lib/duration.ts";

describe("formatDurationMinutes Unit Tests", () => {
  it("formats 531 minutes as 08h 51m", () => {
    assert.equal(formatDurationMinutes(531), "08h 51m");
  });

  it("formats 60 minutes as 01h 00m", () => {
    assert.equal(formatDurationMinutes(60), "01h 00m");
  });

  it("formats 59 minutes as 00h 59m", () => {
    assert.equal(formatDurationMinutes(59), "00h 59m");
  });

  it("formats 0 minutes as 00h 00m", () => {
    assert.equal(formatDurationMinutes(0), "00h 00m");
  });

  it("formats durations exceeding 24 hours correctly (e.g. 1500m -> 25h 00m)", () => {
    assert.equal(formatDurationMinutes(1500), "25h 00m");
    assert.equal(formatDurationMinutes(2880), "48h 00m");
  });

  it("handles negative or non-finite minutes gracefully", () => {
    assert.equal(formatDurationMinutes(-10), "00h 00m");
    assert.equal(formatDurationMinutes(Number.NaN), "00h 00m");
    assert.equal(formatDurationMinutes(Number.POSITIVE_INFINITY), "00h 00m");
  });

  describe("large-area sites (R > 500m): whole accuracy circle inside the geofence", () => {
    it("16. Screenshot case: R=3000, D=500, A=2000 -> certainly inside, can punch", () => {
      const res = evaluateGpsAdvisory(500, 3000, 2000);
      assert.equal(res.state, "ready");
      assert.equal(res.inside, true);
      assert.equal(res.canPunch, true);
    });

    it("17. Exact edge: D + A == R is still inside", () => {
      assert.equal(evaluateGpsAdvisory(1000, 3000, 2000).canPunch, true);
    });

    it("18. Accuracy circle crosses the boundary (D + A > R) stays blocked", () => {
      const res = evaluateGpsAdvisory(1500, 3000, 2000);
      assert.equal(res.state, "insufficient_accuracy");
      assert.equal(res.canPunch, false);
    });

    it("19. Coarse fix with centre OUTSIDE the radius never passes", () => {
      assert.equal(evaluateGpsAdvisory(3500, 3000, 400).canPunch, false);
    });

    it("20. Compact sites are untouched: R=200, D=10, A=180 still insufficient", () => {
      const res = evaluateGpsAdvisory(10, 200, 180);
      assert.equal(res.state, "insufficient_accuracy");
      assert.equal(res.canPunch, false);
    });

    it("21. Gate is strictly R > 500: R=500, D=10, A=400 stays blocked", () => {
      assert.equal(evaluateGpsAdvisory(10, 500, 400).canPunch, false);
    });

    it("22. Invalid accuracy never passes even on large sites", () => {
      assert.equal(evaluateGpsAdvisory(10, 3000, 0).canPunch, false);
      assert.equal(evaluateGpsAdvisory(10, 3000, null).canPunch, false);
      assert.equal(evaluateGpsAdvisory(10, 3000, Number.NaN).canPunch, false);
    });
  });
});
