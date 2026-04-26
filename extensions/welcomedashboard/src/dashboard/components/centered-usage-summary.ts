import { visibleWidth } from "@mariozechner/pi-tui";

import type { UsageSummary } from "../../data/session-usage.js";
import {
  formatMoney,
  formatTokenBreakdown,
  padStartVisible,
  truncateText,
} from "../../lib/formatting.js";

export class CenteredUsageSummary {
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
