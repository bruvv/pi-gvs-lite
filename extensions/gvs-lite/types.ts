export type LedgerState = "active" | "verifying" | "verified" | "failed" | "stuck" | "unverified";

export interface GvsLiteConfig {
  enabled: boolean;
  verify: {
    commands: string[] | null;
    timeoutMs: number;
    maxAutoRetries: number;
    outputMaxChars: number;
  };
  ledger: {
    goalMaxChars: number;
    planMaxChars: number;
    findingsMaxChars: number;
  };
  stuck: {
    sameFailureThreshold: number;
    hardStopThreshold: number;
  };
}

export interface VerificationCommandResult {
  command: string;
  code: number;
  stdout: string;
  stderr: string;
  output: string;
}

export interface VerificationSummary {
  attempted: number;
  passed: boolean;
  commands: VerificationCommandResult[];
  failedCommand?: VerificationCommandResult;
  signature?: string;
}

export interface GvsStatus {
  version: 1;
  state: LedgerState;
  createdAt: string;
  updatedAt: string;
  goalStartedAt: string;
  modifiedFiles: string[];
  verification: {
    attempts: number;
    consecutiveSameFailure: number;
    lastSignature: string | null;
    lastCommand: string | null;
    lastPassed: boolean | null;
    lastRunAt: string | null;
  };
  notes: string[];
}
