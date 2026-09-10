import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectVerificationCommands, normalizeFailure } from "../extensions/gvs-lite/verifier.ts";

test("detects pnpm typecheck, lint and test scripts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gvs-lite-"));
  await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run" } }),
  );

  assert.deepEqual(await detectVerificationCommands(dir), [
    "CI=1 pnpm run 'typecheck'",
    "CI=1 pnpm run 'lint'",
    "CI=1 pnpm run 'test'",
  ]);
});

test("ignores npm init placeholder test script", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gvs-lite-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "echo \\\"Error: no test specified\\\" && exit 1" } }));
  assert.deepEqual(await detectVerificationCommands(dir), []);
});

test("normalizes unstable timing and cwd from failures", () => {
  const normalized = normalizeFailure("/tmp/project", "/tmp/project/a.ts failed in 12.4ms at 2026-09-10T12:00:00.123Z");
  assert.equal(normalized, "<cwd>/a.ts failed in <time> at <timestamp>");
});
