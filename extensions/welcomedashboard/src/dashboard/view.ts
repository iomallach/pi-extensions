import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import {
  Container,
  Key,
  Spacer,
  matchesKey,
} from "@mariozechner/pi-tui";

import {
  getModelUsageRows,
  getUsageSummary,
} from "../data/session-usage.js";
import { CenteredComponent } from "./components/centered-component.js";
import { CenteredModelUsageSummary } from "./components/centered-model-usage.js";
import { CenteredSessionList } from "./components/centered-session-list.js";
import { CenteredUsageSummary } from "./components/centered-usage-summary.js";

const LOGO = `
██████╗      ██╗██╗  ██╗██╗███████╗
╚════██╗    ███║██║  ██║██║██╔════╝
 █████╔╝    ╚██║███████║██║███████╗
 ╚═══██╗     ██║╚════██║██║╚════██║
██████╔╝ ██╗ ██║     ██║██║███████║
╚═════╝  ╚═╝ ╚═╝     ╚═╝╚═╝╚══════╝
        
`;

export async function showWelcomeDashboard(ctx: ExtensionContext) {
  ctx.ui.setHeader(() => ({
    render: () => [],
    invalidate() { },
  }));
  ctx.ui.setFooter(() => ({
    render: () => [],
    invalidate() { },
  }));

  const sessions = await SessionManager.list(ctx.cwd);
  sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  const recentSessions = sessions.slice(0, 5);
  const allUsage = getUsageSummary();
  const cwdUsage = getUsageSummary("WHERE cwd = ?", ctx.cwd);
  const modelUsageRows = getModelUsageRows(ctx.cwd);

  await ctx.ui.custom<null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    const title = new CenteredComponent(LOGO.trim().split("\n"), (line) =>
      theme.fg("accent", line),
    );
    const sessionList = new CenteredSessionList(
      recentSessions.map((s) => ({
        name: s.name?.trim() || s.firstMessage.trim() || s.id,
        modified: s.modified,
      })),
      60,
      (text) => text,
      (text) => theme.fg("muted", text),
    );
    const usageSummary = new CenteredUsageSummary(
      [
        { label: "All", summary: allUsage },
        { label: "Project", summary: cwdUsage },
      ],
      60,
      (text) => text,
      (text) => theme.fg("dim", text),
      (text) => theme.fg("accent", text),
      (text) => theme.fg("success", text),
    );
    const modelUsageSummary = new CenteredModelUsageSummary(
      modelUsageRows,
      60,
      (text) => theme.fg("dim", text),
      (text) => text,
      (text) => theme.fg("accent", text),
      (text) => theme.fg("success", text),
    );

    container.addChild(new Spacer(2));
    container.addChild(title);
    container.addChild(new Spacer(1));
    container.addChild(
      new CenteredComponent([" Recent sessions"], (line) =>
        theme.fg("success", line),
      ),
    );
    container.addChild(sessionList);
    container.addChild(new Spacer(2));
    container.addChild(
      new CenteredComponent([" Usage & cost"], (line) =>
        theme.fg("success", line),
      ),
    );
    container.addChild(usageSummary);
    if (modelUsageRows.length > 0) {
      container.addChild(new Spacer(2));
      container.addChild(
        new CenteredComponent([" Model usage"], (line) =>
          theme.fg("success", line),
        ),
      );
      container.addChild(modelUsageSummary);
    }
    container.addChild(new Spacer(1));
    container.addChild(
      new CenteredComponent(["[esc/q] continue"], (line) => theme.fg("dim", line)),
    );

    return {
      render: (w) => container.render(w),
      handleInput(data: string) {
        if (matchesKey(data, Key.esc)) done(null);
        else if (matchesKey(data, "q")) done(null);
        tui.requestRender();
      },
      invalidate: () => container.invalidate(),
    };
  });

  ctx.ui.setHeader(undefined);
  ctx.ui.setFooter(undefined);
}
