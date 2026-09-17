import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileContext } from "../../src/context.ts";

test("dangling symlink to an external new file is classified outside the repository", async (t) => {
  const fixture = await mkdtemp(resolve(".jev-context-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const repo = resolve(fixture, "repo");
  const outside = resolve(fixture, "outside");
  await mkdir(repo);
  await mkdir(outside);
  execFileSync("git", ["init", "-q", repo]);
  const target = resolve(outside, "new-file.ts");
  await symlink(target, resolve(repo, "out"));

  const context = await fileContext(repo, repo, "out");
  assert.equal(context.resolvedPath, target);
  assert.equal(context.status, "outside repository; not read");
  assert.equal(context.text, null);
});

for (const variant of [
  "internal",
  "chain",
  "symlinked parent",
  "relative target",
  "dangling directory",
  "target with parent traversal",
] as const) {
  test(`resolves a dangling symlink with ${variant}`, async (t) => {
    const fixture = await mkdtemp(resolve(".jev-context-"));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const repo = resolve(fixture, "repo");
    const outside = resolve(fixture, "outside");
    await mkdir(repo);
    await mkdir(outside);
    let target = resolve(outside, "new-file.ts");
    let path = "out";
    switch (variant) {
      case "internal":
        target = resolve(repo, "new-file.ts");
        await symlink(target, resolve(repo, path));
        break;
      case "chain":
        await symlink(target, resolve(repo, "hop"));
        await symlink("hop", resolve(repo, path));
        break;
      case "symlinked parent":
        await mkdir(resolve(outside, "directory"));
        await symlink("../new-file.ts", resolve(outside, "directory/out"));
        await symlink(resolve(outside, "directory"), resolve(repo, "parent"));
        path = "parent/out";
        break;
      case "relative target":
        await mkdir(resolve(repo, "links"));
        path = "links/out";
        await symlink("../../outside/new-file.ts", resolve(repo, path));
        break;
      case "dangling directory":
        target = resolve(outside, "new-dir/new-file.ts");
        await symlink(resolve(outside, "new-dir"), resolve(repo, "out"));
        path = "out/new-file.ts";
        break;
      case "target with parent traversal":
        await mkdir(resolve(outside, "directory"));
        await symlink(resolve(outside, "directory"), resolve(repo, "parent"));
        await symlink("parent/../new-file.ts", resolve(repo, path));
        break;
    }
    const context = await fileContext(repo, repo, path);
    assert.equal(context.resolvedPath, target);
    assert.equal(
      context.status,
      variant === "internal" ? "absent" : "outside repository; not read",
    );
    assert.equal(context.text, null);
  });
}

test("symlink loops fail context collection instead of being classified as absent", async (t) => {
  const repo = await mkdtemp(resolve(".jev-context-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await symlink("second", resolve(repo, "first"));
  await symlink("first", resolve(repo, "second"));
  await assert.rejects(fileContext(repo, repo, "first"), { code: "ELOOP" });
});
