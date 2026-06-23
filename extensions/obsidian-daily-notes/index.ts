/**
 * Obsidian Daily Notes Extension
 *
 * Auto-logs accomplishments and decisions to Obsidian daily notes after each
 * meaningful interaction. Groups entries by project, enriched with git branch
 * and Jira ticket information.
 *
 * Features:
 * - agent_end hook: auto-summarizes work and appends to daily note
 * - obsidian_note tool: LLM can explicitly note decisions/accomplishments
 * - /note command: user can manually trigger a note entry
 * - before_agent_start: nudges LLM to use obsidian_note for important decisions
 *
 * Config: ~/.pi/obsidian-notes.json
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete, getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Config {
	vaultPath: string;
	dailyNotesFolder: string;
	jiraTicketPattern: string;
	/** Model for summarization (default: openai/gpt-4.1-mini) */
	summarizationModel?: { provider: string; id: string };
	/** Skip logging if no tools were called */
	skipTrivialInteractions: boolean;
	/** Enable debug logging to ~/.pi/obsidian-notes-debug.log and TUI notifications */
	debug: boolean;
}

interface ProjectContext {
	projectName: string;
	branch: string | null;
	jiraTicket: string | null;
}

interface NoteEntry {
	accomplished: string[];
	decisions: string[];
}

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(
	process.env.HOME || "~",
	".pi",
	"obsidian-notes.json",
);

const DEFAULT_CONFIG: Config = {
	vaultPath: "~/Documents/Obsidian/Vault",
	dailyNotesFolder: "Daily Notes",
	jiraTicketPattern: "^([A-Z]+-\\d+)",
	summarizationModel: { provider: "openai", id: "gpt-4.1-mini" },
	skipTrivialInteractions: true,
	debug: false,
};

// ─── Debug Logging ───────────────────────────────────────────────────────────

const DEBUG_LOG_PATH = path.join(
	process.env.HOME || "~",
	".pi",
	"obsidian-notes-debug.log",
);

function debugLog(config: Config, message: string, error?: unknown): void {
	if (!config.debug) return;

	const timestamp = new Date().toISOString();
	const errorStr = error instanceof Error
		? `\n  Error: ${error.message}\n  Stack: ${error.stack}`
		: error !== undefined
			? `\n  Details: ${JSON.stringify(error)}`
			: "";
	const line = `[${timestamp}] ${message}${errorStr}\n`;

	try {
		fs.appendFileSync(DEBUG_LOG_PATH, line, "utf-8");
	} catch {
		// Can't even write the log - nothing we can do
	}
}

function debugNotify(config: Config, ctx: ExtensionContext, message: string): void {
	if (!config.debug) return;
	if (ctx.hasUI) {
		ctx.ui.notify(`[obsidian-notes] ${message}`, "warning");
	}
}

function loadConfig(): Config {
	try {
		const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(raw);
		return { ...DEFAULT_CONFIG, ...parsed };
	} catch {
		return DEFAULT_CONFIG;
	}
}

function resolveVaultPath(config: Config): string {
	const resolved = config.vaultPath.replace(/^~/, process.env.HOME || "");
	return path.resolve(resolved);
}

// ─── Git / Jira Enrichment ───────────────────────────────────────────────────

function getGitBranch(cwd: string): string | null {
	try {
		return execSync("git branch --show-current", {
			cwd,
			encoding: "utf-8",
			timeout: 3000,
		}).trim() || null;
	} catch {
		return null;
	}
}

function getProjectName(cwd: string): string {
	// Try git remote name first
	try {
		const remote = execSync("git remote get-url origin", {
			cwd,
			encoding: "utf-8",
			timeout: 3000,
		}).trim();
		// Extract repo name from URL
		const match = remote.match(/\/([^/]+?)(?:\.git)?$/);
		if (match) return match[1];
	} catch {
		// Fall back to directory name
	}
	return path.basename(cwd);
}

function extractJiraTicket(branch: string, pattern: string): string | null {
	try {
		const regex = new RegExp(pattern);
		const match = branch.match(regex);
		return match ? match[1] : null;
	} catch {
		return null;
	}
}

function getProjectContext(cwd: string, config: Config): ProjectContext {
	const branch = getGitBranch(cwd);
	const jiraTicket = branch
		? extractJiraTicket(branch, config.jiraTicketPattern)
		: null;

	return {
		projectName: getProjectName(cwd),
		branch,
		jiraTicket,
	};
}

// ─── Daily Note File Operations ──────────────────────────────────────────────

function getDailyNotePath(config: Config): string {
	const vault = resolveVaultPath(config);
	const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
	return path.join(vault, config.dailyNotesFolder, `${today}.md`);
}

function ensureDailyNoteExists(notePath: string): void {
	const dir = path.dirname(notePath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	if (!fs.existsSync(notePath)) {
		const today = new Date().toISOString().split("T")[0];
		fs.writeFileSync(notePath, `# ${today}\n`, "utf-8");
	}
}

function buildProjectHeading(ctx: ProjectContext): string {
	const parts = [ctx.projectName];
	if (ctx.branch) {
		const branchPart = `\`${ctx.branch}\``;
		if (ctx.jiraTicket) {
			parts.push(`(${branchPart} · ${ctx.jiraTicket})`);
		} else {
			parts.push(`(${branchPart})`);
		}
	}
	return parts.join(" ");
}

/**
 * Appends entries to the daily note under the appropriate project section.
 * Creates the section if it doesn't exist, or appends to existing.
 */
function appendToDaily(
	config: Config,
	projectCtx: ProjectContext,
	entry: NoteEntry,
): void {
	if (entry.accomplished.length === 0 && entry.decisions.length === 0) {
		return;
	}

	const notePath = getDailyNotePath(config);
	ensureDailyNoteExists(notePath);

	let content = fs.readFileSync(notePath, "utf-8");
	const heading = buildProjectHeading(projectCtx);
	const sectionMarker = `## ${heading}`;

	if (content.includes(sectionMarker)) {
		// Append to existing section
		content = appendToExistingSection(
			content,
			sectionMarker,
			entry,
		);
	} else {
		// Create new section
		content = appendNewSection(content, sectionMarker, entry);
	}

	fs.writeFileSync(notePath, content, "utf-8");
}

function appendToExistingSection(
	content: string,
	sectionMarker: string,
	entry: NoteEntry,
): string {
	const lines = content.split("\n");
	const sectionIdx = lines.findIndex((l) => l.trim() === sectionMarker);
	if (sectionIdx === -1) return content;

	// Find the end of this section (next ## or end of file)
	let endIdx = lines.length;
	for (let i = sectionIdx + 1; i < lines.length; i++) {
		if (lines[i].startsWith("## ")) {
			endIdx = i;
			break;
		}
	}

	// Find or create sub-sections within the project section
	const sectionContent = lines.slice(sectionIdx, endIdx).join("\n");
	let updatedSection = sectionContent;

	if (entry.accomplished.length > 0) {
		updatedSection = appendToSubSection(
			updatedSection,
			"### Accomplished",
			entry.accomplished,
		);
	}

	if (entry.decisions.length > 0) {
		updatedSection = appendToSubSection(
			updatedSection,
			"### Decisions",
			entry.decisions,
		);
	}

	const before = lines.slice(0, sectionIdx).join("\n");
	const after = lines.slice(endIdx).join("\n");

	return [before, updatedSection, after].filter(Boolean).join("\n");
}

function appendToSubSection(
	sectionContent: string,
	subHeading: string,
	items: string[],
): string {
	const bullets = items.map((i) => `- ${i}`).join("\n");

	if (sectionContent.includes(subHeading)) {
		// Append bullets after the last bullet in this sub-section
		const lines = sectionContent.split("\n");
		const subIdx = lines.findIndex((l) => l.trim() === subHeading);
		if (subIdx === -1) return sectionContent;

		// Find end of bullet list (next heading or blank line followed by heading)
		let insertIdx = subIdx + 1;
		for (let i = subIdx + 1; i < lines.length; i++) {
			if (lines[i].startsWith("### ") || lines[i].startsWith("## ")) {
				break;
			}
			if (lines[i].startsWith("- ")) {
				insertIdx = i + 1;
			}
		}

		lines.splice(insertIdx, 0, bullets);
		return lines.join("\n");
	} else {
		// Add sub-section at the end
		return `${sectionContent}\n\n${subHeading}\n${bullets}`;
	}
}

function appendNewSection(
	content: string,
	sectionMarker: string,
	entry: NoteEntry,
): string {
	let section = `\n---\n\n${sectionMarker}`;

	if (entry.accomplished.length > 0) {
		section += `\n\n### Accomplished\n${entry.accomplished.map((i) => `- ${i}`).join("\n")}`;
	}

	if (entry.decisions.length > 0) {
		section += `\n\n### Decisions\n${entry.decisions.map((i) => `- ${i}`).join("\n")}`;
	}

	return content.trimEnd() + "\n" + section + "\n";
}

// ─── Summarization ───────────────────────────────────────────────────────────

interface ContentBlock {
	type?: string;
	text?: string;
	name?: string;
}

interface Message {
	role?: string;
	content?: unknown;
	toolName?: string;
}

interface SessionEntry {
	type: string;
	message?: Message;
}

function extractConversationForSummary(messages: SessionEntry[]): string {
	const parts: string[] = [];

	for (const entry of messages) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const msg = entry.message;

		if (msg.role === "user") {
			const text = extractText(msg.content);
			if (text) parts.push(`User: ${text}`);
		} else if (msg.role === "assistant") {
			const text = extractText(msg.content);
			if (text) parts.push(`Assistant: ${text}`);
			// Note tool calls
			const tools = extractToolCalls(msg.content);
			if (tools.length > 0) parts.push(`Tools used: ${tools.join(", ")}`);
		} else if (msg.role === "toolResult") {
			// Skip verbose tool results, just note the tool name
		}
	}

	return parts.join("\n");
}

function extractText(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;

	const texts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as ContentBlock).type === "text") {
			const text = (block as ContentBlock).text;
			if (text) texts.push(text);
		}
	}
	return texts.length > 0 ? texts.join("\n").slice(0, 2000) : null;
}

function extractToolCalls(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const tools: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as ContentBlock).type === "toolCall") {
			const name = (block as ContentBlock).name;
			if (name) tools.push(name);
		}
	}
	return tools;
}

function hadMeaningfulWork(messages: SessionEntry[]): boolean {
	for (const entry of messages) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg) continue;

		// Check if any mutation tools were called
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block && typeof block === "object" && (block as ContentBlock).type === "toolCall") {
					const name = (block as ContentBlock).name;
					if (name && ["write", "edit", "bash", "mcp"].includes(name)) {
						return true;
					}
				}
			}
		}
	}
	return false;
}

const SUMMARIZE_PROMPT = `You are a work-log assistant. Given a conversation between a user and a coding agent, extract:
1. What was ACCOMPLISHED (concrete results, files changed, features added, bugs fixed)
2. What DECISIONS were made (architectural choices, trade-offs, approaches chosen)

Rules:
- Each item should be a single concise bullet point (one line)
- Focus on outcomes, not process
- Skip trivial items (reading files, listing directories)
- If nothing meaningful was accomplished or decided, return empty arrays
- Maximum 5 bullets per category

Respond in JSON format only:
{"accomplished": ["item1", "item2"], "decisions": ["item1"]}`;

async function summarizeInteraction(
	conversationText: string,
	config: Config,
	ctx: ExtensionContext,
): Promise<NoteEntry> {
	const modelConfig = config.summarizationModel || {
		provider: "openai",
		id: "gpt-4.1-mini",
	};
	const model = getModel(modelConfig.provider, modelConfig.id);
	if (!model) {
		debugLog(config, `Summarization model not found: ${modelConfig.provider}/${modelConfig.id}`);
		debugNotify(config, ctx, `Model not found: ${modelConfig.provider}/${modelConfig.id}`);
		return { accomplished: [], decisions: [] };
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok) {
		debugLog(config, `Auth failed for ${modelConfig.provider}/${modelConfig.id}: ${(auth as any)?.error ?? "unknown error"}`);
		debugNotify(config, ctx, `Auth failed for ${modelConfig.provider}/${modelConfig.id}`);
		return { accomplished: [], decisions: [] };
	}
	if (!auth.apiKey) {
		debugLog(config, `No API key for ${modelConfig.provider}/${modelConfig.id}`);
		debugNotify(config, ctx, `No API key for ${modelConfig.provider}/${modelConfig.id}`);
		return { accomplished: [], decisions: [] };
	}

	debugLog(config, `Calling ${modelConfig.provider}/${modelConfig.id} for summarization...`);

	try {
		const response = await complete(
			model,
			{
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: `${SUMMARIZE_PROMPT}\n\n<conversation>\n${conversationText}\n</conversation>`,
							},
						],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: auth.apiKey, headers: auth.headers },
		);

		const responseText = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");

		debugLog(config, `Model response (${responseText.length} chars): ${responseText.slice(0, 500)}`);

		// Parse JSON from response (handle markdown code blocks)
		const jsonMatch = responseText.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = JSON.parse(jsonMatch[0]);
			return {
				accomplished: Array.isArray(parsed.accomplished) ? parsed.accomplished : [],
				decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
			};
		} else {
			debugLog(config, `Failed to parse JSON from model response: ${responseText.slice(0, 200)}`);
			debugNotify(config, ctx, "Summarization returned non-JSON response");
		}
	} catch (err) {
		debugLog(config, "Summarization model call failed", err);
		debugNotify(config, ctx, `Summarization failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	return { accomplished: [], decisions: [] };
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const vaultResolved = resolveVaultPath(config);

	// Verify vault exists at startup
	pi.on("session_start", async (_event, ctx) => {
		if (!fs.existsSync(vaultResolved)) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Obsidian vault not found: ${vaultResolved}. Create ${CONFIG_PATH} with your vaultPath.`,
					"warning",
				);
			}
		}
	});

	// ─── Auto-log on agent_end ─────────────────────────────────────────────

	pi.on("agent_end", async (event, ctx) => {
		if (!fs.existsSync(vaultResolved)) {
			debugLog(config, `Vault not found at ${vaultResolved}, skipping auto-log`);
			return;
		}

		const messages = event.messages as SessionEntry[];

		// Skip trivial interactions
		if (config.skipTrivialInteractions && !hadMeaningfulWork(messages)) {
			debugLog(config, "Skipping: no meaningful work detected (no write/edit/bash/mcp tools)");
			return;
		}

		const projectCtx = getProjectContext(ctx.cwd, config);
		const conversationText = extractConversationForSummary(messages);

		if (!conversationText.trim()) {
			debugLog(config, "Skipping: empty conversation text after extraction");
			return;
		}

		debugLog(config, `Auto-logging for project "${projectCtx.projectName}" (branch: ${projectCtx.branch ?? "none"}, ticket: ${projectCtx.jiraTicket ?? "none"})`);
		debugLog(config, `Conversation text length: ${conversationText.length} chars`);

		// Summarize and append (async, don't block the user)
		summarizeInteraction(conversationText, config, ctx)
			.then((entry) => {
				if (entry.accomplished.length === 0 && entry.decisions.length === 0) {
					debugLog(config, "Summarization returned empty results - nothing to append");
					return;
				}
				debugLog(config, `Appending: ${entry.accomplished.length} accomplishments, ${entry.decisions.length} decisions`);
				appendToDaily(config, projectCtx, entry);
				debugLog(config, `Successfully appended to daily note`);
			})
			.catch((err) => {
				debugLog(config, "Auto-log failed", err);
				debugNotify(config, ctx, "Auto-log failed, see ~/.pi/obsidian-notes-debug.log");
			});
	});

	// ─── obsidian_note tool ────────────────────────────────────────────────

	pi.registerTool({
		name: "obsidian_note",
		label: "Obsidian Note",
		description:
			"Add a note to today's Obsidian daily note. Use for recording important decisions, accomplishments, or observations that should be tracked.",
		promptSnippet:
			"Record accomplishments, decisions, or observations to the Obsidian daily note",
		promptGuidelines: [
			"Use obsidian_note when you make an important architectural decision, complete a significant task, or when the user explicitly asks to note something.",
			"Do not use obsidian_note for trivial actions like reading files or running simple queries.",
		],
		parameters: Type.Object({
			category: StringEnum(["accomplished", "decision"] as const, {
				description: "Whether this is an accomplishment or a decision",
			}),
			text: Type.String({
				description:
					"The note content. Be concise - one line describing what was done or decided.",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!fs.existsSync(vaultResolved)) {
				throw new Error(
					`Obsidian vault not found at ${vaultResolved}. Configure vaultPath in ${CONFIG_PATH}`,
				);
			}

			const projectCtx = getProjectContext(ctx.cwd, config);
			const entry: NoteEntry = {
				accomplished: params.category === "accomplished" ? [params.text] : [],
				decisions: params.category === "decision" ? [params.text] : [],
			};

			appendToDaily(config, projectCtx, entry);

			const notePath = getDailyNotePath(config);
			return {
				content: [
					{
						type: "text",
						text: `Noted in ${path.basename(notePath)} under "${projectCtx.projectName}": ${params.text}`,
					},
				],
				details: {
					category: params.category,
					text: params.text,
					project: projectCtx.projectName,
					branch: projectCtx.branch,
					jiraTicket: projectCtx.jiraTicket,
					notePath,
				},
			};
		},
	});

	// ─── /note command ─────────────────────────────────────────────────────

	pi.registerCommand("note", {
		description: "Add a manual note to today's daily note (usage: /note <text>)",
		handler: async (args, ctx) => {
			if (!fs.existsSync(vaultResolved)) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Vault not found: ${vaultResolved}. Configure ${CONFIG_PATH}`,
						"error",
					);
				}
				return;
			}

			let noteText = args?.trim();

			if (!noteText && ctx.hasUI) {
				noteText = await ctx.ui.input("Note", "What would you like to note?");
			}

			if (!noteText) {
				if (ctx.hasUI) ctx.ui.notify("No note text provided", "warning");
				return;
			}

			// Determine category from prefix or default to accomplished
			let category: "accomplished" | "decision" = "accomplished";
			if (noteText.startsWith("decision:") || noteText.startsWith("d:")) {
				category = "decision";
				noteText = noteText.replace(/^(decision|d):/, "").trim();
			}

			const projectCtx = getProjectContext(ctx.cwd, config);
			const entry: NoteEntry = {
				accomplished: category === "accomplished" ? [noteText] : [],
				decisions: category === "decision" ? [noteText] : [],
			};

			appendToDaily(config, projectCtx, entry);

			if (ctx.hasUI) {
				const icon = category === "decision" ? "🔑" : "✅";
				ctx.ui.notify(
					`${icon} Noted under ${projectCtx.projectName}: ${noteText}`,
					"info",
				);
			}
		},
	});

	// ─── System prompt injection ───────────────────────────────────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!fs.existsSync(vaultResolved)) return;

		return {
			message: {
				customType: "obsidian-daily-notes-context",
				content: [
					"You have access to the obsidian_note tool for recording important work.",
					"When you make a significant architectural decision or complete a major task,",
					"use obsidian_note to record it. Don't over-use it - only for genuinely",
					"noteworthy accomplishments and decisions.",
				].join(" "),
				display: false,
			},
		};
	});
}
