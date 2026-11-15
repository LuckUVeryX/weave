import { describe, expect, test } from "vitest";

import { CycleMeter } from "../src/client/habitat/cycle.ts";

describe("cycle meter", () => {
  test("waits for one wall-clock second", () => {
    const meter = new CycleMeter();
    meter.record(0, 1);
    meter.record(500, 1);

    expect(meter.stats().seconds).toBe(0);
  });

  test("separates simulation steps from rendered frames", () => {
    const meter = new CycleMeter();
    meter.record(0, 1);
    for (let frame = 1; frame <= 60; frame += 1) meter.record(frame * (1000 / 60), 0.5);

    const sample = meter.stats();
    expect(sample.seconds).toBeCloseTo(1000 / 1000, 2);
    expect(sample.sps).toBeCloseTo(30, 0);
    expect(sample.fps).toBeCloseTo(60, 0);
    expect(sample.frameMilliseconds).toBeCloseTo(1000 / 60, 1);
  });

  test("starts a new window after each sample", () => {
    const meter = new CycleMeter();
    meter.record(0, 0);
    meter.record(1000, 60);
    const first = meter.stats();

    meter.record(2000, 30);
    const second = meter.stats();

    expect(first.sps).toBeCloseTo(60, 0);
    expect(second.sps).toBeCloseTo(30, 0);
    expect(second.fps).toBeCloseTo(1, 0);
  });
});
