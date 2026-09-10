import { relative, resolve } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { workspaceFingerprint } from "./fingerprint.ts";
import {
  compactLedgerFiles,
  ensureLedger,
  getLedgerPaths,
  readLedger,
  readStatus,
  resetLedger,
  writeStatus,
} from "./ledger.ts";
import type { GvsLiteConfig, GvsStatus, VerificationSummary } from "./types.ts";
import { runVerification } from "./verifier.ts";

const AUTO_PROMPT_PREFIX = "[GVS-LITE VERIFY FAILURE]";

export default function gvsLite(pi: ExtensionAPI) {
  let cwd = process.cwd();
  let config: GvsLiteConfig | null = null;
  let status: GvsStatus | null = null;
  let baselineFingerprint: string | null = null;
  let mutationSeen = false;
  let forceVerifyOnSettle = false;
  let autoPromptPending = false;
  let verifierRunning = false;
  const modifiedFiles = new Set<string>();

  async function refreshConfig(ctx: { cwd: string; isProjectTrusted(): boolean }) {
    cwd = ctx.cwd;
    config = ctx.isProjectTrusted()
      ? await loadConfig(cwd, CONFIG_DIR_NAME)
      : { ...(await loadConfig("/__gvs_lite_no_config__", CONFIG_DIR_NAME)), enabled: false };
    return config;
  }

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    config = await refreshConfig(ctx);
    if (!ctx.isProjectTrusted()) {
      ctx.ui.setStatus("gvs-lite", "GVS: disabled (untrusted project)");
      return;
    }
    const paths = getLedgerPaths(cwd, CONFIG_DIR_NAME);
    status = await readStatus(paths);
    ctx.ui.setStatus("gvs-lite", status ? formatStatus(status) : "GVS: ready");
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const cfg = await refreshConfig(ctx);
    if (!cfg.enabled || !ctx.isProjectTrusted()) return;

    const paths = getLedgerPaths(cwd, CONFIG_DIR_NAME);
    status = await ensureLedger(paths, null, cfg);

    const isAutoRepair = autoPromptPending || event.prompt.startsWith(AUTO_PROMPT_PREFIX);
    autoPromptPending = false;

    if (!isAutoRepair && shouldStartNewGoal(status, await readLedger(paths, cfg))) {
      status = await resetLedger(paths, event.prompt, cfg);
    } else if (!isAutoRepair && isPlaceholderGoal((await readLedger(paths, cfg)).goal)) {
      status = await resetLedger(paths, event.prompt, cfg);
    }

    mutationSeen = false;
    modifiedFiles.clear();
    baselineFingerprint = await safeFingerprint(pi, cwd);

    const ledger = await readLedger(paths, cfg);
    const systemPrompt = `${event.systemPrompt}\n\n${renderLedgerInstructions(ledger.goal, ledger.plan, ledger.findings, ledger.status)}`;
    return { systemPrompt };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!config?.enabled || !ctx.isProjectTrusted()) return;

    if (event.toolName === "edit" || event.toolName === "write") {
      const path = getPathFromInput(event.input);
      if (path && !isLedgerPath(path, cwd)) {
        mutationSeen = true;
        modifiedFiles.add(normalizeDisplayPath(path, cwd));
      }
      return;
    }

    if (event.toolName === "bash" || event.toolName === "powershell") {
      const command = typeof event.input?.command === "string" ? event.input.command : "";
      if (looksMutating(command)) mutationSeen = true;
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!config?.enabled || !ctx.isProjectTrusted()) return;
    if (event.isError) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const path = getPathFromInput(event.input);
    if (!path || !isLedgerPath(path, cwd)) return;
    await compactLedgerFiles(getLedgerPaths(cwd, CONFIG_DIR_NAME), config);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const cfg = config ?? (await refreshConfig(ctx));
    if (!cfg.enabled || !ctx.isProjectTrusted() || verifierRunning) return;

    const paths = getLedgerPaths(cwd, CONFIG_DIR_NAME);
    await compactLedgerFiles(paths, cfg);
    status = (await readStatus(paths)) ?? (await ensureLedger(paths, null, cfg));

    const fingerprintAfter = await safeFingerprint(pi, cwd);
    const changedByFingerprint =
      baselineFingerprint !== null && fingerprintAfter !== null && baselineFingerprint !== fingerprintAfter;
    const shouldVerify = mutationSeen || changedByFingerprint || forceVerifyOnSettle;
    forceVerifyOnSettle = false;

    if (!shouldVerify) {
      ctx.ui.setStatus("gvs-lite", formatStatus(status));
      return;
    }

    for (const file of modifiedFiles) {
      if (!status.modifiedFiles.includes(file)) status.modifiedFiles.push(file);
    }

    verifierRunning = true;
    try {
      status.state = "verifying";
      await writeStatus(paths, status);
      ctx.ui.setStatus("gvs-lite", "GVS: verifying");

      const result = await runVerification(pi, cwd, cfg, ctx.signal);
      await handleVerificationResult(pi, ctx, paths, cfg, status, result, () => {
        autoPromptPending = true;
        forceVerifyOnSettle = true;
      });
      status = (await readStatus(paths)) ?? status;
      ctx.ui.setStatus("gvs-lite", formatStatus(status));
    } finally {
      verifierRunning = false;
    }
  });

  pi.registerCommand("gvs-status", {
    description: "Show gvs-lite goal, state and verification status",
    handler: async (_args, ctx) => {
      const cfg = await refreshConfig(ctx);
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("gvs-lite is disabled because this project is not trusted.", "warning");
        return;
      }
      const paths = getLedgerPaths(ctx.cwd, CONFIG_DIR_NAME);
      const ledger = await readLedger(paths, cfg);
      const lines = [
        `State: ${ledger.status.state}`,
        `Verification attempts: ${ledger.status.verification.attempts}`,
        `Same failure count: ${ledger.status.verification.consecutiveSameFailure}`,
        `Last command: ${ledger.status.verification.lastCommand ?? "none"}`,
        `Modified files: ${ledger.status.modifiedFiles.length}`,
        "",
        ledger.goal.trim(),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("gvs-reset", {
    description: "Reset the gvs-lite ledger; optional argument becomes the new goal",
    handler: async (args, ctx) => {
      const cfg = await refreshConfig(ctx);
      if (!cfg.enabled || !ctx.isProjectTrusted()) return;
      const goal = args.trim() || "Goal not set yet.";
      status = await resetLedger(getLedgerPaths(ctx.cwd, CONFIG_DIR_NAME), goal, cfg);
      mutationSeen = false;
      forceVerifyOnSettle = false;
      autoPromptPending = false;
      ctx.ui.setStatus("gvs-lite", formatStatus(status));
      ctx.ui.notify("gvs-lite ledger reset.", "info");
    },
  });

  pi.registerCommand("gvs-verify", {
    description: "Run the detected/configured verification commands now",
    handler: async (_args, ctx) => {
      const cfg = await refreshConfig(ctx);
      if (!cfg.enabled || !ctx.isProjectTrusted()) return;
      const paths = getLedgerPaths(ctx.cwd, CONFIG_DIR_NAME);
      status = (await readStatus(paths)) ?? (await ensureLedger(paths, null, cfg));
      ctx.ui.setStatus("gvs-lite", "GVS: verifying");
      const result = await runVerification(pi, ctx.cwd, cfg);
      applyVerificationState(status, result, cfg);
      await writeStatus(paths, status);
      ctx.ui.setStatus("gvs-lite", formatStatus(status));
      if (result.attempted === 0) {
        ctx.ui.notify("No verification command could be detected. Configure .pi/gvs-lite.json.", "warning");
      } else if (result.passed) {
        ctx.ui.notify(`Verification passed (${result.attempted} command(s)).`, "info");
      } else {
        ctx.ui.notify(formatFailure(result), "error");
      }
    },
  });
}

async function handleVerificationResult(
  pi: ExtensionAPI,
  ctx: any,
  paths: ReturnType<typeof getLedgerPaths>,
  config: GvsLiteConfig,
  status: GvsStatus,
  result: VerificationSummary,
  beforeAutoPrompt: () => void,
) {
  applyVerificationState(status, result, config);

  if (result.attempted === 0) {
    status.state = "unverified";
    pushNote(status, "No verification command detected. Add verify.commands to .pi/gvs-lite.json if needed.");
    await writeStatus(paths, status);
    return;
  }

  if (result.passed) {
    status.state = "verified";
    pushNote(status, `Verification passed (${result.attempted} command(s)).`);
    await writeStatus(paths, status);
    if (ctx.hasUI) ctx.ui.notify(`GVS verify passed (${result.attempted} command(s)).`, "info");
    return;
  }

  const sameCount = status.verification.consecutiveSameFailure;
  const attempts = status.verification.attempts;
  const hardStop = sameCount >= config.stuck.hardStopThreshold || attempts >= config.verify.maxAutoRetries;
  const needsDifferentApproach = sameCount >= config.stuck.sameFailureThreshold;

  if (hardStop) {
    status.state = "stuck";
    pushNote(status, `Auto-repair stopped after ${attempts} failed verification attempt(s).`);
    await writeStatus(paths, status);
    if (ctx.hasUI) ctx.ui.notify(formatFailure(result), "error");
    return;
  }

  status.state = needsDifferentApproach ? "stuck" : "failed";
  await writeStatus(paths, status);

  const failed = result.failedCommand!;
  const directive = needsDifferentApproach
    ? "The same verifier failure has occurred again. Do not repeat the previous patch or retry the same idea. Re-read the affected code and assumptions, identify the root cause, and choose a materially different approach before editing."
    : "Verification failed. Diagnose the failure from the evidence below, fix the root cause, then finish the task. Do not claim completion until verification passes.";

  const message = [
    AUTO_PROMPT_PREFIX,
    directive,
    "",
    `Command: ${failed.command}`,
    `Exit code: ${failed.code}`,
    `Failure signature: ${result.signature ?? "unknown"}`,
    "",
    failed.output || "(no output)",
  ].join("\n");

  beforeAutoPrompt();
  try {
    pi.sendUserMessage(message);
  } catch (error) {
    status.state = "failed";
    pushNote(status, `Could not start auto-repair: ${error instanceof Error ? error.message : String(error)}`);
    await writeStatus(paths, status);
    if (ctx.hasUI) ctx.ui.notify(formatFailure(result), "error");
  }
}

function applyVerificationState(status: GvsStatus, result: VerificationSummary, config: GvsLiteConfig) {
  const now = new Date().toISOString();
  if (result.attempted === 0) {
    status.state = "unverified";
    status.verification.lastRunAt = now;
    status.verification.lastPassed = null;
    return;
  }

  status.verification.attempts += 1;
  status.verification.lastRunAt = now;
  status.verification.lastPassed = result.passed;
  status.verification.lastCommand = result.failedCommand?.command ?? result.commands.at(-1)?.command ?? null;

  if (result.passed) {
    status.state = "verified";
    status.verification.lastSignature = null;
    status.verification.consecutiveSameFailure = 0;
    return;
  }

  const signature = result.signature ?? null;
  if (signature && signature === status.verification.lastSignature) {
    status.verification.consecutiveSameFailure += 1;
  } else {
    status.verification.consecutiveSameFailure = 1;
  }
  status.verification.lastSignature = signature;
  status.state =
    status.verification.consecutiveSameFailure >= config.stuck.sameFailureThreshold ? "stuck" : "failed";
}

function shouldStartNewGoal(status: GvsStatus, ledger: Awaited<ReturnType<typeof readLedger>>): boolean {
  if (isPlaceholderGoal(ledger.goal)) return true;
  return status.state === "verified" || status.state === "stuck" || status.state === "unverified";
}

function isPlaceholderGoal(goal: string): boolean {
  return /goal not set yet/i.test(goal);
}

function renderLedgerInstructions(goal: string, plan: string, findings: string, status: GvsStatus): string {
  return `# gvs-lite execution contract\n\n` +
    `You have a compact persistent workspace ledger. Treat it as current task state, not as a chronological log.\n` +
    `- Keep ${CONFIG_DIR_NAME}/work/plan.md as the CURRENT plan only. Rewrite obsolete steps instead of appending history.\n` +
    `- Keep ${CONFIG_DIR_NAME}/work/findings.md curated: durable facts, constraints, decisions, root causes, and failed approaches worth avoiding. Delete stale material.\n` +
    `- Do not put command output, long diffs, or conversational narration in the ledger.\n` +
    `- Update plan/findings only when materially useful. gvs-lite enforces hard size limits.\n` +
    `- A verifier runs after workspace changes. A failed verifier result is authoritative. Never claim success while it is failing.\n` +
    `- If the same failure repeats, change strategy rather than making a cosmetic variation of the same patch.\n\n` +
    `<gvs-goal>\n${goal.trim()}\n</gvs-goal>\n\n` +
    `<gvs-plan>\n${plan.trim()}\n</gvs-plan>\n\n` +
    `<gvs-findings>\n${findings.trim()}\n</gvs-findings>\n\n` +
    `<gvs-status>\n${JSON.stringify({
      state: status.state,
      verification: status.verification,
      modifiedFiles: status.modifiedFiles,
    }, null, 2)}\n</gvs-status>`;
}

function getPathFromInput(input: any): string | null {
  const candidate = input?.path ?? input?.file_path;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function isLedgerPath(path: string, cwd: string): boolean {
  const absolute = resolve(cwd, path);
  const ledger = resolve(cwd, CONFIG_DIR_NAME, "work");
  return absolute === ledger || absolute.startsWith(`${ledger}/`);
}

function normalizeDisplayPath(path: string, cwd: string): string {
  const absolute = resolve(cwd, path);
  const rel = relative(cwd, absolute);
  return rel && !rel.startsWith("..") ? rel : absolute;
}

function looksMutating(command: string): boolean {
  return /(?:^|[;&|]\s*|\s)(?:sed\s+-i|perl\s+-pi|tee\b|touch\b|mkdir\b|rm\b|mv\b|cp\b|git\s+(?:apply|checkout|restore|reset|merge|rebase|cherry-pick)|npm\s+(?:install|i|uninstall)|pnpm\s+(?:add|remove|install)|yarn\s+(?:add|remove|install)|bun\s+(?:add|remove|install)|cargo\s+(?:add|update)|go\s+(?:get|mod\s+tidy)|uv\s+(?:add|remove|sync))\b|(?:^|[^<>])>{1,2}(?!=)/i.test(command);
}

async function safeFingerprint(pi: ExtensionAPI, cwd: string): Promise<string | null> {
  try {
    return await workspaceFingerprint(pi, cwd, CONFIG_DIR_NAME);
  } catch {
    return null;
  }
}

function formatFailure(result: VerificationSummary): string {
  const failed = result.failedCommand;
  if (!failed) return "Verification failed.";
  return `Verification failed: ${failed.command}\n${failed.output || `(exit ${failed.code}, no output)`}`;
}

function formatStatus(status: GvsStatus): string {
  const suffix = status.verification.lastPassed === true ? "OK" : status.verification.lastPassed === false ? "FAIL" : status.state;
  return `GVS: ${suffix}`;
}

function pushNote(status: GvsStatus, note: string) {
  status.notes = [...status.notes.filter((v) => v !== note), note].slice(-8);
}
