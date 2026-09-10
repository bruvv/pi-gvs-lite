import assert from "node:assert/strict";
import { test } from "node:test";
import { compactText, newStatus } from "../extensions/gvs-lite/ledger.ts";

test("compactText keeps text under the configured cap", () => {
  const input = "A".repeat(6000) + "B".repeat(6000);
  const output = compactText(input, 4000);
  assert.ok(output.length <= 4000);
  assert.match(output, /pruned by gvs-lite/);
  assert.ok(output.startsWith("A"));
  assert.ok(output.endsWith("B"));
});

test("newStatus starts a fresh verification state", () => {
  const status = newStatus(new Date("2026-09-10T12:00:00.000Z"));
  assert.equal(status.state, "active");
  assert.equal(status.verification.attempts, 0);
  assert.equal(status.verification.consecutiveSameFailure, 0);
});
