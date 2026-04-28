import { complete } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const TITLE_SYSTEM_PROMPT = [
	"Generate a very short title (3-6 words) for a coding session based on the user's first message.",
	"The title must capture the main task or topic.",
	"Output only the title.",
	"Do not include quotes.",
	"Do not include trailing punctuation.",
].join(" ");

const MAX_INPUT_CHARS = 2000;
const PREFERRED_TITLE_MODELS: Array<readonly [string, string]> = [
	["google", "gemini-2.5-flash"],
	["openai", "gpt-5-nano"],
	["anthropic", "claude-3-5-haiku-latest"],
	["anthropic", "claude-3-haiku-20240307"],
];

type ResolvedTitleModel = {
	model: Model<Api>;
	apiKey: string;
	headers?: Record<string, string>;
};


function extractText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}

	if (!Array.isArray(content)) {
		return "";
	}

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") {
			continue;
		}

		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string") {
			parts.push(candidate.text);
		}
	}

	return parts.join("\n");
}

function sanitizeTitle(title: string): string | undefined {
	const sanitized = title
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/^\s*["']+|["']+\s*$/g, "")
		.replace(/[.!?]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();

	return sanitized || undefined;
}

function truncateInput(text: string): string {
	return text.length > MAX_INPUT_CHARS ? `${text.slice(0, MAX_INPUT_CHARS)}…` : text;
}

function formatModel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function getCandidateModels(ctx: ExtensionContext): Model<Api>[] {
	const models: Model<Api>[] = [];
	const seen = new Set<string>();
	const push = (model: Model<Api> | undefined) => {
		if (!model) {
			return;
		}
		const key = formatModel(model);
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		models.push(model);
	};

	push(ctx.model);
	for (const [provider, id] of PREFERRED_TITLE_MODELS) {
		push(ctx.modelRegistry.find(provider, id));
	}
	for (const model of ctx.modelRegistry.getAvailable()) {
		push(model);
	}

	return models;
}

async function resolveTitleModel(ctx: ExtensionContext): Promise<ResolvedTitleModel | undefined> {
	for (const model of getCandidateModels(ctx)) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			continue;
		}

		return {
			model,
			apiKey: auth.apiKey,
			headers: auth.headers,
		};
	}

	return undefined;
}

function getFirstUserMessageText(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "user") {
			continue;
		}

		const text = extractText(entry.message.content).trim();
		if (text) {
			return text;
		}
	}

	return undefined;
}

function countUserMessages(ctx: ExtensionContext): number {
	let count = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "user") {
			count++;
		}
	}
	return count;
}

async function generateTitle(firstPrompt: string, ctx: ExtensionContext): Promise<string | undefined> {
	const resolved = await resolveTitleModel(ctx);
	if (!resolved) {
		return undefined;
	}

	const response = await complete(
		resolved.model,
		{
			systemPrompt: TITLE_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: `<user-message>\n${truncateInput(firstPrompt)}\n</user-message>`,
						},
					],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: resolved.apiKey,
			headers: resolved.headers,
			maxTokens: 30,
			signal: ctx.signal,
		},
	);

	if (response.stopReason === "error" || response.stopReason === "aborted") {
		return undefined;
	}

	const text = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n");
	return sanitizeTitle(text);
}

export default function (pi: ExtensionAPI) {
	let inFlight = false;

	const maybeSetAutoTitle = async (
		ctx: ExtensionContext,
		options?: { force?: boolean; notify?: boolean },
	): Promise<void> => {
		const force = options?.force === true;
		const notify = options?.notify === true;
		if (inFlight || (!force && pi.getSessionName())) {
			return;
		}

		const firstPrompt = getFirstUserMessageText(ctx);
		if (!firstPrompt) {
			if (notify && ctx.hasUI) {
				ctx.ui.notify("No user message found to title", "warning");
			}
			return;
		}

		inFlight = true;
		try {
			const title = await generateTitle(firstPrompt, ctx);
			if (!title) {
				if (notify && ctx.hasUI) {
					ctx.ui.notify("Auto title generation failed", "warning");
				}
				return;
			}

			pi.setSessionName(title);
			if (notify && ctx.hasUI) {
				ctx.ui.notify(`Session titled: ${title}`, "info");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (notify && ctx.hasUI) {
				ctx.ui.notify(`Auto title error: ${message}`, "error");
			}
		} finally {
			inFlight = false;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		inFlight = false;
    if (!ctx.hasUi) return;
		if (pi.getSessionName()) {
			return;
		}

		if (countUserMessages(ctx) > 0) {
			void maybeSetAutoTitle(ctx);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUi) return;
		if (pi.getSessionName()) {
			return;
		}

		if (countUserMessages(ctx) !== 1) {
			return;
		}

		void maybeSetAutoTitle(ctx);
	});

	pi.registerCommand("retitle-session", {
		description: "Generate a session title from the first user prompt",
		handler: async (_args, ctx) => {
			await maybeSetAutoTitle(ctx, { force: true, notify: true });
		},
	});

}
