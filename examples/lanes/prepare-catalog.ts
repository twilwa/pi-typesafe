import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const exampleRoot = dirname(fileURLToPath(import.meta.url));
const arms = ["static", "adaptive", "smaller-model"] as const;
export type LaneArm = (typeof arms)[number];

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function sha256(value: object) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export async function prepareLaneCatalog(options: {
  arm: LaneArm;
  output: string;
  experimentalOptIn?: string[];
}) {
  const output = resolve(options.output);
  const artifact = resolve(output, "artifact");
  await mkdir(artifact, { recursive: true });
  for (const name of ["lane-core.mjs", "sol-pi.mjs", "README.md"])
    await copyFile(
      resolve(exampleRoot, "stand-ins", name),
      resolve(artifact, name),
    );
  await run("git", ["init", "-q", artifact]);
  await run("git", ["-C", artifact, "config", "user.name", "Lane Fixture"]);
  await run("git", [
    "-C",
    artifact,
    "config",
    "user.email",
    "lane-fixture@example.invalid",
  ]);
  await run("git", [
    "-C",
    artifact,
    "remote",
    "add",
    "origin",
    "https://github.com/example/pi-lane-fixtures.git",
  ]);
  await run("git", ["-C", artifact, "add", "."]);
  await run("git", ["-C", artifact, "commit", "-qm", "fixture"]);
  const commit = (
    await run("git", ["-C", artifact, "rev-parse", "HEAD"])
  ).stdout.trim();

  const catalog = JSON.parse(
    await readFile(resolve(exampleRoot, "extension-catalog.json"), "utf8"),
  ) as {
    extensions: Array<{
      source: { commit: string };
      compatibility: Array<{ evidence: Array<{ revision: string }> }>;
    }>;
  };
  for (const entry of catalog.extensions) {
    entry.source.commit = commit;
    for (const compatibility of entry.compatibility)
      for (const evidence of compatibility.evidence) evidence.revision = commit;
  }
  await writeFile(
    resolve(output, "extension-catalog.json"),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );

  const config = JSON.parse(
    await readFile(
      resolve(exampleRoot, `${options.arm}.catalog-config.json`),
      "utf8",
    ),
  ) as {
    catalog: {
      sha256: string;
      artifacts: Record<string, string>;
      experimental_opt_in: string[];
    };
  };
  config.catalog.sha256 = sha256(catalog);
  config.catalog.artifacts = Object.fromEntries(
    Object.keys(config.catalog.artifacts).map((id) => [id, "artifact"]),
  );
  config.catalog.experimental_opt_in = options.experimentalOptIn ?? [];
  const configPath = resolve(output, `${options.arm}.catalog-config.json`);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const arm = process.argv[2];
  const output = process.argv[3];
  const optIn = process.argv.slice(4);
  if (!arms.includes(arm as LaneArm) || !output)
    throw new Error(
      "Usage: node examples/lanes/prepare-catalog.ts <static|adaptive|smaller-model> <output> [experimental-extension ...]",
    );
  process.stdout.write(
    `${await prepareLaneCatalog({ arm: arm as LaneArm, output, experimentalOptIn: optIn })}\n`,
  );
}
