import type { EditToolInput, WriteToolInput } from "@mariozechner/pi-coding-agent";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildDiffData, getProposalLanguage } from "./diff.js";
import type { EditProposal, GateProposal, WriteProposal } from "./types.js";

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

function defaultReason(toolName: "edit" | "write", path: string): string {
  return toolName === "edit"
    ? `Agent proposed targeted edits for ${path}.`
    : `Agent proposed writing ${path}.`;
}

export async function createEditProposal(cwd: string, input: EditToolInput): Promise<EditProposal> {
  const absolutePath = resolve(cwd, input.path);
  const originalContent = await readFile(absolutePath, "utf8");
  const nextContent = applyEditPreview(originalContent, input.edits);

  return {
    toolName: "edit",
    path: input.path,
    absolutePath,
    language: getProposalLanguage(input.path),
    originalContent,
    nextContent,
    diff: buildDiffData(originalContent, nextContent),
    reason: defaultReason("edit", input.path),
    manualEditApplied: false,
    input,
  };
}

export async function createWriteProposal(cwd: string, input: WriteToolInput): Promise<WriteProposal> {
  const absolutePath = resolve(cwd, input.path);
  const originalContent = await readFileIfPresent(absolutePath);

  return {
    toolName: "write",
    path: input.path,
    absolutePath,
    language: getProposalLanguage(input.path),
    originalContent,
    nextContent: input.content,
    diff: buildDiffData(originalContent, input.content),
    reason: defaultReason("write", input.path),
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
