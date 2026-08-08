import type { PluginContext, UsageLimit, UsageLimitsResult } from "@pragma/plugin/catalog";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const GO_LIMITS = {
  rolling: 12,
  weekly: 30,
  monthly: 60,
} as const;

const USAGE_QUERY = `
WITH bounds AS (
  SELECT
    CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS observed_at,
    CAST(strftime('%s', datetime('now', 'start of day', printf('-%d days', (CAST(strftime('%w', 'now') AS INTEGER) + 6) % 7))) AS INTEGER) * 1000 AS week_start,
    CAST(strftime('%s', 'now', 'start of month') AS INTEGER) * 1000 AS month_start,
    CAST(strftime('%s', 'now', 'start of month', '+1 month') AS INTEGER) * 1000 AS month_end
), usage AS (
  SELECT
    bounds.*,
    COALESCE(SUM(CASE WHEN time_created >= observed_at - ${FIVE_HOURS_MS} THEN CAST(json_extract(data, '$.cost') AS REAL) ELSE 0 END), 0) AS rolling_used,
    MIN(CASE WHEN time_created >= observed_at - ${FIVE_HOURS_MS} THEN time_created END) AS rolling_start,
    COALESCE(SUM(CASE WHEN time_created >= week_start THEN CAST(json_extract(data, '$.cost') AS REAL) ELSE 0 END), 0) AS weekly_used,
    COALESCE(SUM(CASE WHEN time_created >= month_start THEN CAST(json_extract(data, '$.cost') AS REAL) ELSE 0 END), 0) AS monthly_used,
    COUNT(message.id) AS message_count
  FROM bounds
  LEFT JOIN message ON json_extract(data, '$.role') = 'assistant'
    AND json_extract(data, '$.providerID') = 'opencode-go'
)
SELECT
  observed_at AS observedAt,
  rolling_used AS rollingUsed,
  CASE WHEN rolling_start IS NULL THEN NULL ELSE rolling_start + ${FIVE_HOURS_MS} END AS rollingResetsAt,
  weekly_used AS weeklyUsed,
  week_start + ${7 * 24 * 60 * 60 * 1000} AS weeklyResetsAt,
  monthly_used AS monthlyUsed,
  month_end AS monthlyResetsAt,
  message_count AS messageCount
FROM usage
`.trim();

const USAGE_COMMAND =
  "command -v opencode >/dev/null 2>&1 || exit 20; " +
  `opencode db ${shellQuote(USAGE_QUERY)} --format json`;

/** Loads device-local OpenCode Go usage from OpenCode's supported database command. */
export async function loadOpenCodeGoUsageLimits(ctx: PluginContext): Promise<UsageLimitsResult> {
  const [result] = await ctx.sdk.exec.run({
    cwd: ctx.project?.path ?? "/tmp",
    commands: [USAGE_COMMAND],
  });
  if (result?.status === 20) {
    return {
      status: "unavailable",
      reason: "not-configured",
      message: "Install OpenCode to load OpenCode Go usage limits.",
    };
  }
  if (!result || result.status !== 0) {
    throw new Error(result?.stderr.trim() || "OpenCode Go usage query failed");
  }
  return parseOpenCodeGoUsage(result.stdout);
}

/** Normalizes one aggregate row returned by `opencode db --format json`. */
export function parseOpenCodeGoUsage(stdout: string): UsageLimitsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("OpenCode Go usage query returned invalid JSON");
  }
  const row = Array.isArray(parsed) ? parsed[0] : null;
  if (!isRecord(row)) {
    throw new Error("OpenCode Go usage query returned no aggregate row");
  }
  const messageCount = finiteNumber(row.messageCount);
  if (messageCount === null) {
    throw new Error("OpenCode Go usage query returned a malformed message count");
  }
  if (messageCount === 0) {
    return {
      status: "unavailable",
      reason: "unsupported",
      message: "No device-local OpenCode Go usage was found.",
    };
  }

  const observedAt = requiredNumber(row.observedAt, "observation time");
  const limits: UsageLimit[] = [
    usageLimit(
      "rolling",
      "5-hour limit",
      row.rollingUsed,
      GO_LIMITS.rolling,
      row.rollingResetsAt,
      observedAt,
    ),
    usageLimit(
      "weekly",
      "Weekly limit",
      row.weeklyUsed,
      GO_LIMITS.weekly,
      row.weeklyResetsAt,
      observedAt,
    ),
    usageLimit(
      "monthly",
      "Monthly limit",
      row.monthlyUsed,
      GO_LIMITS.monthly,
      row.monthlyResetsAt,
      observedAt,
    ),
  ];
  return { status: "ready", observedAt, limits };
}

function usageLimit(
  id: string,
  title: string,
  usedValue: unknown,
  limit: number,
  resetsAtValue: unknown,
  observedAt: number,
): UsageLimit {
  const used = requiredNumber(usedValue, `${title} usage`);
  const resetsAt = finiteNumber(resetsAtValue);
  return {
    id,
    title,
    used: Math.max(0, used),
    limit,
    ...(resetsAt === null ? {} : { resetsInMs: Math.max(0, resetsAt - observedAt) }),
  };
}

function requiredNumber(value: unknown, field: string): number {
  const number = finiteNumber(value);
  if (number === null) {
    throw new Error(`OpenCode Go usage query returned malformed ${field}`);
  }
  return number;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
