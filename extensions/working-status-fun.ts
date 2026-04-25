import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATUSES = [
	"Horsing around...",
  "Burning tokens for no good reason...",
  "rm -rf'ing...",
  "1001 1101 1110 0001'ing...",
  "Entslopifying...",
  "Consulting the void...",
  "Bribing the compiler...",
  "Creating black holes...",
  "Figuring out the Theory of Everything...",
  "Destroying your dreams and hopes...",
  "Dividing by zero...",
  "Making the billion dollar mistake...",
  "Overclocking your keyboard...",
  "Sacrificing a lamb...",
];

const MIN_INTERVAL_MS = 1400;
const MAX_INTERVAL_MS = 3200;

export default function workingStatusFunExtension(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastStatus: string | undefined;

	const pickRandomStatus = (): string => {
		if (STATUSES.length === 0) return "Working...";
		if (STATUSES.length === 1) return STATUSES[0];

		let next = STATUSES[Math.floor(Math.random() * STATUSES.length)];
		while (next === lastStatus) {
			next = STATUSES[Math.floor(Math.random() * STATUSES.length)];
		}
		return next;
	};

	const stop = (ctx: ExtensionContext) => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		lastStatus = undefined;
		ctx.ui.setWorkingMessage();
	};

	const scheduleNextUpdate = (ctx: ExtensionContext) => {
		if (timer) clearTimeout(timer);

		const delay = Math.floor(Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS + 1)) + MIN_INTERVAL_MS;
		timer = setTimeout(() => {
			const next = pickRandomStatus();
			lastStatus = next;
			ctx.ui.setWorkingMessage(next);
			scheduleNextUpdate(ctx);
		}, delay);
	};

	const start = (ctx: ExtensionContext) => {
		stop(ctx);
		const next = pickRandomStatus();
		lastStatus = next;
		ctx.ui.setWorkingMessage(next);
		scheduleNextUpdate(ctx);
	};

	pi.on("agent_start", async (_event, ctx) => {
		start(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stop(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stop(ctx);
	});
}
