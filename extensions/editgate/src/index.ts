import type { ExtensionAPI, ToolCallEvent } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { reviewProposal } from "./editgate/actions.js";
import { createEditProposal, createWriteProposal } from "./editgate/proposals.js";
import type { GateProposal, ReasonedEditToolInput, ReasonedWriteToolInput } from "./editgate/types.js";

const EDITGATE_STATUS_KEY = "editgate";
const EDITGATE_REASON_TOOL_NAME = "set_change_reason";
const EDITGATE_REASON_GUIDANCE = `Before every edit/write tool call, call ${EDITGATE_REASON_TOOL_NAME} first with one concrete reason tied to repository context and behavior impact.`;
const ANSI_GREEN = "\u001b[32m";
const ANSI_RED = "\u001b[31m";
const ANSI_RESET = "\u001b[39m";

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

function formatEditgateStatus(enabled: boolean): string {
  const color = enabled ? ANSI_GREEN : ANSI_RED;
  return `${color}editgate ${enabled ? "on" : "off"}${ANSI_RESET}`;
}

function normalizeReason(reason: string | undefined): string | undefined {
  const normalized = reason?.replace(/\s+/g, " ").trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export default function editgate(pi: ExtensionAPI) {
  let editgateEnabled = true;
  const pendingReasons: string[] = [];

  const clearPendingReasons = () => {
    pendingReasons.length = 0;
  };

  const queuePendingReason = (reason: string): boolean => {
    const normalized = normalizeReason(reason);
    if (!normalized) return false;
    pendingReasons.push(normalized);
    return true;
  };

  const consumePendingReason = (): string | undefined => {
    while (pendingReasons.length > 0) {
      const reason = pendingReasons.shift();
      if (reason) return reason;
    }
    return undefined;
  };

  const syncReasonToolActivation = () => {
    const api = pi as Partial<Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">>;
    if (typeof api.getActiveTools !== "function" || typeof api.setActiveTools !== "function") return;

    const activeTools = api.getActiveTools();
    if (activeTools.includes(EDITGATE_REASON_TOOL_NAME)) return;

    api.setActiveTools([...activeTools, EDITGATE_REASON_TOOL_NAME]);
  };

  const setStatus = (ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }) => {
    ctx.ui.setStatus(EDITGATE_STATUS_KEY, formatEditgateStatus(editgateEnabled));
  };

  const updateEnabled = (
    enabled: boolean,
    ctx: { ui: { setStatus: (key: string, text: string | undefined) => void; notify: (message: string, type?: "info" | "warning" | "error") => void } },
  ) => {
    editgateEnabled = enabled;
    if (!enabled) {
      clearPendingReasons();
    }
    syncReasonToolActivation();
    setStatus(ctx);
    ctx.ui.notify(`editgate ${enabled ? "on" : "off"}`, "info");
  };

  pi.registerTool?.({
    name: EDITGATE_REASON_TOOL_NAME,
    label: EDITGATE_REASON_TOOL_NAME,
    description: "Record the reason for the next edit/write proposal.",
    promptSnippet: "Record reason before each edit/write",
    promptGuidelines: [
      `Before each edit/write call, use ${EDITGATE_REASON_TOOL_NAME} with one concrete reason tied to current code.`,
    ],
    parameters: Type.Object({
      reason: Type.String({ description: "Concrete reason for the next file mutation." }),
    }),
    async execute(_toolCallId, params: { reason: string }) {
      return {
        content: [{ type: "text" as const, text: `Reason recorded: ${params.reason.trim()}` }],
        details: undefined,
      };
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (!editgateEnabled) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${EDITGATE_REASON_GUIDANCE}`,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    clearPendingReasons();
    syncReasonToolActivation();
    setStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearPendingReasons();
    ctx.ui.setStatus(EDITGATE_STATUS_KEY, undefined);
  });

  pi.on("input", async (event) => {
    if (event.source !== "extension") {
      clearPendingReasons();
    }
  });

  pi.registerCommand("editgate-status", {
    description: "Show whether editgate approvals are currently enabled",
    handler: async (_args, ctx) => {
      setStatus(ctx);
      ctx.ui.notify(`editgate is ${editgateEnabled ? "on" : "off"}`, "info");
    },
  });

  pi.registerCommand("editgate:on", {
    description: "Require approval for edit/write tool calls",
    handler: async (_args, ctx) => {
      updateEnabled(true, ctx);
    },
  });

  pi.registerCommand("editgate:off", {
    description: "Allow edit/write tool calls to pass through without approval",
    handler: async (_args, ctx) => {
      updateEnabled(false, ctx);
    },
  });

  pi.registerCommand("editgate:toggle", {
    description: "Toggle editgate approval mode",
    handler: async (_args, ctx) => {
      updateEnabled(!editgateEnabled, ctx);
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    setStatus(ctx);

    if (event.toolName === EDITGATE_REASON_TOOL_NAME) {
      const reason = normalizeReason((event.input as { reason?: string } | undefined)?.reason);
      if (!reason) {
        return { block: true, reason: `Blocked ${EDITGATE_REASON_TOOL_NAME}: include a non-empty reason and retry.` };
      }

      event.input = { reason };
      if (editgateEnabled) {
        queuePendingReason(reason);
      }
      return;
    }

    if (!editgateEnabled) {
      return;
    }

    if (isToolCallEventType("edit", event)) {
      const proposalInput: ReasonedEditToolInput = {
        ...(event.input as ReasonedEditToolInput),
        reason: normalizeReason((event.input as ReasonedEditToolInput).reason) ?? consumePendingReason(),
      };
      if (!proposalInput.reason) {
        return {
          block: true,
          reason: `editgate blocked edit for ${proposalInput.path}: call ${EDITGATE_REASON_TOOL_NAME} first with a concrete reason, then retry one edit proposal.`,
        };
      }

      const proposal = await createEditProposal(ctx.cwd, proposalInput);
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
      const proposalInput: ReasonedWriteToolInput = {
        ...(event.input as ReasonedWriteToolInput),
        reason: normalizeReason((event.input as ReasonedWriteToolInput).reason) ?? consumePendingReason(),
      };
      if (!proposalInput.reason) {
        return {
          block: true,
          reason: `editgate blocked write for ${proposalInput.path}: call ${EDITGATE_REASON_TOOL_NAME} first with a concrete reason, then retry one write proposal.`,
        };
      }

      const proposal = await createWriteProposal(ctx.cwd, proposalInput);
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
