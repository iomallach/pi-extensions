import { visibleWidth } from "@mariozechner/pi-tui";

import type { UsageSummary } from "../data/session-usage.js";

export function truncateText(text: string, maxWidth: number): string {
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

export function formatSessionTimestamp(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatTokenBreakdown(summary: UsageSummary): string {
  return `${formatCompactNumber(summary.inputTokens)} ↑ (${formatCompactNumber(summary.cacheReadTokens)} c) / ${formatCompactNumber(summary.outputTokens)} ↓`;
}

export function padStartVisible(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

export function formatMoney(amount: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(amount);
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}
