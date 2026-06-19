import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

const http = httpRouter();

// ============================================================================
// AUTHENTICATION HELPERS
// ============================================================================

// Validate JWT token from WorkOS
async function validateJWT(ctx: any, request: Request) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: "Missing Authorization header", status: 401 };
  }

  try {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { error: "Invalid or expired token", status: 401 };
    }

    const user = await ctx.runMutation(internal.users.getByWorkosId, {
      workosId: identity.subject,
    });

    return { user, identity };
  } catch (e) {
    return { error: `Auth failed: ${e}`, status: 401 };
  }
}

// Validate API key
async function validateApiKey(ctx: any, request: Request) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer osk_")) {
    return { error: "Invalid API key format", status: 401 };
  }

  const apiKey = authHeader.slice(7);

  try {
    const user = await ctx.runMutation(internal.users.getByApiKey, { apiKey });
    if (!user) {
      return { error: "Invalid API key", status: 401 };
    }
    return { user };
  } catch (e) {
    return { error: `API key validation failed: ${e}`, status: 401 };
  }
}

// Authenticate via JWT or API key
async function authenticate(ctx: any, request: Request) {
  const authHeader = request.headers.get("Authorization");
  
  if (authHeader?.startsWith("Bearer osk_")) {
    return validateApiKey(ctx, request);
  }
  
  return validateJWT(ctx, request);
}

// JSON response helper
function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    },
  });
}

const runtimeUsageBatchLimit = 500;
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
const quotaBuckets = new Set(["openai-codex", "anthropic", "google", "unknown"]);
const freshnessStates = new Set(["fresh", "stale", "unknown"]);

const secretLikePattern =
  /(Bearer\s+\S+|BEGIN [A-Z ]*PRIVATE KEY|\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\b\s*[:=]|:\/\/[^/\s:@]+:[^/\s@]+@)/i;

function optionalString(value: unknown, field = "string", maxLength = 512) {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (text.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  if (secretLikePattern.test(text)) throw new Error(`${field} looks like a secret`);
  return text;
}

function requiredString(value: unknown, field: string) {
  const text = optionalString(value, field);
  if (!text) throw new Error(`Missing ${field}`);
  return text;
}

function allowedValue(value: unknown, allowed: Set<string>, fallback = "unknown") {
  const text = optionalString(value) ?? fallback;
  return allowed.has(text) ? text : fallback;
}

function tokenCount(value: unknown) {
  if (value === undefined || value === null || value === "") return 0;
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) throw new Error(`Invalid token count: ${value}`);
  return count;
}

function optionalNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid number: ${value}`);
  return number;
}

function observedAtMs(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`Invalid observedAt: ${value}`);
}

function runtimeUsageRecords(body: any) {
  const records = Array.isArray(body) ? body : Array.isArray(body?.records) ? body.records : [body?.record ?? body];
  if (records.length === 0) throw new Error("No runtime usage records supplied");
  if (records.length > runtimeUsageBatchLimit) {
    throw new Error(`Runtime usage batch exceeds ${runtimeUsageBatchLimit} records`);
  }

  return records.map((record: any) => {
    const observedAt = observedAtMs(record.observedAt ?? record.observed_at ?? record.timestamp ?? record.ts);
    const sourceSystem = allowedValue(record.sourceSystem ?? record.source_system, sourceSystems);
    const runtimeSurface = requiredString(record.runtimeSurface ?? record.runtime_surface, "runtimeSurface");
    const providerReported = requiredString(
      record.providerReported ?? record.provider_reported ?? record.provider,
      "providerReported",
    );
    const modelReported = requiredString(
      record.modelReported ?? record.model_reported ?? record.model,
      "modelReported",
    );
    const quotaBucket = allowedValue(record.quotaBucket ?? record.quota_bucket, quotaBuckets);
    const sourceFreshness = allowedValue(
      record.sourceFreshness ?? record.source_freshness,
      freshnessStates,
    );
    const sourceKey =
      optionalString(record.sourceKey ?? record.source_key) ??
      [
        sourceSystem,
        runtimeSurface,
        optionalString(record.runtimeId ?? record.runtime_id),
        optionalString(record.runId ?? record.run_id),
        optionalString(record.sessionId ?? record.session_id),
        optionalString(record.agentId ?? record.agent_id),
        optionalString(record.agentName ?? record.agent_name),
        optionalString(record.issueId ?? record.issue_id),
        optionalString(record.issueKey ?? record.issue_key),
        optionalString(record.targetRepo ?? record.target_repo),
        optionalString(record.runnerName ?? record.runner_name),
        modelReported,
        quotaBucket,
        observedAt,
      ]
        .filter(Boolean)
        .join("|");

    return {
      sourceKey,
      observedAt,
      sourceSystem,
      runtimeSurface,
      runtimeId: optionalString(record.runtimeId ?? record.runtime_id),
      runtimeName: optionalString(record.runtimeName ?? record.runtime_name),
      companyId: optionalString(record.companyId ?? record.company_id),
      workspaceId: optionalString(record.workspaceId ?? record.workspace_id),
      projectId: optionalString(record.projectId ?? record.project_id),
      agentId: optionalString(record.agentId ?? record.agent_id),
      agentName: optionalString(record.agentName ?? record.agent_name),
      issueId: optionalString(record.issueId ?? record.issue_id),
      issueKey: optionalString(record.issueKey ?? record.issue_key),
      taskKey: optionalString(record.taskKey ?? record.task_key),
      runId: optionalString(record.runId ?? record.run_id),
      sessionId: optionalString(record.sessionId ?? record.session_id),
      cwd: optionalString(record.cwd),
      workflowName: optionalString(record.workflowName ?? record.workflow_name),
      targetRepo: optionalString(record.targetRepo ?? record.target_repo),
      runnerName: optionalString(record.runnerName ?? record.runner_name),
      providerReported,
      modelReported,
      quotaBucket,
      billingType: optionalString(record.billingType ?? record.billing_type),
      biller: optionalString(record.biller),
      inputTokens: tokenCount(record.inputTokens ?? record.input_tokens ?? record.input),
      cachedInputTokens: tokenCount(
        record.cachedInputTokens ??
          record.cacheReadTokens ??
          record.cached_input_tokens ??
          record.cache_read_tokens ??
          record.cacheRead,
      ),
      cacheWriteTokens: tokenCount(
        record.cacheWriteTokens ?? record.cache_write_tokens ?? record.cacheWrite,
      ),
      outputTokens: tokenCount(record.outputTokens ?? record.output_tokens ?? record.output),
      costCents: optionalNumber(record.costCents ?? record.cost_cents),
      status: optionalString(record.status),
      sourceFreshness,
    };
  });
}

function parseSince(value: string | null) {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function queryEnum(value: string | null, allowed: Set<string>, field: string) {
  const text = optionalString(value, field);
  if (!text) return undefined;
  if (!allowed.has(text)) throw new Error(`Invalid ${field}: ${text}`);
  return text;
}

// CORS preflight
http.route({
  path: "/*",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }),
});

// ============================================================================
// SYNC ENDPOINTS (for plugin)
// ============================================================================

// Sync session
http.route({
  path: "/sync/session",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await authenticate(ctx, request);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const body = await request.json();

      // Accept both externalId (opencode-sync) and sessionId (claude-code-sync)
      const externalId = body.externalId || body.sessionId;
      if (!externalId) {
        return json({ error: "Missing externalId or sessionId" }, 400);
      }

      const sessionId = await ctx.runMutation(internal.sessions.upsert, {
        userId: auth.user._id,
        externalId,
        title: body.title,
        projectPath: body.projectPath,
        projectName: body.projectName,
        model: body.model,
        provider: body.provider,
        source: body.source, // "opencode" or "claude-code"
        promptTokens: body.promptTokens,
        completionTokens: body.completionTokens,
        cost: body.cost,
        durationMs: body.durationMs,
        createdAt: body.createdAt, // Original timestamp from source
      });

      // Schedule embedding generation
      await ctx.scheduler.runAfter(0, internal.embeddings.generateForSession, {
        sessionId,
      });

      return json({ ok: true, sessionId });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }),
});

// Sync message
http.route({
  path: "/sync/message",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await authenticate(ctx, request);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const body = await request.json();

      const messageId = await ctx.runMutation(internal.messages.upsert, {
        userId: auth.user._id,
        sessionExternalId: body.sessionExternalId,
        externalId: body.externalId,
        role: body.role,
        textContent: body.textContent,
        model: body.model,
        promptTokens: body.promptTokens,
        completionTokens: body.completionTokens,
        durationMs: body.durationMs,
        source: body.source, // Pass source for auto-created sessions ("opencode" or "claude-code")
        parts: body.parts,
        createdAt: body.createdAt, // Original timestamp from source
      });

      return json({ ok: true, messageId });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }),
});

// Batch sync - uses batch mutations for fewer write conflicts
http.route({
  path: "/sync/batch",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await authenticate(ctx, request);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const body = await request.json();
      const errors: Array<string> = [];
      let sessionCount = 0;
      let messageCount = 0;

      // Batch upsert sessions in a single mutation
      if (body.sessions && body.sessions.length > 0) {
        try {
          const result = await ctx.runMutation(internal.sessions.batchUpsert, {
            userId: auth.user._id,
            sessions: body.sessions,
          });
          sessionCount = result.inserted + result.updated;
        } catch (e) {
          errors.push(`Sessions batch error: ${e}`);
        }
      }

      // Batch upsert messages in a single mutation
      if (body.messages && body.messages.length > 0) {
        try {
          const result = await ctx.runMutation(internal.messages.batchUpsert, {
            userId: auth.user._id,
            messages: body.messages,
          });
          messageCount = result.inserted + result.updated;
          errors.push(...result.errors);
        } catch (e) {
          errors.push(`Messages batch error: ${e}`);
        }
      }

      return json({
        ok: true,
        sessions: sessionCount,
        messages: messageCount,
        errors,
      });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }),
});

// List all session external IDs for the authenticated user
http.route({
  path: "/sync/sessions/list",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const auth = await validateApiKey(ctx, request);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const sessionIds = await ctx.runQuery(internal.sessions.listExternalIds, {
        userId: auth.user._id,
      });

      return json({ sessionIds });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }),
});

// Sync normalized runtime token usage
http.route({
  path: "/sync/runtime-usage",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await authenticate(ctx, request);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const body = await request.json();
      const records = runtimeUsageRecords(body);
      const result = await ctx.runMutation(internal.runtimeUsage.ingestBatch, {
        userId: auth.user._id,
        records,
      });

      return json({ ok: true, ...result });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }),
});

// ============================================================================
// SECURE API ENDPOINTS (for external apps)
// ============================================================================

// GET /api/runtime-usage - List or summarize normalized runtime token usage
http.route({
  path: "/api/runtime-usage",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const start = Date.now();
    const auth = await authenticate(ctx, request);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const url = new URL(request.url);
      const since = parseSince(url.searchParams.get("since"));
      const summary = url.searchParams.get("summary") === "true";
      const freshness = url.searchParams.get("freshness") === "true";
      const limit = parseInt(url.searchParams.get("limit") || (summary ? "5000" : "100"));
      const staleAfterMinutes = parseInt(url.searchParams.get("staleAfterMinutes") || "360");
      if (!Number.isFinite(limit)) throw new Error("Invalid limit");
      if (!Number.isFinite(staleAfterMinutes)) throw new Error("Invalid staleAfterMinutes");

      const result = freshness
        ? await ctx.runQuery(internal.runtimeUsage.freshnessForUser, {
            userId: auth.user._id,
            expectedSurfaces: url.searchParams
              .getAll("expectedSurface")
              .map((surface) => optionalString(surface, "expectedSurface"))
              .filter(Boolean) as string[],
            staleAfterMinutes,
          })
        : summary
          ? await ctx.runQuery(internal.runtimeUsage.summarizeForUser, {
              userId: auth.user._id,
              since,
              limit,
            })
          : await ctx.runQuery(internal.runtimeUsage.listForUser, {
              userId: auth.user._id,
              since,
              limit,
              sourceSystem: queryEnum(
                url.searchParams.get("sourceSystem"),
                sourceSystems,
                "sourceSystem",
              ) as any,
              quotaBucket: queryEnum(
                url.searchParams.get("quotaBucket"),
                quotaBuckets,
                "quotaBucket",
              ) as any,
              runtimeSurface: optionalString(url.searchParams.get("runtimeSurface"), "runtimeSurface"),
            });

      await ctx.runMutation(internal.api.logAccess, {
        userId: auth.user._id,
        endpoint: "/api/runtime-usage",
        method: "GET",
        statusCode: 200,
        responseTimeMs: Date.now() - start,
      });

      return json(result);
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }),
});

// GET /api/sessions - List sessions
http.route({
  path: "/api/sessions",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const start = Date.now();
    const auth = await authenticate(ctx, request);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const url = new URL(request.url);
      const limit = parseInt(url.searchParams.get("limit") || "50");

      const sessions = await ctx.runQuery(internal.api.listSessions, {
        userId: auth.user._id,
        limit,
      });

      // Log API access
      await ctx.runMutation(internal.api.logAccess, {
        userId: auth.user._id,
        endpoint: "/api/sessions",
        method: "GET",
        statusCode: 200,
        responseTimeMs: Date.now() - start,
      });

      return json({ sessions });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }),
});

// GET /api/sessions/:id - Get session with messages
http.route({
  path: "/api/sessions/get",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const start = Date.now();
    const auth = await authenticate(ctx, request);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const url = new URL(request.url);
      const sessionId = url.searchParams.get("id");

      if (!sessionId) {
        return json({ error: "Missing session ID" }, 400);
      }

      const result = await ctx.runQuery(internal.api.getSession, {
        userId: auth.user._id,
        sessionId: sessionId as any,
      });

      if (!result) {
        return json({ error: "Session not found" }, 404);
      }

      await ctx.runMutation(internal.api.logAccess, {
        userId: auth.user._id,
        endpoint: "/api/sessions/get",
        method: "GET",
        statusCode: 200,
        responseTimeMs: Date.now() - start,
      });

      return json(result);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }),
});

// GET /api/search - Search sessions
http.route({
  path: "/api/search",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const start = Date.now();
    const auth = await authenticate(ctx, request);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const url = new URL(request.url);
      const query = url.searchParams.get("q");
      const limit = parseInt(url.searchParams.get("limit") || "20");
      const type = url.searchParams.get("type") || "fulltext";

      if (!query) {
        return json({ error: "Missing query parameter 'q'" }, 400);
      }

      let results;
      if (type === "semantic") {
        results = await ctx.runAction(internal.api.semanticSearch, {
          userId: auth.user._id,
          query,
          limit,
        });
      } else if (type === "hybrid") {
        results = await ctx.runAction(internal.api.hybridSearch, {
          userId: auth.user._id,
          query,
          limit,
        });
      } else {
        results = await ctx.runQuery(internal.api.fullTextSearch, {
          userId: auth.user._id,
          query,
          limit,
        });
      }

      await ctx.runMutation(internal.api.logAccess, {
        userId: auth.user._id,
        endpoint: "/api/search",
        method: "GET",
        statusCode: 200,
        responseTimeMs: Date.now() - start,
      });

      return json({ results });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }),
});

// GET /api/context - Get relevant sessions for context engineering
http.route({
  path: "/api/context",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const start = Date.now();
    const auth = await authenticate(ctx, request);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const url = new URL(request.url);
      const query = url.searchParams.get("q");
      const limit = parseInt(url.searchParams.get("limit") || "5");
      const format = url.searchParams.get("format") || "text";

      if (!query) {
        return json({ error: "Missing query parameter 'q'" }, 400);
      }

      const context = await ctx.runAction(internal.api.getContext, {
        userId: auth.user._id,
        query,
        limit,
        format,
      });

      await ctx.runMutation(internal.api.logAccess, {
        userId: auth.user._id,
        endpoint: "/api/context",
        method: "GET",
        statusCode: 200,
        responseTimeMs: Date.now() - start,
      });

      return json(context);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }),
});

// GET /api/export - Export sessions in various formats
http.route({
  path: "/api/export",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const start = Date.now();
    const auth = await authenticate(ctx, request);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const url = new URL(request.url);
      const sessionId = url.searchParams.get("id");
      const format = url.searchParams.get("format") || "json";

      if (!sessionId) {
        return json({ error: "Missing session ID" }, 400);
      }

      const result = await ctx.runQuery(internal.api.exportSession, {
        userId: auth.user._id,
        sessionId: sessionId as any,
        format,
      });

      if (!result) {
        return json({ error: "Session not found" }, 404);
      }

      await ctx.runMutation(internal.api.logAccess, {
        userId: auth.user._id,
        endpoint: "/api/export",
        method: "GET",
        statusCode: 200,
        responseTimeMs: Date.now() - start,
      });

      if (format === "markdown") {
        return new Response(result.content, {
          headers: {
            "Content-Type": "text/markdown",
            "Content-Disposition": `attachment; filename="${result.filename}"`,
          },
        });
      }

      return json(result);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }),
});

// GET /api/stats - Get user stats
http.route({
  path: "/api/stats",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const start = Date.now();
    const auth = await authenticate(ctx, request);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const stats = await ctx.runQuery(internal.api.getStats, {
        userId: auth.user._id,
      });

      await ctx.runMutation(internal.api.logAccess, {
        userId: auth.user._id,
        endpoint: "/api/stats",
        method: "GET",
        statusCode: 200,
        responseTimeMs: Date.now() - start,
      });

      return json(stats);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }),
});

// GET /api/export/evals - Export eval sessions in various formats
http.route({
  path: "/api/export/evals",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const start = Date.now();
    const auth = await authenticate(ctx, request);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const url = new URL(request.url);
      
      // Parse format (deepeval, openai, promptfoo, filesystem)
      const format = url.searchParams.get("format") || "deepeval";
      if (!["deepeval", "openai", "promptfoo", "filesystem"].includes(format)) {
        return json({ error: "Invalid format. Use: deepeval, openai, promptfoo, filesystem" }, 400);
      }
      
      // Parse optional filters
      const tool = url.searchParams.get("tool") || undefined;
      const model = url.searchParams.get("model") || undefined;
      const dateFrom = url.searchParams.get("date_from");
      const dateTo = url.searchParams.get("date_to");
      const tags = url.searchParams.get("tags")?.split(",").filter(Boolean) || undefined;
      const minTokens = url.searchParams.get("min_tokens") ? parseInt(url.searchParams.get("min_tokens")!) : undefined;
      const evalStatus = url.searchParams.get("status") || undefined;
      
      // Parse options
      const includeMetadata = url.searchParams.get("include_metadata") !== "false";
      const anonymizePaths = url.searchParams.get("anonymize") !== "false";
      const turnMode = url.searchParams.get("turn_mode") || "per_turn";
      
      // First get the list of eval sessions with filters
      const sessionsResult = await ctx.runQuery(api.evals.getExportData, {
        sessionIds: "all",
        workosId: auth.user.workosId,
      });
      
      if (!sessionsResult || sessionsResult.sessions.length === 0) {
        return json({ error: "No eval-ready sessions found" }, 404);
      }

      // Apply additional filters in memory (source, model, date, tokens, status)
      let filteredSessions = sessionsResult.sessions;
      
      if (tool) {
        filteredSessions = filteredSessions.filter((s: any) => s.source === tool);
      }
      if (model) {
        filteredSessions = filteredSessions.filter((s: any) => s.model === model);
      }
      if (dateFrom) {
        const fromTs = new Date(dateFrom).getTime();
        filteredSessions = filteredSessions.filter((s: any) => s.createdAt >= fromTs);
      }
      if (dateTo) {
        const toTs = new Date(dateTo + "T23:59:59").getTime();
        filteredSessions = filteredSessions.filter((s: any) => s.createdAt <= toTs);
      }
      if (minTokens) {
        filteredSessions = filteredSessions.filter((s: any) => s.totalTokens >= minTokens);
      }
      if (evalStatus) {
        filteredSessions = filteredSessions.filter((s: any) => s.evalStatus === evalStatus);
      }
      if (tags && tags.length > 0) {
        filteredSessions = filteredSessions.filter((s: any) => 
          s.evalTags && tags.some((tag: string) => s.evalTags.includes(tag))
        );
      }
      
      if (filteredSessions.length === 0) {
        return json({ error: "No sessions match the specified filters" }, 404);
      }

      // Generate export using the action
      const result = await ctx.runAction(api.evals.generateEvalExport, {
        sessionIds: filteredSessions.map((s: any) => s._id),
        format: format as "deepeval" | "openai" | "promptfoo" | "filesystem",
        options: {
          includeSystemPrompts: false,
          includeToolCalls: includeMetadata,
          anonymizePaths,
          turnMode: turnMode as "full" | "per_turn" | "final_only",
        },
      });

      // Log API access
      await ctx.runMutation(internal.api.logAccess, {
        userId: auth.user._id,
        endpoint: "/api/export/evals",
        method: "GET",
        statusCode: 200,
        responseTimeMs: Date.now() - start,
      });

      // Return as downloadable file
      const contentType = format === "openai" || format === "promptfoo" 
        ? "application/x-ndjson" 
        : "application/json";
      
      return new Response(result.data, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${result.filename}"`,
          "Access-Control-Allow-Origin": "*",
          "X-Export-Sessions": result.stats.sessions.toString(),
          "X-Export-TestCases": result.stats.testCases.toString(),
        },
      });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }),
});

// Health check
http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => {
    return json({ status: "ok", timestamp: Date.now() });
  }),
});

export default http;
