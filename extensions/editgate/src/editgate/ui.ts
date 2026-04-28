import { basename, extname, join } from "node:path";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { highlightCode } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type TUI } from "@mariozechner/pi-tui";

import { kindPrefix } from "./diff.js";
import type { DiffRow, GateProposal, ReviewUiResult } from "./types.js";

const VIEWPORT_HEIGHT = 18;

type RowKind = "context" | "add" | "remove" | "empty";

function padLineNumber(value?: number): string {
  return value === undefined ? "    " : String(value).padStart(4, " ");
}

function withBackground(theme: Theme, kind: RowKind, text: string): string {
  switch (kind) {
    case "remove":
      return theme.bg("toolErrorBg", text);
    case "context":
    case "add":
    case "empty":
    default:
      return theme.bg("toolSuccessBg", text);
  }
}

function tint(theme: Theme, kind: RowKind, text: string): string {
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
  return withBackground(theme, row.kind, truncateToWidth(raw, width, "...", true));
}

function createEditorTempPath(targetPath: string): string {
  const extension = extname(targetPath);
  const baseName = basename(targetPath, extension).replace(/[^a-zA-Z0-9._-]+/g, "-") || "editgate";
  return join(tmpdir(), `${baseName}.editgate-${Date.now()}${extension}`);
}

function openProposalInEditor(ctx: ExtensionContext, tui: TUI, proposal: GateProposal): string | undefined {
  const editorCmd = process.env.VISUAL || process.env.EDITOR;
  if (!editorCmd) {
    ctx.ui.notify("No editor configured. Set $VISUAL or $EDITOR.", "warning");
    return undefined;
  }

  const tempPath = createEditorTempPath(proposal.path);
  let notification: { message: string; type: "info" | "warning" | "error" } | undefined;
  let tuiStopped = false;

  try {
    writeFileSync(tempPath, proposal.nextContent, "utf8");
    tui.stop();
    tuiStopped = true;

    const [editor, ...editorArgs] = editorCmd.split(" ");
    const result = spawnSync(editor!, [...editorArgs, tempPath], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    if (result.error) {
      notification = { message: `Failed to launch editor: ${result.error.message}`, type: "error" };
      return undefined;
    }

    if (result.status === 0) {
      return readFileSync(tempPath, "utf8").replace(/\n$/, "");
    }

    notification = { message: "Editor closed without saving changes.", type: "warning" };
    return undefined;
  } catch (error) {
    notification = {
      message: error instanceof Error ? `Failed to open editor: ${error.message}` : "Failed to open editor.",
      type: "error",
    };
    return undefined;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors.
    }
    if (tuiStopped) {
      tui.start();
      tui.requestRender(true);
    }
    if (notification) {
      ctx.ui.notify(notification.message, notification.type);
    }
  }
}

export async function showReviewUi(ctx: ExtensionContext, proposal: GateProposal): Promise<ReviewUiResult | null> {
  return ctx.ui.custom<ReviewUiResult | null>((tui, theme, _kb, done) => {
    let offset = 0;
    let cached: string[] | undefined;

    function totalRows(): number {
      return proposal.diff.rows.length;
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
      if (data === "a" || data === "A" || matchesKey(data, Key.enter)) {
        done("approve");
        return;
      }
      if (data === "s" || data === "S") {
        done("steer");
        return;
      }
      if (data === "e" || data === "E") {
        const edited = openProposalInEditor(ctx, tui, proposal);
        if (edited !== undefined) {
          done({ kind: "edit", nextContent: edited });
          return;
        }
        rerender();
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
      const pushWrapped = (text: string) => {
        for (const line of wrapTextWithAnsi(text, Math.max(1, width))) {
          push(line);
        }
      };
      const rows = proposal.diff.rows;
      const pageEnd = Math.min(rows.length, offset + VIEWPORT_HEIGHT);

      push(theme.fg("accent", "─".repeat(width)));
      push(theme.bold(` Editgate review • ${proposal.path}`));
      push(
        `${theme.fg("muted", proposal.toolName.toUpperCase())}  ${theme.fg("dim", "changes:")} ${theme.fg("success", `+${proposal.diff.additions}`)} ${theme.fg("error", `-${proposal.diff.removals}`)}`,
      );
      pushWrapped(theme.fg("muted", proposal.reason));
      push(theme.fg("dim", `rows ${rows.length === 0 ? 0 : offset + 1}-${pageEnd} of ${rows.length}`));
      push(theme.fg("accent", "─".repeat(width)));

      if (rows.length === 0) {
        push(theme.fg("muted", " No textual changes detected."));
      } else {
        for (let index = offset; index < pageEnd; index++) {
          push(formatUnifiedRow(rows[index]!, width, proposal.language, theme));
        }
      }

      while (lines.length < 6 + VIEWPORT_HEIGHT) {
        push();
      }

      push(theme.fg("accent", "─".repeat(width)));
      push(theme.fg("dim", "j/k scroll • ctrl-u/ctrl-d page"));
      push(
        [
          theme.fg("success", "a approve"),
          theme.fg("warning", "s steer"),
          theme.fg("warning", "e edit"),
          theme.fg("error", "d deny"),
          "esc cancel",
        ].join(theme.fg("dim", " • ")),
      );
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
