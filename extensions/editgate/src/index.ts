import type {
  EditToolInput,
  ExtensionAPI,
  ExtensionContext,
  WriteToolInput,
} from "@mariozechner/pi-coding-agent";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { reviewProposal } from "./editgate/actions.js";
import { createEditProposal, createWriteProposal } from "./editgate/proposals.js";
import type { GateProposal, ReasonedEditToolInput, ReasonedWriteToolInput } from "./editgate/types.js";

function denialMessage(proposal: GateProposal): string {
  return `editgate blocked ${proposal.toolName} for ${proposal.path}: the user denied the proposal.`;
}

function steerMessage(proposal: GateProposal, feedback: string): string {
  return [
    `editgate did not apply the proposed ${proposal.toolName} for ${proposal.path}.`,
    "The user requested a revised proposal with this feedback:",
    feedback,
  ].join("\n");
}

function cancelMessage(proposal: GateProposal): string {
  return `editgate cancelled review for ${proposal.toolName} on ${proposal.path}; no file changes were applied.`;
}

function stripEditReason(input: ReasonedEditToolInput): EditToolInput {
  const { reason: _reason, ...builtInInput } = input;
  return builtInInput;
}

function stripWriteReason(input: ReasonedWriteToolInput): WriteToolInput {
  const { reason: _reason, ...builtInInput } = input;
  return builtInInput;
}

async function executeApprovedEdit(
  originalEdit: ReturnType<typeof createEditToolDefinition>,
  originalWrite: ReturnType<typeof createWriteToolDefinition>,
  toolCallId: string,
  input: ReasonedEditToolInput,
  proposal: GateProposal,
  signal: AbortSignal | undefined,
  onUpdate: any,
  ctx: ExtensionContext,
) {
  if (proposal.toolName === "edit" && !proposal.manualEditApplied) {
    return originalEdit.execute(toolCallId, stripEditReason(input), signal, onUpdate, ctx);
  }

  return originalWrite.execute(
    toolCallId,
    { path: proposal.path, content: proposal.nextContent },
    signal,
    onUpdate,
    ctx,
  );
}

async function executeApprovedWrite(
  originalWrite: ReturnType<typeof createWriteToolDefinition>,
  toolCallId: string,
  proposal: GateProposal,
  signal: AbortSignal | undefined,
  onUpdate: any,
  ctx: ExtensionContext,
) {
  const input =
    proposal.toolName === "write"
      ? stripWriteReason(proposal.input)
      : { path: proposal.path, content: proposal.nextContent };

  return originalWrite.execute(toolCallId, input, signal, onUpdate, ctx);
}

export default function editgate(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const originalEdit = createEditToolDefinition(cwd);
  const originalWrite = createWriteToolDefinition(cwd);
  const reasonParameter = Type.Optional(
    Type.String({
      description:
        "Concise user-facing reason for this proposed change. Explain why the edit/write is needed before editgate review; omit if obvious.",
    }),
  );
  const gatedEditParameters = Type.Object(
    { ...originalEdit.parameters.properties, reason: reasonParameter },
    { additionalProperties: false },
  );
  const gatedWriteParameters = Type.Object(
    { ...originalWrite.parameters.properties, reason: reasonParameter },
    { additionalProperties: false },
  );

  pi.registerCommand("editgate-status", {
    description: "Show that the local editgate extension is loaded",
    handler: async (_args, ctx) => {
      ctx.ui.notify("editgate extension loaded", "info");
    },
  });

  pi.registerTool({
    ...originalEdit,
    name: "edit",
    label: "edit (gated)",
    description:
      "Propose exact text replacement for editgate review before applying it. Optionally include a concise reason explaining why the change is needed.",
    promptSnippet: "Propose precise file edits for editgate diff review before applying them",
    promptGuidelines: [
      ...(originalEdit.promptGuidelines ?? []),
      "For editgate-reviewed edits, include a concise optional reason when it helps the user understand why the change is being proposed.",
    ],
    parameters: gatedEditParameters,
    async execute(toolCallId, params: ReasonedEditToolInput, signal, onUpdate, ctx) {
      const proposal = await createEditProposal(ctx.cwd, params);
      const outcome = await reviewProposal(pi, ctx, proposal);

      if (outcome.kind === "approve") {
        return executeApprovedEdit(originalEdit, originalWrite, toolCallId, params, outcome.proposal, signal, onUpdate, ctx);
      }
      if (outcome.kind === "steer") {
        throw new Error(steerMessage(proposal, outcome.feedback));
      }
      if (outcome.kind === "deny") {
        throw new Error(denialMessage(proposal));
      }
      throw new Error(cancelMessage(proposal));
    },
  });

  pi.registerTool({
    ...originalWrite,
    name: "write",
    label: "write (gated)",
    description:
      "Propose writing file contents for editgate review before applying them. Optionally include a concise reason explaining why the write is needed.",
    promptSnippet: "Propose file writes for editgate diff review before applying them",
    promptGuidelines: [
      ...(originalWrite.promptGuidelines ?? []),
      "For editgate-reviewed writes, include a concise optional reason when it helps the user understand why the change is being proposed.",
    ],
    parameters: gatedWriteParameters,
    async execute(toolCallId, params: ReasonedWriteToolInput, signal, onUpdate, ctx) {
      const proposal = await createWriteProposal(ctx.cwd, params);
      const outcome = await reviewProposal(pi, ctx, proposal);

      if (outcome.kind === "approve") {
        return executeApprovedWrite(originalWrite, toolCallId, outcome.proposal, signal, onUpdate, ctx);
      }
      if (outcome.kind === "steer") {
        throw new Error(steerMessage(proposal, outcome.feedback));
      }
      if (outcome.kind === "deny") {
        throw new Error(denialMessage(proposal));
      }
      throw new Error(cancelMessage(proposal));
    },
  });
}
