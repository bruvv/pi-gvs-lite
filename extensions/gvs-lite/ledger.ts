import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GvsLiteConfig, GvsStatus } from "./types.ts";

export interface LedgerPaths {
  root: string;
  goal: string;
  plan: string;
  findings: string;
  status: string;
}

export function getLedgerPaths(cwd: string, configDirName: string): LedgerPaths {
  const root = join(cwd, configDirName, "work");
  return {
    root,
    goal: join(root, "goal.md"),
    plan: join(root, "plan.md"),
    findings: join(root, "findings.md"),
    status: join(root, "status.json"),
  };
}

export function newStatus(now = new Date()): GvsStatus {
  const iso = now.toISOString();
  return {
    version: 1,
    state: "active",
    createdAt: iso,
    updatedAt: iso,
    goalStartedAt: iso,
    modifiedFiles: [],
    verification: {
      attempts: 0,
      consecutiveSameFailure: 0,
      lastSignature: null,
      lastCommand: null,
      lastPassed: null,
      lastRunAt: null,
    },
    notes: [],
  };
}

export async function ensureLedger(
  paths: LedgerPaths,
  initialGoal: string | null,
  config: GvsLiteConfig,
): Promise<GvsStatus> {
  await mkdir(paths.root, { recursive: true });

  let status = await readStatus(paths);
  if (!status) {
    status = newStatus();
    await writeStatus(paths, status);
  }

  if (!(await exists(paths.goal))) {
    await atomicWrite(paths.goal, renderGoal(initialGoal ?? "Goal not set yet.", config.ledger.goalMaxChars));
  }
  if (!(await exists(paths.plan))) {
    await atomicWrite(
      paths.plan,
      "# Plan\n\nKeep only the current plan. Replace obsolete steps instead of appending a history.\n",
    );
  }
  if (!(await exists(paths.findings))) {
    await atomicWrite(
      paths.findings,
      "# Findings\n\nKeep only durable facts, decisions, constraints, and failed approaches that still matter.\n",
    );
  }

  await compactLedgerFiles(paths, config);
  return (await readStatus(paths)) ?? status;
}

export async function resetLedger(
  paths: LedgerPaths,
  goal: string,
  config: GvsLiteConfig,
): Promise<GvsStatus> {
  await mkdir(paths.root, { recursive: true });
  const status = newStatus();
  await Promise.all([
    atomicWrite(paths.goal, renderGoal(goal, config.ledger.goalMaxChars)),
    atomicWrite(paths.plan, "# Plan\n\n- Define the smallest correct next steps for this goal.\n"),
    atomicWrite(paths.findings, "# Findings\n\n- No durable findings yet.\n"),
    writeStatus(paths, status),
  ]);
  return status;
}

function renderGoal(goal: string, maxChars: number): string {
  return `# Goal\n\n${compactText(goal.trim() || "Goal not set yet.", maxChars)}\n`;
}

export async function readLedger(paths: LedgerPaths, config: GvsLiteConfig) {
  const [goal, plan, findings, status] = await Promise.all([
    safeRead(paths.goal),
    safeRead(paths.plan),
    safeRead(paths.findings),
    readStatus(paths),
  ]);

  return {
    goal: compactText(goal, config.ledger.goalMaxChars),
    plan: compactText(plan, config.ledger.planMaxChars),
    findings: compactText(findings, config.ledger.findingsMaxChars),
    status: status ?? newStatus(),
  };
}

export async function compactLedgerFiles(paths: LedgerPaths, config: GvsLiteConfig): Promise<string[]> {
  const changes: string[] = [];
  for (const [name, path, max] of [
    ["goal.md", paths.goal, config.ledger.goalMaxChars],
    ["plan.md", paths.plan, config.ledger.planMaxChars],
    ["findings.md", paths.findings, config.ledger.findingsMaxChars],
  ] as const) {
    const value = await safeRead(path);
    if (!value || value.length <= max) continue;
    await atomicWrite(path, compactText(value, max));
    changes.push(name);
  }
  return changes;
}

export function compactText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "\n\n[... older/less critical material pruned by gvs-lite ...]\n\n";
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;
  return text.slice(0, head).trimEnd() + marker + text.slice(-tail).trimStart();
}

export async function readStatus(paths: LedgerPaths): Promise<GvsStatus | null> {
  try {
    const parsed = JSON.parse(await readFile(paths.status, "utf8"));
    if (!parsed || parsed.version !== 1) return null;
    return parsed as GvsStatus;
  } catch {
    return null;
  }
}

export async function writeStatus(paths: LedgerPaths, status: GvsStatus): Promise<void> {
  status.updatedAt = new Date().toISOString();
  await atomicWrite(paths.status, `${JSON.stringify(status, null, 2)}\n`);
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
