#!/usr/bin/env tsx
/**
 * Run several runtime-usage aggregate collectors and post them through sync-runtime-usage.
 * The config deliberately uses argv arrays, not shell strings, to avoid command injection.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

type SourceConfig = {
  name: string;
  source: string;
  file?: string;
  url?: string;
  command?: string[];
  runtimeSurface?: string;
  sourceSystem?: string;
  targetRepo?: string;
  quotaBucket?: string;
  optional?: boolean;
};

type BatchConfig = {
  sources: SourceConfig[];
};

type Options = {
  config?: string;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg !== "--config") throw new Error(`Unknown argument: ${arg}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error("Missing value for --config");
    options.config = value;
    i += 1;
  }

  if (!options.config) {
    options.config = process.env.OPENSYNC_RUNTIME_USAGE_CONFIG;
  }
  if (!options.config) throw new Error("Pass --config <path> or set OPENSYNC_RUNTIME_USAGE_CONFIG");

  return options;
}

async function readConfig(configPath: string): Promise<BatchConfig> {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (!Array.isArray(config.sources)) throw new Error("Config must contain a sources array");
  return config;
}

async function sourceToFile(source: SourceConfig, tempDir: string) {
  if (source.file) return source.file;

  const outputPath = path.join(tempDir, `${source.name.replace(/[^a-z0-9_.-]/gi, "-")}.json`);
  if (source.url) {
    const response = await fetch(source.url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`${source.name} returned HTTP ${response.status}`);
    await fs.writeFile(outputPath, await response.text());
    return outputPath;
  }

  if (source.command) {
    if (!source.command.length) throw new Error(`${source.name} command cannot be empty`);
    const stdout = await runCommand(source.command);
    await fs.writeFile(outputPath, stdout);
    return outputPath;
  }

  throw new Error(`${source.name} must define file, url, or command`);
}

function runCommand(command: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command[0]} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

async function syncSource(source: SourceConfig, file: string, dryRun: boolean) {
  const args = ["tsx", "scripts/sync-runtime-usage.ts", "--source", source.source, "--file", file];
  if (source.runtimeSurface) args.push("--runtime-surface", source.runtimeSurface);
  if (source.sourceSystem) args.push("--source-system", source.sourceSystem);
  if (source.targetRepo) args.push("--target-repo", source.targetRepo);
  if (source.quotaBucket) args.push("--quota-bucket", source.quotaBucket);
  if (dryRun) args.push("--dry-run");

  await runInteractive("npx", args);
}

function runInteractive(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}`));
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await readConfig(options.config!);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensync-runtime-usage-"));
  let failures = 0;

  for (const source of config.sources) {
    try {
      console.error(`syncing ${source.name} (${source.source})`);
      const file = await sourceToFile(source, tempDir);
      await syncSource(source, file, options.dryRun);
    } catch (error) {
      failures += source.optional ? 0 : 1;
      console.error(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
