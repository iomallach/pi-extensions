import type { EditToolInput } from "@mariozechner/pi-coding-agent";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildDiffData, getProposalLanguage } from "./diff.js";
import type { EditProposal, GateProposal, ReasonedEditToolInput, ReasonedWriteToolInput, WriteProposal } from "./types.js";

async function readFileIfPresent(path: string): Promise<string> {
  try {
    await access(path);
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function findUniqueOccurrence(haystack: string, needle: string): number {
  const first = haystack.indexOf(needle);
  if (first === -1) {
    throw new Error(`Could not preview edit because oldText was not found exactly once.`);
  }
  const second = haystack.indexOf(needle, first + needle.length);
  if (second !== -1) {
    throw new Error(`Could not preview edit because oldText matched multiple locations.`);
  }
  return first;
}

function applyEditPreview(content: string, edits: EditToolInput["edits"]): string {
  const ranges = edits.map((edit) => {
    const start = findUniqueOccurrence(content, edit.oldText);
    return {
      start,
      end: start + edit.oldText.length,
      newText: edit.newText,
    };
  });

  ranges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index - 1]!.end > ranges[index]!.start) {
      throw new Error(`Could not preview edit because edit regions overlap.`);
    }
  }

  let cursor = 0;
  let next = "";
  for (const range of ranges) {
    next += content.slice(cursor, range.start);
    next += range.newText;
    cursor = range.end;
  }
  next += content.slice(cursor);
  return next;
}

function normalizeExplicitReason(reason: string | undefined): string | undefined {
  const normalized = reason?.replace(/\s+/g, " ").trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function summarizeDiff(additions: number, removals: number): string {
  if (additions === 0 && removals === 0) return "without textual line changes";
  if (additions > 0 && removals > 0) return `changing ${additions} line(s) and removing ${removals} line(s)`;
  if (additions > 0) return `adding ${additions} line(s)`;
  return `removing ${removals} line(s)`;
}

function previewText(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return undefined;
  return line.length > 72 ? `${line.slice(0, 69)}...` : line;
}

function fallbackEditReason(input: ReasonedEditToolInput, additions: number, removals: number): string {
  const count = input.edits.length;
  const firstNewText = previewText(input.edits[0]?.newText ?? "");
  const summary = `Review ${count} targeted replacement(s) in ${input.path}, ${summarizeDiff(additions, removals)}.`;
  return firstNewText ? `${summary} First changed text starts with: “${firstNewText}”.` : summary;
}

function fallbackWriteReason(input: ReasonedWriteToolInput, originalContent: string, additions: number, removals: number): string {
  const verb = originalContent.length === 0 ? "Create" : "Overwrite";
  const firstContent = previewText(input.content);
  const summary = `Review ${verb.toLowerCase()} of ${input.path}, ${summarizeDiff(additions, removals)}.`;
  return firstContent ? `${summary} New content starts with: “${firstContent}”.` : summary;
}

export async function createEditProposal(cwd: string, input: ReasonedEditToolInput): Promise<EditProposal> {
  const absolutePath = resolve(cwd, input.path);
  const originalContent = await readFile(absolutePath, "utf8");
  const nextContent = applyEditPreview(originalContent, input.edits);
  const diff = buildDiffData(originalContent, nextContent);

  return {
    toolName: "edit",
    path: input.path,
    absolutePath,
    language: getProposalLanguage(input.path),
    originalContent,
    nextContent,
    diff,
    reason: normalizeExplicitReason(input.reason) ?? fallbackEditReason(input, diff.additions, diff.removals),
    manualEditApplied: false,
    input,
  };
}

export async function createWriteProposal(cwd: string, input: ReasonedWriteToolInput): Promise<WriteProposal> {
  const absolutePath = resolve(cwd, input.path);
  const originalContent = await readFileIfPresent(absolutePath);
  const diff = buildDiffData(originalContent, input.content);

  return {
    toolName: "write",
    path: input.path,
    absolutePath,
    language: getProposalLanguage(input.path),
    originalContent,
    nextContent: input.content,
    diff,
    reason: normalizeExplicitReason(input.reason) ?? fallbackWriteReason(input, originalContent, diff.additions, diff.removals),
    manualEditApplied: false,
    input,
  };
}

export function withEditedContent(proposal: GateProposal, nextContent: string): GateProposal {
  const updatedBase = {
    ...proposal,
    nextContent,
    diff: buildDiffData(proposal.originalContent, nextContent),
    manualEditApplied: true,
  };

  if (proposal.toolName === "edit") {
    return {
      ...updatedBase,
      toolName: "edit",
      input: proposal.input,
    };
  }

  return {
    ...updatedBase,
    toolName: "write",
    input: {
      ...proposal.input,
      content: nextContent,
    },
  };
}
