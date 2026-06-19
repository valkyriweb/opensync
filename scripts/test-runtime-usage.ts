#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

const tempDir = mkdtempSync(path.join(tmpdir(), "opensync-runtime-usage-test-"));

function fixture(name: string, value: unknown) {
  const file = path.join(tempDir, name);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

function runRuntimeUsage(args: string[]): RunResult {
  const result = spawnSync("npx", ["tsx", "scripts/sync-runtime-usage.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function dryRunRecords(result: RunResult) {
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.dryRun, true);
  return output.records as Array<Record<string, unknown>>;
}

function testProviderUsageQuotaBucket() {
  const file = fixture("provider-usage.json", {
    rows: [
      {
        observedAt: "2026-06-18T20:25:00Z",
        provider: "pi",
        model: "gpt-5.5",
        agentId: "agent-1",
        inputTokens: 12,
        cachedInputTokens: 34,
        outputTokens: 5,
      },
    ],
  });

  const rows = dryRunRecords(
    runRuntimeUsage([
      "--source",
      "provider-usage",
      "--source-system",
      "paperclip",
      "--runtime-surface",
      "paperclip-cost",
      "--file",
      file,
      "--dry-run",
    ]),
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceSystem, "paperclip");
  assert.equal(rows[0].runtimeSurface, "paperclip-cost");
  assert.equal(rows[0].providerReported, "pi");
  assert.equal(rows[0].modelReported, "gpt-5.5");
  assert.equal(rows[0].quotaBucket, "openai-codex");
  assert.equal(rows[0].inputTokens, 12);
  assert.equal(rows[0].cachedInputTokens, 34);
  assert.equal(rows[0].outputTokens, 5);
}

function testClawSweeperStatusIsCapacityOnly() {
  const file = fixture("clawsweeper-status.json", {
    generated_at: "2026-06-19T05:00:00Z",
    fleet: {
      active_workflow_runs: 52,
      queued_workflow_runs: 19,
      active_codex_jobs: 54,
      worker_budget: 128,
      budget_used_percent: 42,
    },
    diagnostics: { errors: [] },
  });

  const rows = dryRunRecords(
    runRuntimeUsage(["--source", "clawsweeper-status", "--file", file, "--dry-run"]),
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceSystem, "clawsweeper");
  assert.equal(rows[0].runtimeSurface, "clawsweeper-status");
  assert.equal(rows[0].providerReported, "github-actions");
  assert.equal(rows[0].modelReported, "workflow-capacity");
  assert.equal(rows[0].quotaBucket, "unknown");
  assert.equal(rows[0].inputTokens, 0);
  assert.equal(rows[0].outputTokens, 0);
  assert.match(String(rows[0].status), /activeWorkflowRuns=52/);
}

function testRecordsSourceRejectsSecretValueBeforeDryRunOutput() {
  const file = fixture("records-secret.json", {
    records: [
      {
        sourceKey: "secret-shape",
        observedAt: 1781820000000,
        sourceSystem: "pi",
        runtimeSurface: "secret-test",
        providerReported: "anthropic",
        modelReported: "claude-bridge",
        quotaBucket: "anthropic",
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        status: "api_key=REDACTED",
        sourceFreshness: "fresh",
      },
    ],
  });

  const result = runRuntimeUsage(["--source", "records", "--file", file, "--dry-run"]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes("api_key=REDACTED"), false);
  assert.equal(result.stderr.includes("api_key=REDACTED"), false);
  assert.match(result.stderr, /records\[0\]\.status looks like a secret/);
}

function testRecordsSourceRejectsSecretKeyBeforeDryRunOutput() {
  const file = fixture("records-secret-key.json", {
    records: [
      {
        sourceKey: "secret-key-shape",
        observedAt: 1781820000000,
        sourceSystem: "pi",
        runtimeSurface: "secret-test",
        providerReported: "anthropic",
        modelReported: "claude-bridge",
        quotaBucket: "anthropic",
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        "api_key=REDACTED": "x",
        sourceFreshness: "fresh",
      },
    ],
  });

  const result = runRuntimeUsage(["--source", "records", "--file", file, "--dry-run"]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes("api_key=REDACTED"), false);
  assert.equal(result.stderr.includes("api_key=REDACTED"), false);
  assert.match(result.stderr, /records\[0\] key looks like a secret/);
}

function testBridgeStatusDoesNotEchoAuth() {
  const file = fixture("bridge-status.json", {
    lastRequest: "2026-06-19T05:00:00Z",
    requests: 32,
    errors: 0,
    auth: "Bearer REDACTED",
  });

  const rows = dryRunRecords(
    runRuntimeUsage(["--source", "bridge-status", "--file", file, "--dry-run"]),
  );

  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes("Bearer"), false);
  assert.match(String(rows[0].status), /requests=32/);
}

testProviderUsageQuotaBucket();
testClawSweeperStatusIsCapacityOnly();
testRecordsSourceRejectsSecretValueBeforeDryRunOutput();
testRecordsSourceRejectsSecretKeyBeforeDryRunOutput();
testBridgeStatusDoesNotEchoAuth();

console.log("runtime usage tests passed");
