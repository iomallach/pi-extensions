import type { EditToolInput, WriteToolInput } from "@mariozechner/pi-coding-agent";

export type ReasonedEditToolInput = EditToolInput & { reason?: string };
export type ReasonedWriteToolInput = WriteToolInput & { reason?: string };

export type GateToolName = "edit" | "write";
export type DiffKind = "context" | "add" | "remove";

export interface DiffRow {
  kind: DiffKind;
  oldLineNumber?: number;
  newLineNumber?: number;
  text: string;
}

export interface SplitDiffRow {
  leftKind: "context" | "remove" | "empty";
  rightKind: "context" | "add" | "empty";
  leftLineNumber?: number;
  rightLineNumber?: number;
  leftText: string;
  rightText: string;
}

export interface DiffData {
  rows: DiffRow[];
  splitRows: SplitDiffRow[];
  additions: number;
  removals: number;
}

interface ProposalBase {
  toolName: GateToolName;
  path: string;
  absolutePath: string;
  language?: string;
  originalContent: string;
  nextContent: string;
  diff: DiffData;
  reason: string;
  manualEditApplied: boolean;
}

export interface EditProposal extends ProposalBase {
  toolName: "edit";
  input: ReasonedEditToolInput;
}

export interface WriteProposal extends ProposalBase {
  toolName: "write";
  input: ReasonedWriteToolInput;
}

export type GateProposal = EditProposal | WriteProposal;

export type ReviewAction = "approve" | "deny" | "steer" | "cancel";

export type ReviewUiResult = ReviewAction | { kind: "edit"; nextContent: string };

export type ReviewOutcome =
  | { kind: "approve"; proposal: GateProposal }
  | { kind: "deny" }
  | { kind: "steer"; feedback: string }
  | { kind: "cancel" };
