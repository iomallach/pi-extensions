import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { showWelcomeDashboard } from "./dashboard/view.js";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;
    if (!ctx.hasUI) return;

    await showWelcomeDashboard(ctx);
  });
}
