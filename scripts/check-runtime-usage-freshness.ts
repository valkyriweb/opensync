#!/usr/bin/env tsx
/**
 * Check OpenSync runtime usage freshness via the API-key endpoint.
 * Exits non-zero when an expected runtime surface is missing or stale.
 */

import process from "node:process";

type Options = {
  endpoint?: string;
  apiKey?: string;
  expectedSurfaces: string[];
  staleAfterMinutes: number;
};

type FreshnessRow = {
  runtimeSurface: string;
  latestObservedAt: number | null;
  ageMinutes: number | null;
  status: "fresh" | "stale" | "unknown" | "missing";
  statusText?: string;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    endpoint: process.env.OPENSYNC_URL,
    apiKey: process.env.OPENSYNC_API_KEY,
    expectedSurfaces: [],
    staleAfterMinutes: 360,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    i += 1;

    if (arg === "--endpoint") options.endpoint = value;
    else if (arg === "--api-key") options.apiKey = value;
    else if (arg === "--expected-surface") options.expectedSurfaces.push(value);
    else if (arg === "--stale-after-minutes") options.staleAfterMinutes = number(value, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.endpoint) throw new Error("Set OPENSYNC_URL or pass --endpoint");
  if (!options.apiKey) throw new Error("Set OPENSYNC_API_KEY or pass --api-key");
  if (!options.expectedSurfaces.length) throw new Error("Pass at least one --expected-surface");
  return options;
}

function number(value: string, field: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid ${field}: ${value}`);
  return parsed;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const url = new URL("/api/runtime-usage", options.endpoint!.replace(/\/$/, "/"));
  url.searchParams.set("freshness", "true");
  url.searchParams.set("staleAfterMinutes", String(options.staleAfterMinutes));
  for (const surface of options.expectedSurfaces) {
    url.searchParams.append("expectedSurface", surface);
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      Accept: "application/json",
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`OpenSync returned HTTP ${response.status}: ${body}`);

  const rows = JSON.parse(body).freshness as FreshnessRow[];
  const unhealthy = rows.filter((row) => row.status === "missing" || row.status === "stale");
  for (const row of rows) {
    console.log(
      `${row.runtimeSurface}: ${row.status}${row.ageMinutes === null ? "" : ` (${row.ageMinutes}m)`}${row.statusText ? ` ${row.statusText}` : ""}`,
    );
  }

  if (unhealthy.length > 0) {
    console.error(`Unhealthy runtime surfaces: ${unhealthy.map((row) => row.runtimeSurface).join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
