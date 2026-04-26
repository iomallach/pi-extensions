import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { highlightCode } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

import { kindPrefix } from "./diff.js";
import type { DiffRow, GateProposal, ReviewAction, SplitDiffRow } from "./types.js";

const VIEWPORT_HEIGHT = 18;

function padLineNumber(value?: number): string {
  return value === undefined ? "    " : String(value).padStart(4, " ");
}

function tint(theme: Theme, kind: "context" | "add" | "remove" | "empty", text: string): string {
  switch (kind) {
    case "add":
      return theme.fg("success", text);
    case "remove":
      return theme.fg("error", text);
    case "empty":
      return theme.fg("dim", text);
    default:
      return text;
  }
}

function highlight(text: string, language: string | undefined, _theme: Theme): string {
  if (!language) return text.length === 0 ? " " : text;
  return highlightCode(text.length === 0 ? " " : text, language)[0] ?? text;
}

function formatUnifiedRow(row: DiffRow, width: number, language: string | undefined, theme: Theme): string {
  const prefix = kindPrefix(row.kind);
  const numbers = `${padLineNumber(row.oldLineNumber)} ${padLineNumber(row.newLineNumber)}`;
  const content = highlight(row.text, language, theme);
  const raw = `${theme.fg("dim", numbers)} ${tint(theme, row.kind, prefix)} ${content}`;
  return truncateToWidth(raw, width);
}

function formatSplitCell(
  kind: "context" | "remove" | "add" | "empty",
  lineNumber: number | undefined,
  text: string,
  width: number,
  language: string | undefined,
  theme: Theme,
): string {
  const prefixMap: Record<typeof kind, string> = {
    context: " ",
    remove: "-",
    add: "+",
    empty: " ",
  };
  const number = lineNumber === undefined ? "    " : String(lineNumber).padStart(4, " ");
  const content = kind === "empty" ? "" : highlight(text, language, theme);
  const raw = `${theme.fg("dim", number)} ${tint(theme, kind, prefixMap[kind])} ${tint(theme, kind, content)}`;
  return truncateToWidth(raw, width);
}

function formatSplitRow(row: SplitDiffRow, width: number, language: string | undefined, theme: Theme): string {
  const gap = " │ ";
  const cellWidth = Math.max(10, Math.floor((width - gap.length) / 2));
  const left = formatSplitCell(row.leftKind, row.leftLineNumber, row.leftText, cellWidth, language, theme);
  const right = formatSplitCell(row.rightKind, row.rightLineNumber, row.rightText, cellWidth, language, theme);
  return `${left.padEnd(cellWidth, " ")}${theme.fg("dim", gap)}${right}`;
}

export async function showReviewUi(ctx: ExtensionContext, proposal: GateProposal): Promise<ReviewAction | null> {
  return ctx.ui.custom<ReviewAction | null>((tui, theme, _kb, done) => {
    let offset = 0;
    let viewMode: "unified" | "split" = "unified";
    let cached: string[] | undefined;

    const getRows = () => (viewMode === "unified" ? proposal.diff.rows : proposal.diff.splitRows);

    function totalRows(): number {
      return getRows().length;
    }

    function clampOffset() {
      offset = Math.max(0, Math.min(offset, Math.max(0, totalRows() - VIEWPORT_HEIGHT)));
    }

    function rerender() {
      cached = undefined;
      clampOffset();
      tui.requestRender();
    }

    function handleInput(data: string) {
      if (matchesKey(data, Key.up) || data === "k") {
        offset -= 1;
        rerender();
        return;
      }
      if (matchesKey(data, Key.down) || data === "j") {
        offset += 1;
        rerender();
        return;
      }
      if (matchesKey(data, "ctrl+u")) {
        offset -= Math.max(1, Math.floor(VIEWPORT_HEIGHT / 2));
        rerender();
        return;
      }
      if (matchesKey(data, "ctrl+d")) {
        offset += Math.max(1, Math.floor(VIEWPORT_HEIGHT / 2));
        rerender();
        return;
      }
      if (data === "v" || data === "V") {
        viewMode = viewMode === "unified" ? "split" : "unified";
        rerender();
        return;
      }
      if (data === "a" || data === "A" || matchesKey(data, Key.enter)) {
        done("approve");
        return;
      }
      if (data === "s" || data === "S") {
        done("steer");
        return;
      }
      if (data === "e" || data === "E") {
        done("edit");
        return;
      }
      if (data === "d" || data === "D") {
        done("deny");
        return;
      }
      if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
        done("cancel");
      }
    }

    function render(width: number): string[] {
      if (cached) return cached;

      const lines: string[] = [];
      const push = (line = "") => lines.push(truncateToWidth(line, width));
      const rows = getRows();
      const pageEnd = Math.min(rows.length, offset + VIEWPORT_HEIGHT);

      push(theme.fg("accent", "─".repeat(width)));
      push(theme.bold(` Editgate review • ${proposal.path}`));
      push(
        `${theme.fg("muted", proposal.toolName.toUpperCase())}  ${theme.fg("dim", "view:")} ${theme.fg("accent", viewMode)}  ${theme.fg("dim", "changes:")} ${theme.fg("success", `+${proposal.diff.additions}`)} ${theme.fg("error", `-${proposal.diff.removals}`)}`,
      );
      push(theme.fg("muted", proposal.reason));
      push(theme.fg("dim", `rows ${rows.length === 0 ? 0 : offset + 1}-${pageEnd} of ${rows.length}`));
      push(theme.fg("accent", "─".repeat(width)));

      if (rows.length === 0) {
        push(theme.fg("muted", " No textual changes detected."));
      } else {
        for (let index = offset; index < pageEnd; index++) {
          const row = rows[index]!;
          if (viewMode === "unified") {
            push(formatUnifiedRow(row as DiffRow, width, proposal.language, theme));
          } else {
            push(formatSplitRow(row as SplitDiffRow, width, proposal.language, theme));
          }
        }
      }

      while (lines.length < 6 + VIEWPORT_HEIGHT) {
        push();
      }

      push(theme.fg("accent", "─".repeat(width)));
      push(theme.fg("dim", "j/k scroll • ctrl-u/ctrl-d page • v toggle view • a approve • s steer • e edit • d deny • esc cancel"));
      push(theme.fg("accent", "─".repeat(width)));
      cached = lines;
      return lines;
    }

    return {
      render,
      invalidate() {
        cached = undefined;
      },
      handleInput,
    };
  });
}
