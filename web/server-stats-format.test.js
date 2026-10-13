import { test, expect } from "bun:test";
import { describeServerStats, statLevel } from "./server-stats-format";

const GB = 1024 * 1024 * 1024;

test("statLevel uses warn/danger thresholds", () => {
  expect(statLevel(10)).toBe("");
  expect(statLevel(70)).toBe("warning");
  expect(statLevel(95)).toBe("danger");
  expect(statLevel(85, 80, 95)).toBe("warning");
  expect(statLevel(Number.NaN)).toBe("");
});

test("describeServerStats: short chip values plus exact tooltips", () => {
  const chips = describeServerStats({
    cpu: { usage: 4 },
    memory: {
      percent: 12,
      totalBytes: 64 * GB,
      availableBytes: 56 * GB,
    },
    disk: { percent: 79 },
  });
  expect(chips.map((c) => [c.id, c.label, c.value, c.level])).toEqual([
    ["cpu", "CPU", "4%", ""],
    ["ram", "RAM", "12%", ""],
    ["disk", "Disk", "79%", ""],
  ]);
  expect(chips[0].title).toBe("CPU: 4% busy");
  expect(chips[1].title).toBe(
    "Memory: 12% in use (8.0 GB of 64.0 GB; 56.0 GB available)",
  );
  expect(chips[2].title).toBe("Disk: 79% full");
});

test("describeServerStats: disk warns later than CPU/RAM; missing data shows --", () => {
  const chips = describeServerStats({
    cpu: { usage: 91 },
    memory: { percent: 75 },
    disk: { percent: 85 },
  });
  expect(chips.map((c) => c.level)).toEqual(["danger", "warning", "warning"]);
  expect(chips[1].title).toBe("Memory: 75% in use");

  const empty = describeServerStats(null);
  expect(empty.map((c) => c.value)).toEqual(["--%", "--%", "--%"]);
  expect(empty.every((c) => c.level === "")).toBe(true);
  expect(empty[0].title).toBe("CPU: no data yet");
});
