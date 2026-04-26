import { visibleWidth } from "@mariozechner/pi-tui";

import type { ModelUsageRow } from "../../data/session-usage.js";
import {
  formatCompactNumber,
  formatPercent,
  padStartVisible,
  truncateText,
} from "../../lib/formatting.js";

export class CenteredModelUsageSummary {
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
