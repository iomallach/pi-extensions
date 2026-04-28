import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { withEditedContent } from "./proposals.js";
import type { GateProposal, ReviewOutcome } from "./types.js";
import { showReviewUi } from "./ui.js";

export async function reviewProposal(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  initialProposal: GateProposal,
): Promise<ReviewOutcome> {
  let proposal = initialProposal;

  if (!ctx.hasUI) {
    return { kind: "approve", proposal };
  }

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
