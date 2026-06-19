import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { cn } from "../lib/utils";
import { useTheme, getThemeClasses } from "../lib/theme";
import { BarChart, DonutChart, StatCard } from "../components/Charts";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Clock,
  Database,
  Layers3,
  PieChart,
  RefreshCw,
} from "lucide-react";

const EXPECTED_RUNTIME_SURFACES = [
  "codexbar-quota",
  "claude-bridge",
  "cluster-claude-bridge",
  "multica-runtime",
  "paperclip-cost",
  "clawsweeper-status",
];

const colors = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

type ChartRow = { label: string; value: number };
type FreshnessRow = {
  runtimeSurface: string;
  latestObservedAt: number | null;
  ageMinutes: number | null;
  status: "fresh" | "stale" | "unknown" | "missing";
  sourceFreshness: string;
  statusText?: string;
};
type RecentUsageRow = {
  _id: string;
  sourceSystem: string;
  runtimeSurface: string;
  agentName?: string;
  providerReported: string;
  modelReported: string;
  quotaBucket: string;
  observedAt: number;
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  status?: string;
};

export function RuntimeUsagePage() {
  const { theme, toggleTheme } = useTheme();
  const t = getThemeClasses(theme);
  const data = useQuery(api.runtimeUsage.dashboard, {
    days: 14,
    limit: 500,
    expectedSurfaces: EXPECTED_RUNTIME_SURFACES,
  });

  const quotaData = withColors(data?.byQuotaBucket ?? []);
  const sourceData = withColors(data?.bySourceSystem ?? []);
  const runtimeData = withColors(data?.byRuntimeSurface ?? []);
  const dailyData = data?.dailyTokens ?? [];
  const recentRows = (data?.recentRows ?? []) as RecentUsageRow[];
  const freshness = (data?.freshness ?? []) as FreshnessRow[];
  const staleCount = freshness.filter((row) => row.status === "stale" || row.status === "missing").length;

  const tokenTrend = useMemo(() => dailyData.map((row) => row.value), [dailyData]);

  return (
    <div className={cn("min-h-screen", t.bgPrimary, t.textPrimary)}>
      <header className={cn("border-b", t.border, t.bgPrimary)}>
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4">
          <div className="flex items-center gap-3">
            <Link
              to="/dashboard"
              className={cn("flex items-center gap-2 text-sm", t.textSubtle, t.interactiveHover)}
            >
              <ArrowLeft className="h-4 w-4" />
              Dashboard
            </Link>
            <div className={cn("h-5 w-px", theme === "dark" ? "bg-zinc-800" : "bg-[#e6e4e1]")} />
            <div>
              <h1 className="text-lg font-medium">Runtime usage</h1>
              <p className={cn("text-xs", t.textSubtle)}>
                Sanitized model-token rows plus zero-token status observations, quota buckets, and source freshness.
              </p>
            </div>
          </div>
          <button
            onClick={toggleTheme}
            className={cn("rounded-md border px-3 py-1.5 text-xs", t.border, t.bgHover, t.textSubtle)}
          >
            Toggle theme
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6">
        {data === undefined ? (
          <div className={cn("flex items-center gap-2 rounded-lg border p-4 text-sm", t.border, t.bgCard, t.textMuted)}>
            <RefreshCw className="h-4 w-4 animate-spin" />
            Loading runtime usage...
          </div>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <StatCard
                theme={theme}
                label="Total tokens"
                value={formatTokens(data.totalTokens)}
                subValue={`${data.aggregateRowCount} aggregate rows / ${data.aggregateRowLimit} max`}
                trend={tokenTrend}
                icon={<Activity className="h-4 w-4" />}
              />
              <StatCard
                theme={theme}
                label="Latest observation"
                value={formatTime(data.latestObservedAt)}
                subValue="Across all runtime surfaces"
                icon={<Clock className="h-4 w-4" />}
              />
              <StatCard
                theme={theme}
                label="Runtime surfaces"
                value={data.byRuntimeSurface.length}
                subValue={`${EXPECTED_RUNTIME_SURFACES.length} expected surfaces tracked`}
                icon={<Layers3 className="h-4 w-4" />}
              />
              <StatCard
                theme={theme}
                label="Freshness gaps"
                value={staleCount}
                subValue="Missing or stale surfaces"
                icon={<AlertTriangle className="h-4 w-4" />}
              />
            </div>

            {data.aggregateLimitHit && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-500">
                Aggregate row limit reached. Narrow the window before treating totals as complete.
              </div>
            )}

            <div className={cn("rounded-lg border p-3 text-sm", t.border, t.bgCard, t.textMuted)}>
              <strong className={t.textPrimary}>ClawSweeper:</strong> `clawsweeper-status` is live workflow-capacity telemetry from the deployed Worker. `github-actions-runner` snapshots are supported for runner inventories, but deployed runner listing and non-zero token attribution are still separate proofs.
            </div>

            <section className="grid gap-4 lg:grid-cols-3">
              <ChartCard title="Daily tokens" theme={theme} className="lg:col-span-2">
                <BarChart
                  data={dailyData.map((row) => ({
                    label: row.label.slice(5),
                    value: row.value,
                    color: "bg-blue-500",
                  }))}
                  height={180}
                  formatValue={formatTokens}
                />
              </ChartCard>
              <ChartCard title="Quota buckets" theme={theme}>
                <DonutChart data={quotaData} size={150} thickness={16} />
                <Legend rows={quotaData} />
              </ChartCard>
            </section>

            <section className="grid gap-4 lg:grid-cols-2">
              <ChartCard title="By source system" theme={theme}>
                <DonutChart data={sourceData} size={150} thickness={16} />
                <Legend rows={sourceData} />
              </ChartCard>
              <ChartCard title="By runtime surface" theme={theme}>
                <BarChart
                  data={runtimeData.map((row) => ({
                    label: row.label,
                    value: row.value,
                    color: "bg-emerald-500",
                  }))}
                  height={150}
                  formatValue={formatTokens}
                />
              </ChartCard>
            </section>

            <section className={cn("rounded-lg border", t.border, t.bgCard)}>
              <div className={cn("border-b px-4 py-3", t.border)}>
                <h2 className="text-sm font-medium">Freshness</h2>
                <p className={cn("text-xs", t.textSubtle)}>
                  A surface is stale after six hours without a new aggregate row or zero-token status observation.
                </p>
              </div>
              <div className="divide-y divide-zinc-800/20">
                {freshness.map((row) => (
                  <div key={row.runtimeSurface} className="grid gap-3 px-4 py-3 text-sm md:grid-cols-[1fr_auto_auto] md:items-center">
                    <div>
                      <p className="font-medium">{row.runtimeSurface}</p>
                      {row.statusText && <p className={cn("mt-1 text-xs", t.textSubtle)}>{row.statusText}</p>}
                    </div>
                    <span className={cn("rounded-full px-2 py-1 text-xs", freshnessClass(row.status))}>
                      {row.status}
                    </span>
                    <span className={cn("text-xs", t.textSubtle)}>
                      {row.latestObservedAt ? `${formatTime(row.latestObservedAt)} (${row.ageMinutes}m ago)` : "No data"}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className={cn("rounded-lg border", t.border, t.bgCard)}>
              <div className={cn("flex items-center gap-2 border-b px-4 py-3", t.border)}>
                <Database className={cn("h-4 w-4", t.iconSubtle)} />
                <h2 className="text-sm font-medium">Recent rows</h2>
                <span className={cn("text-xs", t.textSubtle)}>{data.rowCount} recent rows / {data.rowLimit} max</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className={cn("border-b text-xs", t.border, t.textSubtle)}>
                    <tr>
                      <th className="px-4 py-2 font-normal">Observed</th>
                      <th className="px-4 py-2 font-normal">Surface</th>
                      <th className="px-4 py-2 font-normal">Source</th>
                      <th className="px-4 py-2 font-normal">Model</th>
                      <th className="px-4 py-2 font-normal">Quota</th>
                      <th className="px-4 py-2 text-right font-normal">Tokens</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/20">
                    {recentRows.map((row) => (
                      <tr key={row._id} className={cn("hover:bg-black/5", theme === "dark" && "hover:bg-white/5")}>
                        <td className="px-4 py-2 whitespace-nowrap">{formatTime(row.observedAt)}</td>
                        <td className="px-4 py-2">{row.runtimeSurface}</td>
                        <td className="px-4 py-2">{row.sourceSystem}</td>
                        <td className="px-4 py-2">{row.providerReported}/{row.modelReported}</td>
                        <td className="px-4 py-2">{row.quotaBucket}</td>
                        <td className="px-4 py-2 text-right">{formatTokens(row.totalTokens)}</td>
                      </tr>
                    ))}
                    {recentRows.length === 0 && (
                      <tr>
                        <td className={cn("px-4 py-8 text-center text-sm", t.textSubtle)} colSpan={6}>
                          No runtime usage rows yet. Run `npm run sync:runtime-usage` to dry-run or post aggregate snapshots.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function ChartCard({
  title,
  theme,
  className,
  children,
}: {
  title: string;
  theme: "dark" | "tan";
  className?: string;
  children: ReactNode;
}) {
  const t = getThemeClasses(theme);
  return (
    <div className={cn("rounded-lg border p-4", t.border, t.bgCard, className)}>
      <div className="mb-4 flex items-center gap-2">
        <PieChart className={cn("h-4 w-4", t.iconSubtle)} />
        <h2 className="text-sm font-medium">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function Legend({ rows }: { rows: Array<ChartRow & { color: string }> }) {
  return (
    <div className="mt-4 space-y-2">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-3 text-xs">
          <span className="flex min-w-0 items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: row.color }} />
            <span className="truncate">{row.label}</span>
          </span>
          <span>{formatTokens(row.value)}</span>
        </div>
      ))}
    </div>
  );
}

function withColors(rows: ChartRow[]) {
  return rows.map((row, index) => ({ ...row, color: colors[index % colors.length] }));
}

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

function formatTime(value: number | null) {
  if (!value) return "No data";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function freshnessClass(status: FreshnessRow["status"]) {
  if (status === "fresh") return "bg-emerald-500/10 text-emerald-500";
  if (status === "stale") return "bg-amber-500/10 text-amber-500";
  if (status === "missing") return "bg-red-500/10 text-red-500";
  return "bg-zinc-500/10 text-zinc-500";
}
