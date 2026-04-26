import { visibleWidth } from "@mariozechner/pi-tui";

export class CenteredComponent {
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
