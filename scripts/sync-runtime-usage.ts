#!/usr/bin/env tsx
/**
 * Sync sanitized runtime usage snapshots into OpenSync.
 *
 * Examples:
 *   npm run sync:runtime-usage -- --source multica-runtime-usage --file /tmp/multica.json --dry-run
 *   OPENSYNC_URL=https://opensync.example.com OPENSYNC_API_KEY=osk_... npm run sync:runtime-usage -- --source codexbar --file /tmp/codexbar.json
 */

import fs from "node:fs/promises";
import process from "node:process";

const sourceTypes = new Set([
  "records",
  "multica-runtime-usage",
  "provider-usage",
  "codexbar",
  "bridge-status",
  "clawsweeper-status",
  "clawsweeper-runners",
]);

const quotaBuckets = new Set(["openai-codex", "anthropic", "google", "unknown"]);
const secretLikePattern =
  /(Bearer\s+\S+|BEGIN [A-Z ]*PRIVATE KEY|\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\b\s*[:=]|:\/\/[^/\s:@]+:[^/\s@]+@)/i;

type SourceSystem =
  | "pi"
  | "paperclip"
  | "multica"
  | "openclaw"
  | "claude-code"
  | "codex"
  | "clawsweeper"
  | "unknown";

type QuotaBucket = "openai-codex" | "anthropic" | "google" | "unknown";

type RuntimeUsageRecord = {
  sourceKey: string;
  observedAt: number;
  sourceSystem: SourceSystem;
  runtimeSurface: string;
  runtimeId?: string;
  runtimeName?: string;
  companyId?: string;
  workspaceId?: string;
  projectId?: string;
  agentId?: string;
  agentName?: string;
  issueId?: string;
  issueKey?: string;
  taskKey?: string;
  runId?: string;
  sessionId?: string;
  cwd?: string;
  workflowName?: string;
  targetRepo?: string;
  runnerName?: string;
  providerReported: string;
  modelReported: string;
  quotaBucket: QuotaBucket;
  billingType?: string;
  biller?: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costCents?: number;
  status?: string;
  sourceFreshness: "fresh" | "stale" | "unknown";
};

type Options = {
  source?: string;
  file?: string;
  endpoint?: string;
  apiKey?: string;
  dryRun: boolean;
  runtimeSurface?: string;
  sourceSystem?: SourceSystem;
  targetRepo?: string;
  quotaBucket?: QuotaBucket;
};

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);

    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    i += 1;

    if (key === "source") options.source = value;
    else if (key === "file") options.file = value;
    else if (key === "endpoint") options.endpoint = value;
    else if (key === "api-key") options.apiKey = value;
    else if (key === "runtime-surface") options.runtimeSurface = value;
    else if (key === "source-system") options.sourceSystem = parseSourceSystem(value);
    else if (key === "target-repo") options.targetRepo = value;
    else if (key === "quota-bucket") options.quotaBucket = quotaBucket(value);
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!options.source || !sourceTypes.has(options.source)) {
    throw new Error(`--source must be one of: ${Array.from(sourceTypes).join(", ")}`);
  }

  return options;
}

async function readJson(file?: string) {
  if (!file && process.stdin.isTTY) {
    throw new Error("Pass --file <path> or pipe JSON on stdin");
  }
  const text = file && file !== "-" ? await fs.readFile(file, "utf8") : await stdin();
  return JSON.parse(text);
}

function stdin() {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(data));
  });
}

function string(value: unknown, field = "string", maxLength = 512) {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (text.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  if (secretLikePattern.test(text)) throw new Error(`${field} looks like a secret`);
  return text;
}

function assertNoSecretLikeStrings(value: unknown, path = "record") {
  if (typeof value === "string") {
    if (secretLikePattern.test(value)) throw new Error(`${path} looks like a secret`);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretLikeStrings(item, `${path}[${index}]`));
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, nestedValue] of Object.entries(value)) {
      if (secretLikePattern.test(key)) throw new Error(`${path} key looks like a secret`);
      assertNoSecretLikeStrings(nestedValue, `${path}.${key}`);
    }
  }
}

function number(value: unknown) {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid number: ${value}`);
  return parsed;
}

function observedAt(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function parseSourceSystem(value: unknown): SourceSystem {
  const text = string(value) ?? "unknown";
  const sourceSystems = new Set([
    "pi",
    "paperclip",
    "multica",
    "openclaw",
    "claude-code",
    "codex",
    "clawsweeper",
    "unknown",
  ]);
  if (!sourceSystems.has(text)) throw new Error(`Invalid source system: ${text}`);
  return text as SourceSystem;
}

function quotaBucket(value: unknown): QuotaBucket {
  const text = string(value) ?? "unknown";
  if (!quotaBuckets.has(text)) throw new Error(`Invalid quota bucket: ${text}`);
  return text as QuotaBucket;
}

function inferredQuotaBucket(provider: unknown, model: unknown, fallback?: QuotaBucket): QuotaBucket {
  if (fallback) return fallback;
  const text = `${string(provider) ?? ""} ${string(model) ?? ""}`.toLowerCase();
  if (text.includes("claude") || text.includes("anthropic")) return "anthropic";
  if (text.includes("codex") || text.includes("chatgpt") || text.includes("gpt")) {
    return "openai-codex";
  }
  return "unknown";
}

function sourceKey(parts: Array<unknown>) {
  return parts
    .map((part) => string(part))
    .filter(Boolean)
    .join("|")
    .slice(0, 512);
}

function compactStatus(entries: Record<string, unknown>) {
  return Object.entries(entries)
    .map(([key, value]) => {
      const safeValue = string(value, key, 80);
      return safeValue ? `${key}=${safeValue}` : undefined;
    })
    .filter(Boolean)
    .join("; ")
    .slice(0, 512);
}

function recordsFromInput(source: string, input: any, options: Options): RuntimeUsageRecord[] {
  if (source === "records") return normalizedRecords(input);
  if (source === "multica-runtime-usage") return multicaRuntimeUsage(input, options);
  if (source === "provider-usage") return providerUsage(input, options);
  if (source === "codexbar") return codexbarUsage(input);
  if (source === "bridge-status") return bridgeStatus(input, options);
  if (source === "clawsweeper-status") return clawsweeperStatus(input, options);
  if (source === "clawsweeper-runners") return clawsweeperRunners(input, options);
  throw new Error(`Unsupported source: ${source}`);
}

function normalizedRecords(input: any): RuntimeUsageRecord[] {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.records)) return input.records;
  if (input.record) return [input.record];
  throw new Error("records source expects an array, {records}, or {record}");
}

function multicaRuntimeUsage(input: any, options: Options): RuntimeUsageRecord[] {
  const rows = Array.isArray(input) ? input : input.usage;
  if (!Array.isArray(rows)) throw new Error("multica-runtime-usage expects an array or {usage}");

  return rows.map((row: any) => {
    const provider = string(row.provider) ?? "unknown";
    const model = string(row.model) ?? "unknown";
    const runtimeId = string(row.runtime_id ?? row.runtimeId);
    const timestamp = observedAt(row.observedAt ?? row.observed_at ?? row.date);

    return {
      sourceKey: sourceKey(["multica", runtimeId, row.date, provider, model]),
      observedAt: timestamp,
      sourceSystem: "multica",
      runtimeSurface: options.runtimeSurface ?? "multica-runtime",
      runtimeId,
      providerReported: provider,
      modelReported: model,
      quotaBucket: inferredQuotaBucket(provider, model, options.quotaBucket),
      inputTokens: number(row.input_tokens ?? row.inputTokens),
      cachedInputTokens: number(row.cache_read_tokens ?? row.cached_input_tokens ?? row.cachedInputTokens),
      cacheWriteTokens: number(row.cache_write_tokens ?? row.cacheWriteTokens),
      outputTokens: number(row.output_tokens ?? row.outputTokens),
      sourceFreshness: "fresh",
    };
  });
}

function providerUsage(input: any, options: Options): RuntimeUsageRecord[] {
  const rows = Array.isArray(input) ? input : input.rows ?? input.usage ?? input.data;
  if (!Array.isArray(rows)) throw new Error("provider-usage expects an array, {rows}, {usage}, or {data}");
  const system = options.sourceSystem ?? "unknown";
  const surface = options.runtimeSurface ?? `${system}-usage`;

  return rows.map((row: any) => {
    const provider = string(row.providerReported ?? row.provider_reported ?? row.provider) ?? "unknown";
    const model = string(row.modelReported ?? row.model_reported ?? row.model) ?? "unknown";
    const timestamp = observedAt(row.observedAt ?? row.observed_at ?? row.updatedAt ?? row.date);
    const runtimeId = string(row.runtimeId ?? row.runtime_id);
    const agentId = string(row.agentId ?? row.agent_id);
    const issueId = string(row.issueId ?? row.issue_id);

    return {
      sourceKey: sourceKey([system, surface, runtimeId, agentId, issueId, provider, model, timestamp]),
      observedAt: timestamp,
      sourceSystem: system,
      runtimeSurface: surface,
      runtimeId,
      agentId,
      agentName: string(row.agentName ?? row.agent_name),
      issueId,
      issueKey: string(row.issueKey ?? row.issue_key),
      runId: string(row.runId ?? row.run_id),
      sessionId: string(row.sessionId ?? row.session_id),
      providerReported: provider,
      modelReported: model,
      quotaBucket: inferredQuotaBucket(provider, model, options.quotaBucket),
      inputTokens: number(row.inputTokens ?? row.input_tokens ?? row.input),
      cachedInputTokens: number(
        row.cachedInputTokens ?? row.cacheReadTokens ?? row.cached_input_tokens ?? row.cache_read_tokens,
      ),
      cacheWriteTokens: number(row.cacheWriteTokens ?? row.cache_write_tokens),
      outputTokens: number(row.outputTokens ?? row.output_tokens ?? row.output),
      costCents:
        row.costCents !== undefined || row.cost_cents !== undefined
          ? number(row.costCents ?? row.cost_cents)
          : undefined,
      sourceFreshness: "fresh",
    };
  });
}

function codexbarUsage(input: any): RuntimeUsageRecord[] {
  const rows = Array.isArray(input) ? input : [input];

  return rows.map((row: any) => {
    const provider = string(row.provider ?? row.usage?.identity?.providerID) ?? "unknown";
    const usage = row.usage ?? row.openaiDashboard ?? row;
    const updatedAt = observedAt(usage.updatedAt ?? row.openaiDashboard?.updatedAt ?? row.updatedAt);
    const quota = provider === "claude" ? "anthropic" : provider === "codex" ? "openai-codex" : "unknown";
    const sourceSystem: SourceSystem = provider === "claude" ? "claude-code" : "codex";

    return {
      sourceKey: sourceKey(["codexbar", provider, updatedAt]),
      observedAt: updatedAt,
      sourceSystem,
      runtimeSurface: "codexbar-quota",
      providerReported: provider,
      modelReported: "quota-window",
      quotaBucket: quota,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      status: compactStatus({
        loginMethod: usage.loginMethod,
        primaryUsedPercent: usage.primary?.usedPercent,
        primaryResetsAt: usage.primary?.resetsAt,
        secondaryUsedPercent: usage.secondary?.usedPercent,
        secondaryResetsAt: usage.secondary?.resetsAt,
        tertiaryUsedPercent: usage.tertiary?.usedPercent,
        tertiaryResetsAt: usage.tertiary?.resetsAt,
      }),
      sourceFreshness: "fresh",
    };
  });
}

function bridgeStatus(input: any, options: Options): RuntimeUsageRecord[] {
  const timestamp = observedAt(input.lastRequest ?? input.updatedAt ?? input.startedAt);
  const surface = options.runtimeSurface ?? "claude-bridge";

  return [
    {
      sourceKey: sourceKey([surface, timestamp]),
      observedAt: timestamp,
      sourceSystem: "pi",
      runtimeSurface: surface,
      providerReported: "anthropic",
      modelReported: "claude-bridge",
      quotaBucket: options.quotaBucket ?? "anthropic",
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      status: compactStatus({
        requests: input.requests,
        errors: input.errors,
        cacheBreaks: input.cacheBreaks,
        uptime: input.uptime,
      }),
      sourceFreshness: input.lastRequest ? "fresh" : "unknown",
    },
  ];
}

function clawsweeperStatus(input: any, options: Options): RuntimeUsageRecord[] {
  const timestamp = observedAt(input.generated_at ?? input.generatedAt ?? input.updatedAt);
  const fleet = input.fleet ?? {};
  const diagnostics = input.diagnostics ?? {};

  return [
    {
      sourceKey: sourceKey(["clawsweeper-status", timestamp]),
      observedAt: timestamp,
      sourceSystem: "clawsweeper",
      runtimeSurface: options.runtimeSurface ?? "clawsweeper-status",
      providerReported: "github-actions",
      modelReported: "workflow-capacity",
      quotaBucket: "unknown",
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      status: compactStatus({
        activeWorkflowRuns: fleet.active_workflow_runs,
        queuedWorkflowRuns: fleet.queued_workflow_runs,
        activeCodexJobs: fleet.active_codex_jobs,
        workerBudget: fleet.worker_budget,
        budgetUsedPercent: fleet.budget_used_percent,
        diagnosticsErrors: Array.isArray(diagnostics.errors) ? diagnostics.errors.length : undefined,
      }),
      sourceFreshness: "fresh",
    },
  ];
}

function clawsweeperRunners(input: any, options: Options): RuntimeUsageRecord[] {
  const runners = Array.isArray(input) ? input : input.runners;
  if (!Array.isArray(runners)) throw new Error("clawsweeper-runners expects an array or {runners}");
  const timestamp = Date.now();
  const targetRepo = options.targetRepo ?? "valkyriweb/clawsweeper";

  return runners.map((runner: any) => {
    const runnerName = string(runner.name) ?? string(runner.id) ?? "unknown-runner";
    return {
      sourceKey: sourceKey(["clawsweeper", targetRepo, runnerName, timestamp]),
      observedAt: timestamp,
      sourceSystem: "clawsweeper",
      runtimeSurface: options.runtimeSurface ?? "github-actions-runner",
      targetRepo,
      runnerName,
      providerReported: "github-actions",
      modelReported: "runner-status",
      quotaBucket: "unknown",
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      status: compactStatus({ status: runner.status, busy: runner.busy, os: runner.os }),
      sourceFreshness: "fresh",
    };
  });
}

async function postRecords(records: RuntimeUsageRecord[], options: Options) {
  const endpoint = (options.endpoint ?? process.env.OPENSYNC_URL ?? "").replace(/\/$/, "");
  const apiKey = options.apiKey ?? process.env.OPENSYNC_API_KEY;
  const dryRun = options.dryRun || !endpoint || !apiKey;

  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, records }, null, 2));
    if (!endpoint || !apiKey) {
      console.error("Dry run only: set OPENSYNC_URL and OPENSYNC_API_KEY to post records.");
    }
    return;
  }

  const response = await fetch(`${endpoint}/sync/runtime-usage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ records }),
  });

  const body = await response.text();
  if (!response.ok) throw new Error(`OpenSync returned ${response.status}: ${body}`);
  console.log(body);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const input = await readJson(options.file);
  const records = recordsFromInput(options.source!, input, options);
  assertNoSecretLikeStrings(records, "records");
  await postRecords(records, options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
