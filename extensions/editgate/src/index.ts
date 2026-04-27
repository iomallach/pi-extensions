import type { ExtensionAPI, ToolCallEvent } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

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

function applyApprovedEditMutation(event: ToolCallEvent, proposal: GateProposal) {
  if (!isToolCallEventType("edit", event)) return;
  if (proposal.toolName !== "edit" || !proposal.manualEditApplied) return;

  event.input.edits = [
    {
      oldText: proposal.originalContent,
      newText: proposal.nextContent,
    },
  ];
}

function applyApprovedWriteMutation(event: ToolCallEvent, proposal: GateProposal) {
  if (!isToolCallEventType("write", event)) return;
  event.input.content = proposal.nextContent;
}

export default function editgate(pi: ExtensionAPI) {
  pi.registerCommand("editgate-status", {
    description: "Show that the local editgate extension is loaded",
    handler: async (_args, ctx) => {
      ctx.ui.notify("editgate extension loaded", "info");
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("edit", event)) {
      const proposal = await createEditProposal(ctx.cwd, event.input as ReasonedEditToolInput);
      const outcome = await reviewProposal(pi, ctx, proposal);

      if (outcome.kind === "approve") {
        applyApprovedEditMutation(event, outcome.proposal);
        return;
      }
      if (outcome.kind === "steer") {
        return { block: true, reason: steerMessage(proposal, outcome.feedback) };
      }
      if (outcome.kind === "deny") {
        return { block: true, reason: denialMessage(proposal) };
      }
      return { block: true, reason: cancelMessage(proposal) };
    }

    if (isToolCallEventType("write", event)) {
      const proposal = await createWriteProposal(ctx.cwd, event.input as ReasonedWriteToolInput);
      const outcome = await reviewProposal(pi, ctx, proposal);

      if (outcome.kind === "approve") {
        applyApprovedWriteMutation(event, outcome.proposal);
        return;
      }
      if (outcome.kind === "steer") {
        return { block: true, reason: steerMessage(proposal, outcome.feedback) };
      }
      if (outcome.kind === "deny") {
        return { block: true, reason: denialMessage(proposal) };
      }
      return { block: true, reason: cancelMessage(proposal) };
    }
  });
}
