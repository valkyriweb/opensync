import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";

const sourceSystem = v.union(
  v.literal("pi"),
  v.literal("paperclip"),
  v.literal("multica"),
  v.literal("openclaw"),
  v.literal("claude-code"),
  v.literal("codex"),
  v.literal("clawsweeper"),
  v.literal("unknown"),
);

const quotaBucket = v.union(
  v.literal("openai-codex"),
  v.literal("anthropic"),
  v.literal("google"),
  v.literal("unknown"),
);

const sourceFreshness = v.union(
  v.literal("fresh"),
  v.literal("stale"),
  v.literal("unknown"),
);

const runtimeUsageRecord = v.object({
  sourceKey: v.string(),
  observedAt: v.number(),
  sourceSystem,
  runtimeSurface: v.string(),
  runtimeId: v.optional(v.string()),
  runtimeName: v.optional(v.string()),
  companyId: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
  projectId: v.optional(v.string()),
  agentId: v.optional(v.string()),
  agentName: v.optional(v.string()),
  issueId: v.optional(v.string()),
  issueKey: v.optional(v.string()),
  taskKey: v.optional(v.string()),
  runId: v.optional(v.string()),
  sessionId: v.optional(v.string()),
  cwd: v.optional(v.string()),
  workflowName: v.optional(v.string()),
  targetRepo: v.optional(v.string()),
  runnerName: v.optional(v.string()),
  providerReported: v.string(),
  modelReported: v.string(),
  quotaBucket,
  billingType: v.optional(v.string()),
  biller: v.optional(v.string()),
  inputTokens: v.number(),
  cachedInputTokens: v.number(),
  cacheWriteTokens: v.number(),
  outputTokens: v.number(),
  costCents: v.optional(v.number()),
  status: v.optional(v.string()),
  sourceFreshness,
});

function bounded(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function totalTokens(row: {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}) {
  return row.inputTokens + row.cachedInputTokens + row.cacheWriteTokens + row.outputTokens;
}

function emptyDashboard(expectedSurfaces: string[] = []) {
  return {
    rowCount: 0,
    rowLimit: 0,
    aggregateRowCount: 0,
    aggregateRowLimit: 0,
    aggregateLimitHit: false,
    totalTokens: 0,
    latestObservedAt: null,
    byQuotaBucket: [],
    bySourceSystem: [],
    byRuntimeSurface: [],
    dailyTokens: [],
    freshness: expectedSurfaces.map((runtimeSurface) => ({
      runtimeSurface,
      latestObservedAt: null,
      ageMinutes: null,
      status: "missing" as const,
      sourceFreshness: "unknown",
      statusText: undefined,
    })),
    recentRows: [],
  };
}

function mapToSortedRows(values: Record<string, number>) {
  return Object.entries(values)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

function dayFor(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function aggregateKey(row: any) {
  return [dayFor(row.observedAt), row.sourceSystem, row.runtimeSurface, row.quotaBucket].join("|");
}

async function applyDailyAggregateDelta(ctx: any, userId: any, row: any, multiplier: 1 | -1, updatedAt: number) {
  const key = aggregateKey(row);
  const existing = await ctx.db
    .query("runtimeUsageDaily")
    .withIndex("by_user_key", (q: any) => q.eq("userId", userId).eq("aggregateKey", key))
    .first();

  const next = {
    inputTokens: (existing?.inputTokens ?? 0) + row.inputTokens * multiplier,
    cachedInputTokens: (existing?.cachedInputTokens ?? 0) + row.cachedInputTokens * multiplier,
    cacheWriteTokens: (existing?.cacheWriteTokens ?? 0) + row.cacheWriteTokens * multiplier,
    outputTokens: (existing?.outputTokens ?? 0) + row.outputTokens * multiplier,
  };
  const nextTotal = totalTokens(next);

  if (existing) {
    if (nextTotal <= 0) {
      await ctx.db.delete(existing._id);
      return;
    }

    await ctx.db.patch(existing._id, {
      ...next,
      totalTokens: nextTotal,
      updatedAt,
    });
    return;
  }

  if (multiplier < 0 || nextTotal <= 0) return;

  await ctx.db.insert("runtimeUsageDaily", {
    userId,
    aggregateKey: key,
    date: dayFor(row.observedAt),
    sourceSystem: row.sourceSystem,
    runtimeSurface: row.runtimeSurface,
    quotaBucket: row.quotaBucket,
    ...next,
    totalTokens: nextTotal,
    updatedAt,
  });
}

export const dashboard = query({
  args: {
    days: v.optional(v.number()),
    limit: v.optional(v.number()),
    expectedSurfaces: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { days = 14, limit = 500, expectedSurfaces = [] }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return emptyDashboard(expectedSurfaces);

    const user = await ctx.db
      .query("users")
      .withIndex("by_workos_id", (q) => q.eq("workosId", identity.subject))
      .first();

    if (!user) return emptyDashboard(expectedSurfaces);

    const boundedDays = bounded(days, 1, 90);
    const boundedLimit = bounded(limit, 1, 500);
    const aggregateLimit = 5_000;
    const now = Date.now();
    const since = now - boundedDays * 24 * 60 * 60 * 1000;
    const startDate = dayFor(since);
    const staleAfterMs = 6 * 60 * 60 * 1000;

    const aggregateRows = await ctx.db
      .query("runtimeUsageDaily")
      .withIndex("by_user_date", (q) => q.eq("userId", user._id).gte("date", startDate))
      .order("desc")
      .take(aggregateLimit);

    const rows = await ctx.db
      .query("runtimeUsage")
      .withIndex("by_user_observed", (q) =>
        q.eq("userId", user._id).gte("observedAt", since),
      )
      .order("desc")
      .take(boundedLimit);

    const byQuotaBucket: Record<string, number> = {};
    const bySourceSystem: Record<string, number> = {};
    const byRuntimeSurface: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    let total = 0;

    for (const row of aggregateRows) {
      total += row.totalTokens;
      byQuotaBucket[row.quotaBucket] = (byQuotaBucket[row.quotaBucket] ?? 0) + row.totalTokens;
      bySourceSystem[row.sourceSystem] = (bySourceSystem[row.sourceSystem] ?? 0) + row.totalTokens;
      byRuntimeSurface[row.runtimeSurface] =
        (byRuntimeSurface[row.runtimeSurface] ?? 0) + row.totalTokens;
      byDay[row.date] = (byDay[row.date] ?? 0) + row.totalTokens;
    }

    const latestBySurface: Record<string, (typeof rows)[number]> = {};
    let latestObservedAt = 0;

    for (const row of rows) {
      latestObservedAt = Math.max(latestObservedAt, row.observedAt);
      const currentLatest = latestBySurface[row.runtimeSurface];
      if (!currentLatest || row.observedAt > currentLatest.observedAt) {
        latestBySurface[row.runtimeSurface] = row;
      }
    }

    const surfaces = Array.from(
      new Set([...expectedSurfaces, ...Object.keys(latestBySurface)]),
    ).sort();

    return {
      rowCount: rows.length,
      rowLimit: boundedLimit,
      aggregateRowCount: aggregateRows.length,
      aggregateRowLimit: aggregateLimit,
      aggregateLimitHit: aggregateRows.length === aggregateLimit,
      totalTokens: total,
      latestObservedAt: latestObservedAt || null,
      byQuotaBucket: mapToSortedRows(byQuotaBucket),
      bySourceSystem: mapToSortedRows(bySourceSystem),
      byRuntimeSurface: mapToSortedRows(byRuntimeSurface),
      dailyTokens: Object.entries(byDay)
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      freshness: surfaces.map((runtimeSurface) => {
        const row = latestBySurface[runtimeSurface];
        if (!row) {
          return {
            runtimeSurface,
            latestObservedAt: null,
            ageMinutes: null,
            status: "missing" as const,
            sourceFreshness: "unknown",
            statusText: undefined,
          };
        }

        const ageMinutes = Math.floor((now - row.observedAt) / 60000);
        const isStale = row.sourceFreshness === "stale" || now - row.observedAt > staleAfterMs;
        const status = isStale ? "stale" : row.sourceFreshness === "unknown" ? "unknown" : "fresh";

        return {
          runtimeSurface,
          latestObservedAt: row.observedAt,
          ageMinutes,
          status,
          sourceFreshness: row.sourceFreshness,
          statusText: row.status,
        };
      }),
      recentRows: rows.slice(0, 25).map((row) => ({
        _id: row._id,
        sourceSystem: row.sourceSystem,
        runtimeSurface: row.runtimeSurface,
        runtimeName: row.runtimeName,
        agentName: row.agentName,
        providerReported: row.providerReported,
        modelReported: row.modelReported,
        quotaBucket: row.quotaBucket,
        observedAt: row.observedAt,
        sourceFreshness: row.sourceFreshness,
        totalTokens: totalTokens(row),
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        outputTokens: row.outputTokens,
        status: row.status,
      })),
    };
  },
});

export const ingestBatch = internalMutation({
  args: {
    userId: v.id("users"),
    records: v.array(runtimeUsageRecord),
  },
  handler: async (ctx, { userId, records }) => {
    const ingestedAt = Date.now();
    let inserted = 0;
    let updated = 0;

    for (const record of records) {
      const existing = await ctx.db
        .query("runtimeUsage")
        .withIndex("by_user_source_key", (q) =>
          q.eq("userId", userId).eq("sourceKey", record.sourceKey),
        )
        .first();

      const doc = { ...record, userId, ingestedAt };
      if (existing) {
        await applyDailyAggregateDelta(ctx, userId, existing, -1, ingestedAt);
        await ctx.db.patch(existing._id, doc);
        await applyDailyAggregateDelta(ctx, userId, record, 1, ingestedAt);
        updated += 1;
      } else {
        await ctx.db.insert("runtimeUsage", doc);
        await applyDailyAggregateDelta(ctx, userId, record, 1, ingestedAt);
        inserted += 1;
      }
    }

    return { inserted, updated };
  },
});

export const freshnessForUser = internalQuery({
  args: {
    userId: v.id("users"),
    expectedSurfaces: v.optional(v.array(v.string())),
    staleAfterMinutes: v.optional(v.number()),
  },
  handler: async (ctx, { userId, expectedSurfaces = [], staleAfterMinutes = 360 }) => {
    const now = Date.now();
    const staleAfterMs = bounded(staleAfterMinutes, 1, 24 * 60) * 60 * 1000;
    const surfaces = [...new Set(expectedSurfaces)].slice(0, 50).sort();

    const freshness = [];
    for (const runtimeSurface of surfaces) {
      const row = await ctx.db
        .query("runtimeUsage")
        .withIndex("by_user_surface_observed", (q) =>
          q.eq("userId", userId).eq("runtimeSurface", runtimeSurface),
        )
        .order("desc")
        .first();

      if (!row) {
        freshness.push({
          runtimeSurface,
          latestObservedAt: null,
          ageMinutes: null,
          status: "missing" as const,
          sourceFreshness: "unknown",
          statusText: undefined,
        });
        continue;
      }

      const ageMinutes = Math.floor((now - row.observedAt) / 60000);
      const isStale = row.sourceFreshness === "stale" || now - row.observedAt > staleAfterMs;
      freshness.push({
        runtimeSurface,
        latestObservedAt: row.observedAt,
        ageMinutes,
        status: isStale ? "stale" : row.sourceFreshness === "unknown" ? "unknown" : "fresh",
        sourceFreshness: row.sourceFreshness,
        statusText: row.status,
      });
    }

    return { freshness };
  },
});

export const listForUser = internalQuery({
  args: {
    userId: v.id("users"),
    since: v.optional(v.number()),
    limit: v.optional(v.number()),
    sourceSystem: v.optional(sourceSystem),
    quotaBucket: v.optional(quotaBucket),
    runtimeSurface: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { userId, since = 0, limit = 100, sourceSystem, quotaBucket, runtimeSurface },
  ) => {
    const boundedLimit = bounded(limit, 1, 500);
    let rows;

    if (quotaBucket) {
      rows = await ctx.db
        .query("runtimeUsage")
        .withIndex("by_user_quota_observed", (q) =>
          q.eq("userId", userId).eq("quotaBucket", quotaBucket).gte("observedAt", since),
        )
        .order("desc")
        .take(boundedLimit);
    } else if (sourceSystem) {
      rows = await ctx.db
        .query("runtimeUsage")
        .withIndex("by_user_source_observed", (q) =>
          q.eq("userId", userId).eq("sourceSystem", sourceSystem).gte("observedAt", since),
        )
        .order("desc")
        .take(boundedLimit);
    } else if (runtimeSurface) {
      rows = await ctx.db
        .query("runtimeUsage")
        .withIndex("by_user_surface_observed", (q) =>
          q.eq("userId", userId).eq("runtimeSurface", runtimeSurface).gte("observedAt", since),
        )
        .order("desc")
        .take(boundedLimit);
    } else {
      rows = await ctx.db
        .query("runtimeUsage")
        .withIndex("by_user_observed", (q) =>
          q.eq("userId", userId).gte("observedAt", since),
        )
        .order("desc")
        .take(boundedLimit);
    }

    return { rows };
  },
});

export const summarizeForUser = internalQuery({
  args: {
    userId: v.id("users"),
    since: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { userId, since = 0, limit = 5_000 }) => {
    const boundedLimit = bounded(limit, 1, 5_000);
    const startDate = dayFor(since);
    const rows = await ctx.db
      .query("runtimeUsageDaily")
      .withIndex("by_user_date", (q) => q.eq("userId", userId).gte("date", startDate))
      .order("desc")
      .take(boundedLimit);

    const latest = await ctx.db
      .query("runtimeUsage")
      .withIndex("by_user_observed", (q) => q.eq("userId", userId).gte("observedAt", since))
      .order("desc")
      .take(1);

    const byQuotaBucket: Record<string, number> = {};
    const byRuntimeSurface: Record<string, number> = {};
    const bySourceSystem: Record<string, number> = {};
    let total = 0;

    for (const row of rows) {
      total += row.totalTokens;
      byQuotaBucket[row.quotaBucket] = (byQuotaBucket[row.quotaBucket] ?? 0) + row.totalTokens;
      byRuntimeSurface[row.runtimeSurface] =
        (byRuntimeSurface[row.runtimeSurface] ?? 0) + row.totalTokens;
      bySourceSystem[row.sourceSystem] = (bySourceSystem[row.sourceSystem] ?? 0) + row.totalTokens;
    }

    return {
      rows: rows.length,
      rowLimit: boundedLimit,
      aggregateLimitHit: rows.length === boundedLimit,
      totalTokens: total,
      latestObservedAt: latest[0]?.observedAt ?? null,
      byQuotaBucket,
      byRuntimeSurface,
      bySourceSystem,
    };
  },
});
