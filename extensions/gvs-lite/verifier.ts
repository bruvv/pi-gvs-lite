import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GvsLiteConfig, VerificationCommandResult, VerificationSummary } from "./types.ts";

export async function detectVerificationCommands(cwd: string): Promise<string[]> {
  const explicit = await detectNodeCommands(cwd);
  if (explicit.length > 0) return explicit;

  if (await fileExists(join(cwd, "Cargo.toml"))) return ["cargo test --quiet"];
  if (await fileExists(join(cwd, "go.mod"))) return ["go test ./..."];

  const python = await detectPythonCommands(cwd);
  if (python.length > 0) return python;

  if (await fileExists(join(cwd, "gradlew"))) return ["./gradlew test"];
  if (await fileExists(join(cwd, "mvnw"))) return ["./mvnw -q test"];
  if (await fileExists(join(cwd, "pom.xml"))) return ["mvn -q test"];

  const makefile = (await fileExists(join(cwd, "Makefile"))) ? join(cwd, "Makefile") : join(cwd, "makefile");
  if (await fileExists(makefile)) {
    const content = await readFile(makefile, "utf8");
    if (/^test\s*:/m.test(content)) return ["make test"];
    if (/^check\s*:/m.test(content)) return ["make check"];
  }

  if (await containsTerraformFiles(cwd)) return ["terraform validate"];

  return [];
}

async function detectNodeCommands(cwd: string): Promise<string[]> {
  const packageJson = join(cwd, "package.json");
  if (!(await fileExists(packageJson))) return [];

  try {
    const pkg = JSON.parse(await readFile(packageJson, "utf8")) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const manager = await detectPackageManager(cwd);
    const names: string[] = [];

    for (const candidate of ["typecheck", "type-check", "check:types"]) {
      if (scripts[candidate]) {
        names.push(candidate);
        break;
      }
    }
    if (scripts.lint) names.push("lint");
    if (scripts.test && !/no test specified|exit 1/i.test(scripts.test)) names.push("test");
    if (names.length === 0 && scripts.check) names.push("check");

    return names.slice(0, 3).map((name) => runScript(manager, name));
  } catch {
    return [];
  }
}

async function detectPackageManager(cwd: string): Promise<"pnpm" | "bun" | "yarn" | "npm"> {
  if (await fileExists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if ((await fileExists(join(cwd, "bun.lock"))) || (await fileExists(join(cwd, "bun.lockb")))) return "bun";
  if (await fileExists(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

function runScript(manager: "pnpm" | "bun" | "yarn" | "npm", name: string): string {
  if (manager === "yarn") return `CI=1 yarn ${shellQuote(name)}`;
  if (manager === "npm" && name === "test") return "CI=1 npm test";
  return `CI=1 ${manager} run ${shellQuote(name)}`;
}

async function detectPythonCommands(cwd: string): Promise<string[]> {
  const pyprojectPath = join(cwd, "pyproject.toml");
  const hasPyproject = await fileExists(pyprojectPath);
  const pyproject = hasPyproject ? await readFile(pyprojectPath, "utf8") : "";
  const hasTests = await fileExists(join(cwd, "tests"));
  const hasPytestConfig =
    /\bpytest\b/i.test(pyproject) ||
    (await fileExists(join(cwd, "pytest.ini"))) ||
    (await fileExists(join(cwd, "conftest.py")));

  if (!hasPyproject && !hasTests && !hasPytestConfig) return [];

  const prefix = (await fileExists(join(cwd, "uv.lock"))) ? "uv run " : "";
  const commands: string[] = [];

  if (/\[tool\.ruff\]|\bruff\b/i.test(pyproject)) commands.push(`${prefix}ruff check .`);
  if (/\[tool\.mypy\]|\bmypy\b/i.test(pyproject)) commands.push(`${prefix}mypy .`);
  if (hasTests || hasPytestConfig) commands.push(`${prefix || "python3 -m "}pytest -q`);

  return commands.slice(0, 3);
}

async function containsTerraformFiles(cwd: string): Promise<boolean> {
  try {
    const names = await readdir(cwd);
    return names.some((name) => name.endsWith(".tf"));
  } catch {
    return false;
  }
}

export async function runVerification(
  pi: ExtensionAPI,
  cwd: string,
  config: GvsLiteConfig,
  signal?: AbortSignal,
): Promise<VerificationSummary> {
  const commands = config.verify.commands ?? (await detectVerificationCommands(cwd));
  const results: VerificationCommandResult[] = [];

  for (const command of commands) {
    const result = await runShell(pi, cwd, command, config.verify.timeoutMs, config.verify.outputMaxChars, signal);
    results.push(result);
    if (result.code !== 0) {
      return {
        attempted: results.length,
        passed: false,
        commands: results,
        failedCommand: result,
        signature: failureSignature(cwd, result),
      };
    }
  }

  return { attempted: results.length, passed: true, commands: results };
}

async function runShell(
  pi: ExtensionAPI,
  cwd: string,
  command: string,
  timeoutMs: number,
  outputMaxChars: number,
  signal?: AbortSignal,
): Promise<VerificationCommandResult> {
  const shell = process.platform === "win32" ? "powershell.exe" : process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];

  try {
    const result = await pi.exec(shell, args, { cwd, timeout: timeoutMs, signal });
    const stdout = tail(result.stdout ?? "", outputMaxChars);
    const stderr = tail(result.stderr ?? "", outputMaxChars);
    const output = tail([stdout, stderr].filter(Boolean).join("\n"), outputMaxChars);
    return { command, code: result.code ?? 1, stdout, stderr, output };
  } catch (error) {
    const output = tail(error instanceof Error ? error.message : String(error), outputMaxChars);
    return { command, code: 1, stdout: "", stderr: output, output };
  }
}

export function failureSignature(cwd: string, result: VerificationCommandResult): string {
  const normalized = normalizeFailure(cwd, `${result.command}\n${result.code}\n${result.output}`);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function normalizeFailure(cwd: string, text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(cwd).join("<cwd>")
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|sec|seconds)\b/gi, "<time>")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function tail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `[output truncated; keeping last ${maxChars} chars]\n${value.slice(-maxChars)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
