import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

type TodoStatus = "todo" | "doing" | "done";

interface TodoItem {
	id: number;
	text: string;
	status: TodoStatus;
}

interface TodoState {
	title: string;
	items: TodoItem[];
	nextId: number;
	pinned: boolean;
}

interface TodoDetails extends TodoState {
	action: "list" | "replace" | "add" | "set_status" | "clear" | "show" | "hide";
	error?: string;
}

const DEFAULT_TITLE = "Plan";

const TodoParams = Type.Object({
	action: StringEnum(["list", "replace", "add", "set_status", "clear", "show", "hide"] as const),
	title: Type.Optional(Type.String({ description: "Optional widget title (useful with replace)" })),
	items: Type.Optional(
		Type.Array(Type.String({ description: "Todo item text for replace" }), {
			description: "Full replacement list of todo texts",
		}),
	),
	text: Type.Optional(Type.String({ description: "Todo text for add" })),
	id: Type.Optional(Type.Number({ description: "Todo item ID for set_status" })),
	status: Type.Optional(
		StringEnum(["todo", "doing", "done"] as const, { description: "New status for set_status" }),
	),
});

export default function todoWidgetExtension(pi: ExtensionAPI) {
	let state: TodoState = {
		title: DEFAULT_TITLE,
		items: [],
		nextId: 1,
		pinned: false,
	};

	const snapshot = (): TodoState => ({
		title: state.title,
		items: state.items.map((item) => ({ ...item })),
		nextId: state.nextId,
		pinned: state.pinned,
	});

	const setState = (next: TodoState) => {
		state = {
			title: next.title,
			items: next.items.map((item) => ({ ...item })),
			nextId: next.nextId,
			pinned: next.pinned,
		};
	};

	const progressText = () => {
		const done = state.items.filter((item) => item.status === "done").length;
		return `${done}/${state.items.length}`;
	};

	const isComplete = () => state.items.length > 0 && state.items.every((item) => item.status === "done");

	const buildCompletionSummary = () => {
		const lines = [
			`Completed ${state.title}:`,
			...state.items.map((item) => `- [x] ${item.text}`),
		];
		return lines.join("\n");
	};

	const updateWidget = (ctx: ExtensionContext) => {
		if (!state.pinned || state.items.length === 0) {
			ctx.ui.setWidget("todo-widget", undefined);
			ctx.ui.setStatus("todo-widget", undefined);
			return;
		}

		ctx.ui.setStatus("todo-widget", ctx.ui.theme.fg("accent", `📋 ${progressText()}`));
		ctx.ui.setWidget("todo-widget", (_tui, theme) => {
			const lines = [
				theme.fg("accent", theme.bold(`📋 ${state.title}`)) + theme.fg("dim", `  ${progressText()} complete`),
				...state.items.map((item) => {
					const marker =
						item.status === "done"
							? theme.fg("success", "☑")
							: item.status === "doing"
								? theme.fg("warning", "◐")
								: theme.fg("muted", "☐");
					const text =
						item.status === "done"
							? theme.fg("muted", theme.strikethrough(item.text))
							: item.status === "doing"
								? theme.fg("warning", item.text)
								: theme.fg("text", item.text);
					return `${marker} ${theme.fg("dim", `#${item.id}`)} ${text}`;
				}),
			];

			return {
				render: () => lines,
				invalidate: () => {},
			};
		});
	};

	const reconstructState = (ctx: ExtensionContext) => {
		setState({
			title: DEFAULT_TITLE,
			items: [],
			nextId: 1,
			pinned: false,
		});

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "plan_todo") continue;

			const details = msg.details as TodoDetails | undefined;
			if (details) {
				setState({
					title: details.title,
					items: details.items,
					nextId: details.nextId,
					pinned: details.pinned,
				});
			}
		}

		updateWidget(ctx);
	};

	const getListText = () =>
		state.items.length === 0
			? "No todo items"
			: state.items
					.map((item) => {
						const marker = item.status === "done" ? "[x]" : item.status === "doing" ? "[~]" : "[ ]";
						return `${marker} #${item.id} ${item.text}`;
					})
					.join("\n");

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setWidget("todo-widget", undefined);
		ctx.ui.setStatus("todo-widget", undefined);
	});

	pi.on("before_agent_start", async (event) => {
		const prompt = event.prompt.trim().toLowerCase();
		const looksMultiStep =
			prompt.includes("plan") ||
			prompt.includes("steps") ||
			prompt.includes("todo") ||
			prompt.includes("checklist") ||
			prompt.includes("implement") ||
			prompt.includes("refactor") ||
			prompt.includes("build") ||
			prompt.includes("fix");

		if (!looksMultiStep) return;

		return {
			message: {
				customType: "plan-todo-guidance",
				content: `If this task is multi-step, use the plan_todo tool to keep a visible checklist for the user.\n\nSuggested workflow:\n1. Early in the task, call plan_todo with action=replace to create a concise checklist and pin it.\n2. When you start a step, call plan_todo with action=set_status and status=doing.\n3. When you finish a step, call plan_todo with action=set_status and status=done.\n4. If scope changes, call action=replace to refresh the checklist.\n5. Call action=clear only when the work is truly complete or the checklist is obsolete.`,
				display: false,
			},
		};
	});

	pi.registerTool({
		name: "plan_todo",
		label: "Plan Todo",
		description: "Manage a visible todo checklist widget for multi-step work",
		promptSnippet: "Create and update a visible todo checklist for multi-step tasks",
		promptGuidelines: [
			"When a task has multiple steps, create a concise checklist with plan_todo early in the task.",
			"Update plan_todo item statuses as work progresses so the user can track the plan.",
		],
		parameters: TodoParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "list": {
					updateWidget(ctx);
					return {
						content: [{ type: "text", text: getListText() }],
						details: { action: "list", ...snapshot() } as TodoDetails,
					};
				}

				case "replace": {
					const items = (params.items ?? []).map((text) => text.trim()).filter(Boolean);
					setState({
						title: params.title?.trim() || state.title || DEFAULT_TITLE,
						items: items.map((text, index) => ({ id: index + 1, text, status: "todo" as const })),
						nextId: items.length + 1,
						pinned: items.length > 0,
					});
					updateWidget(ctx);
					return {
						content: [{ type: "text", text: items.length > 0 ? `Created ${items.length} todo item(s)` : "Cleared todo list" }],
						details: { action: "replace", ...snapshot() } as TodoDetails,
					};
				}

				case "add": {
					const text = params.text?.trim();
					if (!text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: { action: "add", error: "text required", ...snapshot() } as TodoDetails,
						};
					}
					state.items.push({ id: state.nextId++, text, status: "todo" });
					state.pinned = true;
					if (params.title?.trim()) state.title = params.title.trim();
					updateWidget(ctx);
					return {
						content: [{ type: "text", text: `Added todo #${state.items[state.items.length - 1]!.id}: ${text}` }],
						details: { action: "add", ...snapshot() } as TodoDetails,
					};
				}

				case "set_status": {
					if (params.id === undefined || !params.status) {
						return {
							content: [{ type: "text", text: "Error: id and status required for set_status" }],
							details: {
								action: "set_status",
								error: "id and status required",
								...snapshot(),
							} as TodoDetails,
						};
					}
					const item = state.items.find((entry) => entry.id === params.id);
					if (!item) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "set_status",
								error: `#${params.id} not found`,
								...snapshot(),
							} as TodoDetails,
						};
					}
					const wasComplete = isComplete();
					item.status = params.status;
					state.pinned = true;

					if (!wasComplete && isComplete()) {
						state.pinned = false;
						pi.sendMessage(
							{
								customType: "plan-todo-complete",
								content: buildCompletionSummary(),
								display: true,
							},
							{ triggerTurn: false },
						);
						updateWidget(ctx);
						return {
							content: [{ type: "text", text: `Todo #${item.id} marked done; checklist completed and hidden` }],
							details: { action: "set_status", ...snapshot() } as TodoDetails,
						};
					}

					updateWidget(ctx);
					return {
						content: [{ type: "text", text: `Todo #${item.id} marked ${item.status}` }],
						details: { action: "set_status", ...snapshot() } as TodoDetails,
					};
				}

				case "show": {
					state.pinned = state.items.length > 0;
					if (params.title?.trim()) state.title = params.title.trim();
					updateWidget(ctx);
					return {
						content: [{ type: "text", text: state.items.length > 0 ? "Pinned todo widget" : "No todos to show" }],
						details: { action: "show", ...snapshot() } as TodoDetails,
					};
				}

				case "hide": {
					state.pinned = false;
					updateWidget(ctx);
					return {
						content: [{ type: "text", text: "Hid todo widget" }],
						details: { action: "hide", ...snapshot() } as TodoDetails,
					};
				}

				case "clear": {
					setState({ title: params.title?.trim() || state.title || DEFAULT_TITLE, items: [], nextId: 1, pinned: false });
					updateWidget(ctx);
					return {
						content: [{ type: "text", text: "Cleared todo list" }],
						details: { action: "clear", ...snapshot() } as TodoDetails,
					};
				}
			}
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("plan_todo ")) + theme.fg("muted", args.action);
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.status) text += ` ${theme.fg("warning", args.status)}`;
			if (args.text) text += ` ${theme.fg("dim", `\"${args.text}\"`)}`;
			if (Array.isArray(args.items)) text += ` ${theme.fg("dim", `(${args.items.length} items)`)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0];
			const details = result.details as TodoDetails | undefined;
			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}
			return new Text(theme.fg("muted", text?.type === "text" ? text.text : "Updated todo list"), 0, 0);
		},
	});

	pi.registerCommand("todo-widget", {
		description: "Manage the pinned todo widget: list, show, hide, or clear",
		handler: async (args, ctx) => {
			const action = (args || "list").trim().toLowerCase();
			switch (action) {
				case "list":
					pi.sendMessage({
						customType: "todo-widget-list",
						content: `${state.title}:\n${getListText()}`,
						display: true,
					});
					return;
				case "show":
					state.pinned = state.items.length > 0;
					updateWidget(ctx);
					ctx.ui.notify(state.items.length > 0 ? "Todo widget shown" : "No todos to show", "info");
					return;
				case "hide":
					state.pinned = false;
					updateWidget(ctx);
					ctx.ui.notify("Todo widget hidden", "info");
					return;
				case "clear":
					setState({ title: state.title, items: [], nextId: 1, pinned: false });
					updateWidget(ctx);
					ctx.ui.notify("Todo widget cleared", "info");
					return;
				default:
					ctx.ui.notify("Usage: /todo-widget [list|show|hide|clear]", "warning");
			}
		},
	});
}
