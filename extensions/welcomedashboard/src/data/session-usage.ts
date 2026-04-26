import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SESSION_USAGE_DB_PATH =
  process.env.PI_SESSION_USAGE_DB ??
  join(homedir(), ".pi", "agent", "session-usage.db");

export type UsageSummary = {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
};

export type ModelUsageRow = {
  scope: string;
  model: string;
  calls: number;
  percent: number;
};

export function getUsageSummary(
  whereClause?: string,
  param?: string,
): UsageSummary {
  if (!existsSync(SESSION_USAGE_DB_PATH)) {
    return {
      sessions: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCost: 0,
    };
  }

  const db = new DatabaseSync(SESSION_USAGE_DB_PATH, { readOnly: true });

  try {
    const query = `
      SELECT
        COUNT(*) AS sessions,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(total_cost), 0) AS total_cost
      FROM session_usage
      ${whereClause ?? ""}
    `;
    const statement = db.prepare(query);
    const row = (
      param === undefined ? statement.get() : statement.get(param)
    ) as {
      sessions: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      total_cost: number;
    };

    return {
      sessions: row.sessions,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      totalCost: row.total_cost,
    };
  } catch {
    return {
      sessions: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCost: 0,
    };
  } finally {
    db.close();
  }
}

export function getModelUsageRows(cwd: string): ModelUsageRow[] {
  if (!existsSync(SESSION_USAGE_DB_PATH)) {
    return [];
  }

  const db = new DatabaseSync(SESSION_USAGE_DB_PATH, { readOnly: true });

  try {
    const buildRows = (scope: string, whereClause?: string, param?: string) => {
      const query = `
        SELECT
          provider,
          model,
          SUM(call_count) AS calls,
          100.0 * SUM(call_count) / NULLIF(SUM(SUM(call_count)) OVER (), 0) AS pct
        FROM session_model_calls
        ${whereClause ?? ""}
        GROUP BY provider, model
        ORDER BY calls DESC, provider, model
        LIMIT 3
      `;
      const statement = db.prepare(query);
      const results = (
        param === undefined ? statement.all() : statement.all(param)
      ) as {
        provider: string;
        model: string;
        calls: number;
        pct: number | null;
      }[];

      return results.map((row) => ({
        scope,
        model: `${row.provider}/${row.model}`,
        calls: row.calls,
        percent: row.pct ?? 0,
      }));
    };

    return [...buildRows("All"), ...buildRows("Project", "WHERE cwd = ?", cwd)];
  } catch {
    return [];
  } finally {
    db.close();
  }
}
