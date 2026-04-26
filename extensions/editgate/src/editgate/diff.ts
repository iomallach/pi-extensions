import { getLanguageFromPath } from "@mariozechner/pi-coding-agent";

import type { DiffData, DiffKind, DiffRow, SplitDiffRow } from "./types.js";

function splitLines(value: string): string[] {
  return value.split("\n");
}

function buildDiffRows(before: string, after: string): DiffRow[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const n = beforeLines.length;
  const m = afterLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (beforeLines[i] === afterLines[j]) {
        dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let oldLineNumber = 1;
  let newLineNumber = 1;

  while (i < n && j < m) {
    if (beforeLines[i] === afterLines[j]) {
      rows.push({
        kind: "context",
        oldLineNumber,
        newLineNumber,
        text: beforeLines[i]!,
      });
      i++;
      j++;
      oldLineNumber++;
      newLineNumber++;
      continue;
    }

    if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ kind: "remove", oldLineNumber, text: beforeLines[i]! });
      i++;
      oldLineNumber++;
    } else {
      rows.push({ kind: "add", newLineNumber, text: afterLines[j]! });
      j++;
      newLineNumber++;
    }
  }

  while (i < n) {
    rows.push({ kind: "remove", oldLineNumber, text: beforeLines[i]! });
    i++;
    oldLineNumber++;
  }

  while (j < m) {
    rows.push({ kind: "add", newLineNumber, text: afterLines[j]! });
    j++;
    newLineNumber++;
  }

  return rows;
}

function buildSplitRows(rows: DiffRow[]): SplitDiffRow[] {
  const result: SplitDiffRow[] = [];

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;

    if (row.kind === "context") {
      result.push({
        leftKind: "context",
        rightKind: "context",
        leftLineNumber: row.oldLineNumber,
        rightLineNumber: row.newLineNumber,
        leftText: row.text,
        rightText: row.text,
      });
      continue;
    }

    if (row.kind === "remove") {
      const removals: DiffRow[] = [];
      const additions: DiffRow[] = [];

      while (index < rows.length && rows[index]!.kind === "remove") {
        removals.push(rows[index]!);
        index++;
      }
      while (index < rows.length && rows[index]!.kind === "add") {
        additions.push(rows[index]!);
        index++;
      }
      index--;

      const pairCount = Math.max(removals.length, additions.length);
      for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
        const left = removals[pairIndex];
        const right = additions[pairIndex];
        result.push({
          leftKind: left ? "remove" : "empty",
          rightKind: right ? "add" : "empty",
          leftLineNumber: left?.oldLineNumber,
          rightLineNumber: right?.newLineNumber,
          leftText: left?.text ?? "",
          rightText: right?.text ?? "",
        });
      }
      continue;
    }

    result.push({
      leftKind: "empty",
      rightKind: "add",
      rightLineNumber: row.newLineNumber,
      leftText: "",
      rightText: row.text,
    });
  }

  return result;
}

export function buildDiffData(before: string, after: string): DiffData {
  const rows = buildDiffRows(before, after);
  return {
    rows,
    splitRows: buildSplitRows(rows),
    additions: rows.filter((row) => row.kind === "add").length,
    removals: rows.filter((row) => row.kind === "remove").length,
  };
}

export function getProposalLanguage(path: string): string | undefined {
  return getLanguageFromPath(path) ?? undefined;
}

export function kindPrefix(kind: DiffKind): string {
  switch (kind) {
    case "add":
      return "+";
    case "remove":
      return "-";
    default:
      return " ";
  }
}
