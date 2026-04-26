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

import { reviewProposal } from "./editgate/actions.js";
import { createEditProposal, createWriteProposal } from "./editgate/proposals.js";
import type { GateProposal } from "./editgate/types.js";

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

async function executeApprovedEdit(
  originalEdit: ReturnType<typeof createEditToolDefinition>,
  originalWrite: ReturnType<typeof createWriteToolDefinition>,
  toolCallId: string,
  input: EditToolInput,
  proposal: GateProposal,
  signal: AbortSignal | undefined,
  onUpdate: any,
  ctx: ExtensionContext,
) {
  if (proposal.toolName === "edit" && !proposal.manualEditApplied) {
    return originalEdit.execute(toolCallId, input, signal, onUpdate, ctx);
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
  return originalWrite.execute(
    toolCallId,
    { path: proposal.path, content: proposal.nextContent },
    signal,
    onUpdate,
    ctx,
  );
}

export default function editgate(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const originalEdit = createEditToolDefinition(cwd);
  const originalWrite = createWriteToolDefinition(cwd);

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
    description: "Apply an exact text replacement after editgate diff review.",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
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
    description: "Write file contents after editgate diff review.",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
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
