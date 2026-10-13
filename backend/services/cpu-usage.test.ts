import { describe, expect, test } from "bun:test";
import {
  cpuUsagePercentBetween,
  createCpuUsageMeter,
  sampleCpuTimes,
} from "./cpu-usage";

const cpu = (busy: number, idle: number) => ({
  times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
});

describe("cpu usage from deltas", () => {
  test("sums busy/idle time over all cores", () => {
    expect(sampleCpuTimes([cpu(10, 90), cpu(30, 70)])).toEqual({
      idle: 160,
      total: 200,
    });
  });

  test("usage is busy share of the elapsed window, not since boot", () => {
    // Since boot: 10% busy. In the last window: 50 busy of 100 → 50%.
    const previous = { idle: 900, total: 1000 };
    const next = { idle: 950, total: 1100 };
    expect(cpuUsagePercentBetween(previous, next)).toBe(50);
  });

  test("an empty or backwards window yields null", () => {
    expect(
      cpuUsagePercentBetween({ idle: 5, total: 10 }, { idle: 5, total: 10 }),
    ).toBeNull();
    expect(
      cpuUsagePercentBetween({ idle: 5, total: 10 }, { idle: 1, total: 4 }),
    ).toBeNull();
  });

  test("result is clamped to 0..100", () => {
    expect(
      cpuUsagePercentBetween({ idle: 0, total: 0 }, { idle: 0, total: 10 }),
    ).toBe(100);
    expect(
      cpuUsagePercentBetween({ idle: 0, total: 0 }, { idle: 12, total: 10 }),
    ).toBe(0);
  });
});

describe("createCpuUsageMeter", () => {
  test("measures between consecutive reads and keeps the last value for very short windows", async () => {
    let clock = 0;
    const samples = [
      [cpu(100, 900)], // first read
      [cpu(100, 900)], // after the priming wait
      [cpu(150, 950)], // +10 s: 50 busy / 100 → 50%
      // (+100 ms: too short a window — no sample taken, keeps 50)
      [cpu(160, 1040)], // +10 s: 10 busy of 100 since the 50% sample
    ];
    let index = 0;
    const waits: number[] = [];
    const meter = createCpuUsageMeter({
      readCpus: () => samples[Math.min(index++, samples.length - 1)]!,
      now: () => clock,
      wait: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      primeWindowMs: 200,
      minWindowMs: 1000,
    });

    // First read has no previous sample → measure over a short priming window.
    expect(await meter.read()).toBe(0);
    expect(waits).toEqual([200]);

    clock += 10_000;
    expect(await meter.read()).toBe(50);
    clock += 100;
    expect(await meter.read()).toBe(50);
    clock += 10_000;
    expect(await meter.read()).toBe(10);
    expect(index).toBe(4);
  });
});
