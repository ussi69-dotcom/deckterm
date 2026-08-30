import { test, expect } from "bun:test";
import { formatByteSize } from "./format-bytes.js";

test("formatByteSize walks the B / KB / MB / GB ladder", () => {
  expect(formatByteSize(0)).toBe("0 B");
  expect(formatByteSize(512)).toBe("512 B");
  expect(formatByteSize(1023)).toBe("1023 B");
  expect(formatByteSize(1024)).toBe("1.0 KB");
  expect(formatByteSize(1536)).toBe("1.5 KB");
  expect(formatByteSize(1024 * 1024)).toBe("1.0 MB");
  expect(formatByteSize(1536 * 1024)).toBe("1.5 MB");
});

// The regression: sizes of 1 GiB and up used to keep counting in megabytes, so
// a 1.5 GB file read as "1536.0 MB".
test("formatByteSize switches to GB at 1 GiB and up", () => {
  const GB = 1024 * 1024 * 1024;
  expect(formatByteSize(GB - 1)).toBe("1024.0 MB");
  expect(formatByteSize(GB)).toBe("1.0 GB");
  expect(formatByteSize(1536 * 1024 * 1024)).toBe("1.5 GB");
  expect(formatByteSize(10.25 * GB)).toBe("10.3 GB");
  expect(formatByteSize(2048 * GB)).toBe("2048.0 GB");
});

test("formatByteSize returns an empty string for non-numeric input", () => {
  expect(formatByteSize(NaN)).toBe("");
  expect(formatByteSize(Infinity)).toBe("");
  expect(formatByteSize("nope")).toBe("");
});
