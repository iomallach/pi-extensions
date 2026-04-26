import { visibleWidth } from "@mariozechner/pi-tui";

import {
  formatSessionTimestamp,
  truncateText,
} from "../../lib/formatting.js";

export class CenteredSessionList {
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
