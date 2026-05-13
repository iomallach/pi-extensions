import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { withEditedContent } from "./proposals.js";
import type { EditgateServer } from "./server.js";
import type { GateProposal, ReviewOutcome, ViewMode } from "./types.js";
import { showReviewUi } from "./ui.js";

export async function reviewProposal(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  initialProposal: GateProposal,
  opts: { viewMode: ViewMode; server: EditgateServer },
): Promise<ReviewOutcome> {
  let proposal = initialProposal;

  if (!ctx.hasUI) {
    return { kind: "approve", proposal };
  }

  // ── Web mode: delegate a single decision round-trip to the browser ────────
  if (opts.viewMode === "web" && opts.server.isRunning) {
    const outcome = await opts.server.awaitDecision(proposal);
    if (outcome.kind === "steer" && !ctx.isIdle()) {
      pi.sendUserMessage(outcome.feedback, { deliverAs: "steer" });
    }
    return outcome;
  }

  // ── TUI mode: existing terminal UI loop ───────────────────────────────────
  while (true) {
    const action = await showReviewUi(ctx, proposal);

    if (action === "approve") {
      return { kind: "approve", proposal };
    }
    if (action === "deny") {
      return { kind: "deny" };
    }
    if (action === "cancel" || action == null) {
      return { kind: "cancel" };
    }
    if (action === "steer") {
      const feedback = await ctx.ui.editor(
        "Steer this change",
        "Please revise this proposal. Specific feedback:\n",
      );
      if (!feedback || !feedback.trim()) {
        continue;
      }
      if (!ctx.isIdle()) {
        pi.sendUserMessage(feedback.trim(), { deliverAs: "steer" });
      }
      return { kind: "steer", feedback: feedback.trim() };
    }
    if (typeof action === "object" && action.kind === "edit") {
      proposal = withEditedContent(proposal, action.nextContent);
    }
  }
}
