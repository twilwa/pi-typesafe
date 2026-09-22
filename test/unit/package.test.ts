import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("package metadata includes every verified Pi release line", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as {
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  assert.equal(
    packageJson.devDependencies?.["@earendil-works/pi-coding-agent"],
    "0.85.1",
  );
  assert.equal(
    packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"],
    ">=0.85.1 <0.88.0",
  );
});
