import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCost: number;
  toolCalls: number;
  edits: number;
};

type ToolCallArgs = {
  type?: string;
  id?: string;
  arguments?: Record<string, unknown>;
};

type ModelCallRow = {
  provider: string;
  model: string;
  callCount: number;
};

const DB_PATH =
  process.env.PI_SESSION_USAGE_DB ??
  join(homedir(), ".pi", "agent", "session-usage.db");
const EXTENSION_ID = "session-usage-sqlite";

function ensureDatabase(): DatabaseSync {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
		CREATE TABLE IF NOT EXISTS session_usage (
			session_id TEXT PRIMARY KEY,
			session_file TEXT NOT NULL UNIQUE,
			session_name TEXT,
			cwd TEXT NOT NULL,
			started_at TEXT NOT NULL,
			ended_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			duration_ms INTEGER NOT NULL,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			cache_read_tokens INTEGER NOT NULL,
			cache_write_tokens INTEGER NOT NULL,
			total_tokens INTEGER NOT NULL,
			total_cost REAL NOT NULL,
			tool_calls INTEGER NOT NULL,
			edits INTEGER NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_session_usage_updated_at ON session_usage(updated_at);
		CREATE INDEX IF NOT EXISTS idx_session_usage_cwd ON session_usage(cwd);

		CREATE TABLE IF NOT EXISTS session_model_calls (
			session_id TEXT NOT NULL,
			cwd TEXT NOT NULL,
			provider TEXT NOT NULL,
			model TEXT NOT NULL,
			call_count INTEGER NOT NULL,
			PRIMARY KEY (session_id, provider, model),
			FOREIGN KEY (session_id) REFERENCES session_usage(session_id) ON DELETE CASCADE
		);

		CREATE INDEX IF NOT EXISTS idx_session_model_calls_cwd ON session_model_calls(cwd);
		CREATE INDEX IF NOT EXISTS idx_session_model_calls_provider_model ON session_model_calls(provider, model);
	`);
  return db;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function countEditsFromArgs(args: Record<string, unknown> | undefined): number {
  if (!args) return 1;
  const edits = args.edits;
  if (Array.isArray(edits)) return edits.length;
  return 1;
}

function normalizeModelPart(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function collectTotals(ctx: ExtensionContext): UsageTotals {
  const totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    toolCalls: 0,
    edits: 0,
  };

  const toolCallArgsById = new Map<string, Record<string, unknown>>();

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message") continue;
    const message = entry.message;

    if (message.role === "assistant") {
      totals.inputTokens += asNumber(message.usage?.input);
      totals.outputTokens += asNumber(message.usage?.output);
      totals.cacheReadTokens += asNumber(message.usage?.cacheRead);
      totals.cacheWriteTokens += asNumber(message.usage?.cacheWrite);
      totals.totalTokens += asNumber(message.usage?.totalTokens);
      totals.totalCost += asNumber(message.usage?.cost?.total);

      for (const block of message.content) {
        const toolCall = block as ToolCallArgs;
        if (toolCall?.type !== "toolCall" || typeof toolCall.id !== "string")
          continue;
        toolCallArgsById.set(toolCall.id, toolCall.arguments ?? {});
      }
      continue;
    }

    if (message.role !== "toolResult") continue;

    totals.toolCalls += 1;

    if (message.isError) continue;
    if (message.toolName === "edit") {
      totals.edits += countEditsFromArgs(
        toolCallArgsById.get(message.toolCallId),
      );
    } else if (message.toolName === "write") {
      totals.edits += 1;
    }
  }

  return totals;
}

function collectModelCalls(ctx: ExtensionContext): ModelCallRow[] {
  const counts = new Map<string, ModelCallRow>();

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "assistant") continue;

    const provider = normalizeModelPart(message.provider, "unknown-provider");
    const model = normalizeModelPart(message.model, "unknown-model");
    const key = `${provider}\u0000${model}`;
    const existing = counts.get(key);
    if (existing) {
      existing.callCount += 1;
    } else {
      counts.set(key, { provider, model, callCount: 1 });
    }
  }

  return [...counts.values()].sort((a, b) => {
    if (b.callCount !== a.callCount) return b.callCount - a.callCount;
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.model.localeCompare(b.model);
  });
}

function formatMoney(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

export default function sessionUsageSqliteExtension(pi: ExtensionAPI) {
  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;

    const header = ctx.sessionManager.getHeader();
    const startedAt = header.timestamp;
    const endedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
    const totals = collectTotals(ctx);
    const modelCalls = collectModelCalls(ctx);

    try {
      const db = ensureDatabase();
      const upsertSessionUsage = db.prepare(`
				INSERT INTO session_usage (
					session_id,
					session_file,
					session_name,
					cwd,
					started_at,
					ended_at,
					updated_at,
					duration_ms,
					input_tokens,
					output_tokens,
					cache_read_tokens,
					cache_write_tokens,
					total_tokens,
					total_cost,
					tool_calls,
					edits
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(session_id) DO UPDATE SET
					session_file = excluded.session_file,
					session_name = excluded.session_name,
					cwd = excluded.cwd,
					started_at = excluded.started_at,
					ended_at = excluded.ended_at,
					updated_at = excluded.updated_at,
					duration_ms = excluded.duration_ms,
					input_tokens = excluded.input_tokens,
					output_tokens = excluded.output_tokens,
					cache_read_tokens = excluded.cache_read_tokens,
					cache_write_tokens = excluded.cache_write_tokens,
					total_tokens = excluded.total_tokens,
					total_cost = excluded.total_cost,
					tool_calls = excluded.tool_calls,
					edits = excluded.edits
			`);
      const deleteModelCalls = db.prepare(`
				DELETE FROM session_model_calls
				WHERE session_id = ?
			`);
      const insertModelCall = db.prepare(`
				INSERT INTO session_model_calls (
					session_id,
					cwd,
					provider,
					model,
					call_count
				) VALUES (?, ?, ?, ?, ?)
			`);

      db.exec("BEGIN");
      try {
        upsertSessionUsage.run(
          header.id,
          sessionFile,
          pi.getSessionName() ?? null,
          header.cwd,
          startedAt,
          endedAt,
          endedAt,
          durationMs,
          totals.inputTokens,
          totals.outputTokens,
          totals.cacheReadTokens,
          totals.cacheWriteTokens,
          totals.totalTokens,
          totals.totalCost,
          totals.toolCalls,
          totals.edits,
        );

        deleteModelCalls.run(header.id);
        for (const row of modelCalls) {
          insertModelCall.run(
            header.id,
            header.cwd,
            row.provider,
            row.model,
            row.callCount,
          );
        }

        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        db.close();
      }
    } catch (error) {
      console.error(`[${EXTENSION_ID}] Failed to persist session usage`, error);
    }
  });

  pi.registerCommand("usage-stats", {
    description:
      "Show aggregate token, cost, and session totals from the SQLite tracker",
    handler: async (_args, ctx) => {
      try {
        const db = ensureDatabase();
        const row = db
          .prepare(
            `
						SELECT
							COUNT(*) AS sessions,
							COALESCE(SUM(input_tokens), 0) AS input_tokens,
							COALESCE(SUM(output_tokens), 0) AS output_tokens,
							COALESCE(SUM(total_tokens), 0) AS total_tokens,
							COALESCE(SUM(total_cost), 0) AS total_cost,
							COALESCE(SUM(tool_calls), 0) AS tool_calls,
							COALESCE(SUM(edits), 0) AS edits,
							COALESCE(SUM(duration_ms), 0) AS duration_ms
						FROM session_usage
					`,
          )
          .get() as {
          sessions: number;
          input_tokens: number;
          output_tokens: number;
          total_tokens: number;
          total_cost: number;
          tool_calls: number;
          edits: number;
          duration_ms: number;
        };
        db.close();

        const totalHours = row.duration_ms / (1000 * 60 * 60);
        const lines = [
          `DB: ${DB_PATH}`,
          `Sessions: ${row.sessions}`,
          `Input tokens: ${row.input_tokens}`,
          `Output tokens: ${row.output_tokens}`,
          `Total tokens: ${row.total_tokens}`,
          `Total cost: ${formatMoney(row.total_cost)}`,
          `Tool calls: ${row.tool_calls}`,
          `Edits: ${row.edits}`,
          `Duration: ${totalHours.toFixed(2)}h`,
        ];

        if (ctx.hasUI) {
          ctx.ui.notify(lines.join("\n"), "info");
        } else {
          console.log(lines.join("\n"));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) {
          ctx.ui.notify(`usage-stats failed: ${message}`, "error");
        } else {
          console.error(`usage-stats failed: ${message}`);
        }
      }
    },
  });
}
