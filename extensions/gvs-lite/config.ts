import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GvsLiteConfig } from "./types.ts";

export const DEFAULT_CONFIG: GvsLiteConfig = {
  enabled: true,
  verify: {
    commands: null,
    timeoutMs: 120_000,
    maxAutoRetries: 3,
    outputMaxChars: 12_000,
  },
  ledger: {
    goalMaxChars: 6_000,
    planMaxChars: 4_000,
    findingsMaxChars: 8_000,
  },
  stuck: {
    sameFailureThreshold: 2,
    hardStopThreshold: 3,
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeConfig(raw: unknown): GvsLiteConfig {
  if (!isObject(raw)) return structuredClone(DEFAULT_CONFIG);

  const verify = isObject(raw.verify) ? raw.verify : {};
  const ledger = isObject(raw.ledger) ? raw.ledger : {};
  const stuck = isObject(raw.stuck) ? raw.stuck : {};

  const commands = Array.isArray(verify.commands)
    ? verify.commands.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : DEFAULT_CONFIG.verify.commands;

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    verify: {
      commands,
      timeoutMs: positiveInt(verify.timeoutMs, DEFAULT_CONFIG.verify.timeoutMs),
      maxAutoRetries: positiveInt(verify.maxAutoRetries, DEFAULT_CONFIG.verify.maxAutoRetries),
      outputMaxChars: positiveInt(verify.outputMaxChars, DEFAULT_CONFIG.verify.outputMaxChars),
    },
    ledger: {
      goalMaxChars: positiveInt(ledger.goalMaxChars, DEFAULT_CONFIG.ledger.goalMaxChars),
      planMaxChars: positiveInt(ledger.planMaxChars, DEFAULT_CONFIG.ledger.planMaxChars),
      findingsMaxChars: positiveInt(ledger.findingsMaxChars, DEFAULT_CONFIG.ledger.findingsMaxChars),
    },
    stuck: {
      sameFailureThreshold: positiveInt(
        stuck.sameFailureThreshold,
        DEFAULT_CONFIG.stuck.sameFailureThreshold,
      ),
      hardStopThreshold: positiveInt(stuck.hardStopThreshold, DEFAULT_CONFIG.stuck.hardStopThreshold),
    },
  };
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export async function loadConfig(cwd: string, configDirName: string): Promise<GvsLiteConfig> {
  const path = join(cwd, configDirName, "gvs-lite.json");
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return mergeConfig(raw);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}
