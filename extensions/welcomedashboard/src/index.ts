import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  type ExtensionAPI,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import {
  matchesKey,
  Key,
  Container,
  Spacer,
  visibleWidth,
} from "@mariozechner/pi-tui";

const LOGO = `
██████╗      ██╗██╗  ██╗██╗███████╗
╚════██╗    ███║██║  ██║██║██╔════╝
 █████╔╝    ╚██║███████║██║███████╗
 ╚═══██╗     ██║╚════██║██║╚════██║
██████╔╝ ██╗ ██║     ██║██║███████║
╚═════╝  ╚═╝ ╚═╝     ╚═╝╚═╝╚══════╝
        
`;
const SESSION_USAGE_DB_PATH =
  process.env.PI_SESSION_USAGE_DB ??
  join(homedir(), ".pi", "agent", "session-usage.db");

type UsageSummary = {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
};

type ModelUsageRow = {
  scope: string;
  model: string;
  calls: number;
  percent: number;
};

class CenteredComponent {
  constructor(
    private lines: string[],
    private style?: (line: string) => string,
  ) { }

  render(width: number): string[] {
    const out: string[] = [];

    for (const rawLine of this.lines) {
      const line = this.style ? this.style(rawLine) : rawLine;
      const pad = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
      out.push(" ".repeat(pad) + line);
    }
    return out;
  }

  invalidate() { }
}

class CenteredSessionList {
  constructor(
    private rows: { name: string; modified: Date }[],
    private listWidth: number,
    private nameStyle: (text: string) => string,
    private dateStyle: (text: string) => string,
  ) { }

  render(width: number): string[] {
    const innerWidth = Math.min(this.listWidth, width);
    const pad = Math.max(0, Math.floor((width - innerWidth) / 2));

    return this.rows.map((row) => {
      const date = formatSessionTimestamp(row.modified);
      const dateWidth = visibleWidth(date);
      const minGap = 3;
      const maxNameWidth = Math.max(0, innerWidth - dateWidth - minGap);
      const name = truncateText(row.name, maxNameWidth);
      const gap = Math.max(minGap, innerWidth - visibleWidth(name) - dateWidth);
      const line = `${this.nameStyle(name)}${" ".repeat(gap)}${this.dateStyle(date)}`;
      return " ".repeat(pad) + line;
    });
  }

  invalidate() { }
}

class CenteredUsageSummary {
  constructor(
    private rows: { label: string; summary: UsageSummary }[],
    private listWidth: number,
    private labelStyle: (text: string) => string,
    private metaStyle: (text: string) => string,
    private tokenStyle: (text: string) => string,
    private costStyle: (text: string) => string,
  ) { }

  render(width: number): string[] {
    const innerWidth = Math.min(this.listWidth, width);
    const pad = Math.max(0, Math.floor((width - innerWidth) / 2));
    const tokenWidth = Math.max(
      ...this.rows.map((row) =>
        visibleWidth(formatTokenBreakdown(row.summary)),
      ),
      0,
    );
    const costWidth = Math.max(
      ...this.rows.map((row) =>
        visibleWidth(formatMoney(row.summary.totalCost)),
      ),
      0,
    );

    return this.rows.map((row) => {
      const sessionsText = `${row.summary.sessions} sess`;
      const tokensText = padStartVisible(
        formatTokenBreakdown(row.summary),
        tokenWidth,
      );
      const costText = padStartVisible(
        formatMoney(row.summary.totalCost),
        costWidth,
      );
      const leftPlain = `${row.label} (${sessionsText})`;
      const rightPlain = `${tokensText}   ${costText}`;
      const maxLeftWidth = Math.max(
        0,
        innerWidth - visibleWidth(rightPlain) - 3,
      );
      const leftLabel = truncateText(
        row.label,
        Math.max(0, maxLeftWidth - visibleWidth(` (${sessionsText})`)),
      );
      const left = `${this.labelStyle(leftLabel)} ${this.metaStyle(`(${sessionsText})`)}`;
      const gap = Math.max(
        3,
        innerWidth - visibleWidth(leftPlain) - visibleWidth(rightPlain),
      );
      const right = `${this.tokenStyle(tokensText)}   ${this.costStyle(costText)}`;
      return " ".repeat(pad) + `${left}${" ".repeat(gap)}${right}`;
    });
  }

  invalidate() { }
}

class CenteredModelUsageSummary {
  constructor(
    private rows: ModelUsageRow[],
    private listWidth: number,
    private scopeStyle: (text: string) => string,
    private modelStyle: (text: string) => string,
    private callsStyle: (text: string) => string,
    private percentStyle: (text: string) => string,
  ) { }

  render(width: number): string[] {
    const innerWidth = Math.min(this.listWidth, width);
    const pad = Math.max(0, Math.floor((width - innerWidth) / 2));
    const callsWidth = Math.max(
      ...this.rows.map((row) => visibleWidth(formatCompactNumber(row.calls))),
      0,
    );
    const percentWidth = Math.max(
      ...this.rows.map((row) => visibleWidth(formatPercent(row.percent))),
      0,
    );

    return this.rows.map((row) => {
      const callsText = padStartVisible(
        formatCompactNumber(row.calls),
        callsWidth,
      );
      const percentText = padStartVisible(
        formatPercent(row.percent),
        percentWidth,
      );
      const rightPlain = `${callsText}   ${percentText}`;
      const scopeText = `${row.scope} `;
      const maxModelWidth = Math.max(
        0,
        innerWidth - visibleWidth(scopeText) - visibleWidth(rightPlain) - 3,
      );
      const modelText = truncateText(row.model, maxModelWidth);
      const leftPlain = `${scopeText}${modelText}`;
      const left = `${this.scopeStyle(row.scope)} ${this.modelStyle(modelText)}`;
      const gap = Math.max(
        3,
        innerWidth - visibleWidth(leftPlain) - visibleWidth(rightPlain),
      );
      const right = `${this.callsStyle(callsText)}   ${this.percentStyle(percentText)}`;
      return " ".repeat(pad) + `${left}${" ".repeat(gap)}${right}`;
    });
  }

  invalidate() { }
}

function truncateText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return "…";

  let out = "";
  for (const char of text) {
    if (visibleWidth(out + char + "…") > maxWidth) break;
    out += char;
  }
  return out + "…";
}

function formatSessionTimestamp(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatTokenBreakdown(summary: UsageSummary): string {
  return `${formatCompactNumber(summary.inputTokens)} ↑ (${formatCompactNumber(summary.cacheReadTokens)} c) / ${formatCompactNumber(summary.outputTokens)} ↓`;
}

function padStartVisible(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

function formatMoney(amount: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(amount);
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function getUsageSummary(whereClause?: string, param?: string): UsageSummary {
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

function getModelUsageRows(cwd: string): ModelUsageRow[] {
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

// TODO: ideas to show on dashboard: stats, last active session, other sessions
// active model, most frequently used models, most expensive session
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;
    if (!ctx.hasUI) return;

    ctx.ui.setHeader(() => ({
      render: () => [],
      invalidate() { },
    }));
    ctx.ui.setFooter(() => ({
      render: () => [],
      invalidate() { },
    }));

    const sessions = await SessionManager.list(ctx.cwd);
    sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    const recentSessions = sessions.slice(0, 5);
    const allUsage = getUsageSummary();
    const cwdUsage = getUsageSummary("WHERE cwd = ?", ctx.cwd);
    const modelUsageRows = getModelUsageRows(ctx.cwd);

    await ctx.ui.custom<null>((tui, theme, keybindings, done) => {
      const container = new Container();
      const title = new CenteredComponent(LOGO.trim().split("\n"), (line) =>
        theme.fg("accent", line),
      );
      const sessionList = new CenteredSessionList(
        recentSessions.map((s) => ({
          name: s.name?.trim() || s.firstMessage.trim() || s.id,
          modified: s.modified,
        })),
        60,
        (text) => text,
        (text) => theme.fg("muted", text),
      );
      const usageSummary = new CenteredUsageSummary(
        [
          { label: "All", summary: allUsage },
          { label: "Project", summary: cwdUsage },
        ],
        60,
        (text) => text,
        (text) => theme.fg("dim", text),
        (text) => theme.fg("accent", text),
        (text) => theme.fg("success", text),
      );
      const modelUsageSummary = new CenteredModelUsageSummary(
        modelUsageRows,
        60,
        (text) => theme.fg("dim", text),
        (text) => text,
        (text) => theme.fg("accent", text),
        (text) => theme.fg("success", text),
      );

      container.addChild(new Spacer(2));
      container.addChild(title);
      container.addChild(new Spacer(1));
      container.addChild(
        new CenteredComponent([" Recent sessions"], (line) =>
          theme.fg("success", line),
        ),
      );
      container.addChild(sessionList);
      container.addChild(new Spacer(2));
      container.addChild(
        new CenteredComponent([" Usage & cost"], (line) =>
          theme.fg("success", line),
        ),
      );
      container.addChild(usageSummary);
      if (modelUsageRows.length > 0) {
        container.addChild(new Spacer(2));
        container.addChild(
          new CenteredComponent([" Model usage"], (line) =>
            theme.fg("success", line),
          ),
        );
        container.addChild(modelUsageSummary);
      }
      container.addChild(new Spacer(1));
      container.addChild(
        new CenteredComponent(["[q]  quit"], (line) => theme.fg("dim", line)),
      );

      return {
        render: (w) => container.render(w),
        handleInput(data: string) {
          if (matchesKey(data, Key.esc)) done(null);
          else if (matchesKey(data, "q")) done(null);
          tui.requestRender();
        },
        invalidate: () => container.invalidate(),
      };
    });

    ctx.ui.setHeader(undefined);
    ctx.ui.setFooter(undefined);
  });
}
