import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// Temporary: fails the first time it runs on a machine and passes after, to exercise CI's rerun.
test("a probe that fails once per machine", () => {
  const marker = join(tmpdir(), "ci-flaky-probe");
  const first = !existsSync(marker);
  writeFileSync(marker, "");
  expect(first).toBe(false);
});
