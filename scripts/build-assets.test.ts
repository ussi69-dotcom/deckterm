import { expect, test } from "bun:test";
import { verifyAssets } from "./build-assets";

test("committed self-hosted assets match their pinned sources byte-for-byte", () => {
  expect(verifyAssets()).toEqual([]);
});
