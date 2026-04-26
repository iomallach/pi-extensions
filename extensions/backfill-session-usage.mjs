#!/usr/bin/env node

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DB_PATH =
  process.env.PI_SESSION_USAGE_DB ??
  join(homedir(), ".pi", "agent", "session-usage.db");
const DEFAULT_SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

function parseArgs(argv) {
  const options = {
    dbPath: DEFAULT_DB_PATH,
    sessionsDir: DEFAULT_SESSIONS_DIR,
    dryRun: false,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }
    if (arg === "--db") {
      options.dbPath = resolve(argv[++i]);
      continue;
    }
    if (arg === "--sessions-dir") {
      options.sessionsDir = resolve(argv[++i]);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(
    [
      "Backfill session_usage and session_model_calls rows from stored Pi session JSONL files.",
      "",
      "Usage:",
      "  node backfill-session-usage.mjs [--dry-run] [--verbose] [--db <path>] [--sessions-dir <path>]",
      "",
      "Defaults:",
      `  --db ${DEFAULT_DB_PATH}`,
      `  --sessions-dir ${DEFAULT_SESSIONS_DIR}`,
    ].join("\n"),
  );
}

function ensureDatabase(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
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

function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function countEditsFromArgs(args) {
  if (!args || typeof args !== "object") return 1;
  const edits = args.edits;
  return Array.isArray(edits) ? edits.length : 1;
}

function normalizeModelPart(value, fallback) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function walkJsonlFiles(rootDir) {
  const files = [];
  const pending = [resolve(rootDir)];

  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (entry.isFile() && extname(entry.name) === ".jsonl") {
        files.push(fullPath);
      }
    }
  }

  files.sort();
  return files;
}

function parseSessionFile(sessionFile) {
  const lines = readFileSync(sessionFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error("Session file is empty");
  }

  const toolCallArgsById = new Map();
  const modelCallCounts = new Map();
  let sessionId;
  let cwd;
  let startedAt;
  let endedAt;
  let sessionName = null;

  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    toolCalls: 0,
    edits: 0,
  };

  for (const line of lines) {
    const entry = JSON.parse(line);
    if (!endedAt && typeof entry.timestamp === "string") {
      endedAt = entry.timestamp;
    } else if (typeof entry.timestamp === "string") {
      endedAt = entry.timestamp;
    }

    if (entry.type === "session") {
      sessionId = entry.id;
      cwd = entry.cwd;
      startedAt = entry.timestamp;
      continue;
    }

    if (
      entry.type === "session_info" &&
      typeof entry.name === "string" &&
      entry.name.trim()
    ) {
      sessionName = entry.name.trim();
      continue;
    }

    if (
      entry.type !== "message" ||
      !entry.message ||
      typeof entry.message !== "object"
    ) {
      continue;
    }

    const message = entry.message;
    if (message.role === "assistant") {
      totals.inputTokens += asNumber(message.usage?.input);
      totals.outputTokens += asNumber(message.usage?.output);
      totals.cacheReadTokens += asNumber(message.usage?.cacheRead);
      totals.cacheWriteTokens += asNumber(message.usage?.cacheWrite);
      totals.totalTokens += asNumber(message.usage?.totalTokens);
      totals.totalCost += asNumber(message.usage?.cost?.total);

      const provider = normalizeModelPart(message.provider, "unknown-provider");
      const model = normalizeModelPart(message.model, "unknown-model");
      const modelKey = `${provider}\u0000${model}`;
      modelCallCounts.set(modelKey, {
        provider,
        model,
        callCount: (modelCallCounts.get(modelKey)?.callCount ?? 0) + 1,
      });

      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!block || typeof block !== "object") continue;
          if (block.type !== "toolCall" || typeof block.id !== "string")
            continue;
          toolCallArgsById.set(block.id, block.arguments ?? {});
        }
      }
      continue;
    }

    if (message.role !== "toolResult") {
      continue;
    }

    totals.toolCalls += 1;
    if (message.isError) {
      continue;
    }

    if (message.toolName === "edit") {
      totals.edits += countEditsFromArgs(
        toolCallArgsById.get(message.toolCallId),
      );
    } else if (message.toolName === "write") {
      totals.edits += 1;
    }
  }

  if (!sessionId || !cwd || !startedAt || !endedAt) {
    throw new Error("Missing required session metadata");
  }

  const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  return {
    sessionUsage: {
      session_id: sessionId,
      session_file: sessionFile,
      session_name: sessionName,
      cwd,
      started_at: startedAt,
      ended_at: endedAt,
      updated_at: endedAt,
      duration_ms: Number.isFinite(durationMs) ? durationMs : 0,
      input_tokens: totals.inputTokens,
      output_tokens: totals.outputTokens,
      cache_read_tokens: totals.cacheReadTokens,
      cache_write_tokens: totals.cacheWriteTokens,
      total_tokens: totals.totalTokens,
      total_cost: totals.totalCost,
      tool_calls: totals.toolCalls,
      edits: totals.edits,
    },
    modelCalls: [...modelCallCounts.values()].sort((a, b) => {
      if (b.callCount !== a.callCount) return b.callCount - a.callCount;
      if (a.provider !== b.provider)
        return a.provider.localeCompare(b.provider);
      return a.model.localeCompare(b.model);
    }),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const sessionFiles = walkJsonlFiles(options.sessionsDir);
  const rows = [];
  const failures = [];

  for (const sessionFile of sessionFiles) {
    try {
      const row = parseSessionFile(sessionFile);
      rows.push(row);
      if (options.verbose) {
        console.log(`Parsed ${sessionFile}`);
      }
    } catch (error) {
      failures.push({
        sessionFile,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const totalModelCallRows = rows.reduce(
    (sum, row) => sum + row.modelCalls.length,
    0,
  );
  console.log(
    `Found ${sessionFiles.length} session files in ${options.sessionsDir}`,
  );
  console.log(`Parsed ${rows.length} sessions successfully`);
  console.log(`Prepared ${totalModelCallRows} session_model_calls rows`);
  if (failures.length > 0) {
    console.log(`Skipped ${failures.length} sessions with errors`);
    for (const failure of failures) {
      console.log(`  - ${failure.sessionFile}: ${failure.message}`);
    }
  }

  if (options.dryRun) {
    console.log("Dry run only; database was not modified.");
    return;
  }

  const db = ensureDatabase(options.dbPath);
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
    for (const row of rows) {
      upsertSessionUsage.run(
        row.sessionUsage.session_id,
        row.sessionUsage.session_file,
        row.sessionUsage.session_name,
        row.sessionUsage.cwd,
        row.sessionUsage.started_at,
        row.sessionUsage.ended_at,
        row.sessionUsage.updated_at,
        row.sessionUsage.duration_ms,
        row.sessionUsage.input_tokens,
        row.sessionUsage.output_tokens,
        row.sessionUsage.cache_read_tokens,
        row.sessionUsage.cache_write_tokens,
        row.sessionUsage.total_tokens,
        row.sessionUsage.total_cost,
        row.sessionUsage.tool_calls,
        row.sessionUsage.edits,
      );

      deleteModelCalls.run(row.sessionUsage.session_id);
      for (const modelCall of row.modelCalls) {
        insertModelCall.run(
          row.sessionUsage.session_id,
          row.sessionUsage.cwd,
          modelCall.provider,
          modelCall.model,
          modelCall.callCount,
        );
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const usageSummary = db
    .prepare(
      "SELECT COUNT(*) AS sessions, COALESCE(SUM(total_tokens), 0) AS total_tokens, COALESCE(SUM(total_cost), 0) AS total_cost FROM session_usage",
    )
    .get();
  const modelCallSummary = db
    .prepare(
      "SELECT COUNT(*) AS rows, COALESCE(SUM(call_count), 0) AS total_calls FROM session_model_calls",
    )
    .get();
  db.close();

  console.log(
    `Upserted ${rows.length} session_usage rows into ${options.dbPath}`,
  );
  console.log(
    `Upserted ${totalModelCallRows} session_model_calls rows into ${options.dbPath}`,
  );
  console.log(
    `Database now has ${usageSummary.sessions} sessions, ${usageSummary.total_tokens} total tokens, $${Number(usageSummary.total_cost).toFixed(4)} total cost`,
  );
  console.log(
    `Database now has ${modelCallSummary.rows} model-call rows covering ${modelCallSummary.total_calls} assistant calls`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
