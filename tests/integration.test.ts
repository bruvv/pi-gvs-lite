import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import gvsLite from "../extensions/gvs-lite/index.ts";

test("verifier loop passes, retries, changes strategy, then hard-stops", async () => {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const sent: string[] = [];

  const pi = {
    on(name: string, fn: (event: any, ctx: any) => unknown) {
      const current = handlers.get(name) ?? [];
      current.push(fn);
      handlers.set(name, current);
    },
    registerCommand() {},
    sendUserMessage(message: string) {
      sent.push(message);
    },
    async exec(command: string, args: string[], options: { cwd?: string } = {}) {
      return await new Promise<{ stdout: string; stderr: string; code: number | null; killed: boolean }>((resolve) => {
        const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => (stdout += data));
        child.stderr.on("data", (data) => (stderr += data));
        child.on("error", (error) => resolve({ stdout, stderr: String(error), code: 1, killed: false }));
        child.on("close", (code) => resolve({ stdout, stderr, code, killed: false }));
      });
    },
  };

  gvsLite(pi as any);

  const emit = async (name: string, event: any, ctx: any) => {
    for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
  };

  const cwd = await mkdtemp(join(tmpdir(), "gvs-lite-integration-"));
  const ctx = {
    cwd,
    signal: undefined,
    hasUI: true,
    ui: { setStatus() {}, notify() {} },
    isProjectTrusted: () => true,
  };

  await pi.exec("git", ["init", "-q"], { cwd });
  await pi.exec("git", ["config", "user.email", "gvs-lite@example.invalid"], { cwd });
  await pi.exec("git", ["config", "user.name", "gvs-lite test"], { cwd });
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  await writeFile(join(cwd, "file.txt"), "base\n");
  await pi.exec("git", ["add", "."], { cwd });
  await pi.exec("git", ["commit", "-qm", "init"], { cwd });

  await emit("session_start", { type: "session_start" }, ctx);
  await emit("before_agent_start", { prompt: "Change the file", systemPrompt: "BASE" }, ctx);
  await emit("tool_call", { toolName: "write", input: { path: "file.txt" } }, ctx);
  await writeFile(join(cwd, "file.txt"), "changed\n");
  await emit("agent_settled", { type: "agent_settled" }, ctx);

  let status = JSON.parse(await readFile(join(cwd, ".pi/work/status.json"), "utf8"));
  assert.equal(status.state, "verified");
  assert.equal(sent.length, 0);

  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ scripts: { test: 'node -e "console.error(\\"boom\\"); process.exit(1)"' } }),
  );
  await emit("before_agent_start", { prompt: "Make another change", systemPrompt: "BASE" }, ctx);
  await emit("tool_call", { toolName: "write", input: { path: "file.txt" } }, ctx);
  await writeFile(join(cwd, "file.txt"), "changed again\n");
  await emit("agent_settled", { type: "agent_settled" }, ctx);
  assert.equal(sent.length, 1);

  await emit("before_agent_start", { prompt: sent.at(-1), systemPrompt: "BASE" }, ctx);
  await emit("agent_settled", { type: "agent_settled" }, ctx);
  assert.equal(sent.length, 2);
  assert.match(sent.at(-1) ?? "", /materially different approach/);

  await emit("before_agent_start", { prompt: sent.at(-1), systemPrompt: "BASE" }, ctx);
  await emit("agent_settled", { type: "agent_settled" }, ctx);
  status = JSON.parse(await readFile(join(cwd, ".pi/work/status.json"), "utf8"));
  assert.equal(status.state, "stuck");
  assert.equal(sent.length, 2);
});
