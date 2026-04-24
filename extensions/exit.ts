import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function exitExtension(pi: ExtensionAPI) {
	pi.registerCommand("exit", {
		description: "Exit pi cleanly",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
