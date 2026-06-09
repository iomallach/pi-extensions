import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

type TaskStatus = "todo" | "doing" | "done";
type Priority = "low" | "medium" | "high";
type TrackerAction =
	| "list"
	| "replace"
	| "add_task"
	| "add_subtask"
	| "set_active"
	| "set_status"
	| "complete_current"
	| "show"
	| "hide"
	| "clear";

interface SubtaskItem {
	id: number;
	text: string;
	status: TaskStatus;
	priority: Priority;
}

interface TaskItem {
	id: number;
	text: string;
	status: TaskStatus;
	priority: Priority;
	subtasks: SubtaskItem[];
}

interface TrackerState {
	title: string;
	tasks: TaskItem[];
	nextTaskId: number;
	nextSubtaskId: number;
	activeTaskId?: number;
	activeSubtaskId?: number;
	pinned: boolean;
}

interface TrackerDetails extends TrackerState {
	action: TrackerAction;
	error?: string;
	warning?: string;
}

interface TrackerTaskInput {
	text: string;
	priority?: Priority;
	subtasks?: TrackerSubtaskInput[];
}

interface TrackerSubtaskInput {
	text: string;
	priority?: Priority;
}

interface TrackerToolParams {
	action: TrackerAction;
	title?: string;
	tasks?: TrackerTaskInput[];
	text?: string;
	priority?: Priority;
	taskId?: number;
	subtaskId?: number;
	status?: TaskStatus;
}

const TRACKER_TOOL = "track_tasks";
const TRACKER_WIDGET = "task-tracker";
const TRACKER_STATUS = "task-tracker";
const DEFAULT_TITLE = "Task Tracker";
const DEFAULT_PRIORITY: Priority = "medium";
const NUDGE_MULTI_STEP_NO_PLAN = "multi-step-no-plan";
const NUDGE_NO_ACTIVE = "tracker-no-active";
const NUDGE_STALLED = "tracker-stalled";

const statusEnum = ["todo", "doing", "done"] as const;
const priorityEnum = ["low", "medium", "high"] as const;
const actionEnum = [
	"list",
	"replace",
	"add_task",
	"add_subtask",
	"set_active",
	"set_status",
	"complete_current",
	"show",
	"hide",
	"clear",
] as const;

const actionSchema = Type.Union(actionEnum.map((value) => Type.Literal(value)));
const prioritySchema = Type.Union(priorityEnum.map((value) => Type.Literal(value)));
const statusSchema = Type.Union(statusEnum.map((value) => Type.Literal(value)));

const TrackerParams = Type.Object({
	action: actionSchema,
	title: Type.Optional(Type.String({ description: "Optional tracker title" })),
	tasks: Type.Optional(
		Type.Array(
			Type.Object({
				text: Type.String({ description: "Task text" }),
				priority: Type.Optional(prioritySchema),
				subtasks: Type.Optional(
					Type.Array(
						Type.Object({
							text: Type.String({ description: "Subtask text" }),
							priority: Type.Optional(prioritySchema),
						}),
						{ description: "Subtasks for this task" },
					),
				),
			}),
			{ description: "Full replacement list of tasks" },
		),
	),
	text: Type.Optional(Type.String({ description: "Task or subtask text for add actions" })),
	priority: Type.Optional(prioritySchema),
	taskId: Type.Optional(Type.Number({ description: "Task ID" })),
	subtaskId: Type.Optional(Type.Number({ description: "Subtask ID" })),
	status: Type.Optional(statusSchema),
});

function cloneTask(task: TaskItem): TaskItem {
	return {
		...task,
		subtasks: task.subtasks.map((subtask) => ({ ...subtask })),
	};
}

function totalSteps(state: TrackerState): number {
	return state.tasks.reduce((count, task) => count + 1 + task.subtasks.length, 0);
}

function completedSteps(state: TrackerState): number {
	return state.tasks.reduce((count, task) => {
		const taskDone = task.status === "done" ? 1 : 0;
		const subtaskDone = task.subtasks.filter((subtask) => subtask.status === "done").length;
		return count + taskDone + subtaskDone;
	}, 0);
}

function getTaskById(state: TrackerState, taskId?: number): TaskItem | undefined {
	return state.tasks.find((task) => task.id === taskId);
}

function getSubtaskById(task: TaskItem | undefined, subtaskId?: number): SubtaskItem | undefined {
	return task?.subtasks.find((subtask) => subtask.id === subtaskId);
}

function stepCountForPlanTasks(tasks: TaskItem[]): number {
	return tasks.reduce((count, task) => count + 1 + task.subtasks.length, 0);
}

function normalizeText(text: string | undefined): string | undefined {
	const value = text?.trim();
	return value ? value : undefined;
}

function priorityBadge(priority: Priority): string {
	return priority === "high" ? "!!!" : priority === "medium" ? "!!" : "!";
}

function priorityLabel(priority: Priority): string {
	return priority === "high" ? "high" : priority === "medium" ? "med" : "low";
}

function statusMarker(status: TaskStatus): string {
	return status === "done" ? "[x]" : status === "doing" ? "[~]" : "[ ]";
}

function listLines(state: TrackerState): string[] {
	if (state.tasks.length === 0) return ["No tracked tasks"];
	return state.tasks.flatMap((task) => {
		const taskLine = `${statusMarker(task.status)} #${task.id} ${task.text} (${priorityLabel(task.priority)})`;
		const subtaskLines = task.subtasks.map(
			(subtask) => `  ${statusMarker(subtask.status)} #${task.id}.${subtask.id} ${subtask.text} (${priorityLabel(subtask.priority)})`,
		);
		return [taskLine, ...subtaskLines];
	});
}

function summarizeFocus(state: TrackerState): string | undefined {
	const task = getTaskById(state, state.activeTaskId);
	if (!task) return undefined;
	const subtask = getSubtaskById(task, state.activeSubtaskId);
	return subtask ? `#${task.id}.${subtask.id} ${subtask.text}` : `#${task.id} ${task.text}`;
}

function syncTaskStatus(task: TaskItem) {
	if (task.subtasks.length === 0) return;
	if (task.subtasks.every((subtask) => subtask.status === "done")) {
		task.status = "done";
		return;
	}
	if (task.subtasks.some((subtask) => subtask.status === "doing" || subtask.status === "done")) {
		task.status = "doing";
		return;
	}
	task.status = "todo";
}

function isComplete(state: TrackerState): boolean {
	return totalSteps(state) > 0 && completedSteps(state) === totalSteps(state);
}

function firstUnfinished(state: TrackerState): { taskId: number; subtaskId?: number } | undefined {
	for (const task of state.tasks) {
		if (task.subtasks.length > 0) {
			const subtask = task.subtasks.find((entry) => entry.status !== "done");
			if (subtask) return { taskId: task.id, subtaskId: subtask.id };
			continue;
		}
		if (task.status !== "done") return { taskId: task.id };
	}
	return undefined;
}

function snapshot(state: TrackerState): TrackerState {
	return {
		title: state.title,
		tasks: state.tasks.map(cloneTask),
		nextTaskId: state.nextTaskId,
		nextSubtaskId: state.nextSubtaskId,
		activeTaskId: state.activeTaskId,
		activeSubtaskId: state.activeSubtaskId,
		pinned: state.pinned,
	};
}

function makeState(): TrackerState {
	return {
		title: DEFAULT_TITLE,
		tasks: [],
		nextTaskId: 1,
		nextSubtaskId: 1,
		pinned: false,
	};
}

function looksMultiStep(prompt: string): boolean {
	const normalized = prompt.trim().toLowerCase();
	if (!normalized) return false;
	const keywordHits = ["plan", "steps", "implement", "build", "refactor", "migrate", "create", "fix", "add", "extension"]
		.filter((token) => normalized.includes(token)).length;
	const delimiterHits = [" and ", " then ", " after ", " also ", " plus ", ";"].filter((token) => normalized.includes(token)).length;
	return keywordHits >= 2 || delimiterHits >= 2 || normalized.split(/\s+/).length > 18;
}

function buildCompletionSummary(state: TrackerState): string {
	const focus = state.tasks
		.map((task) => {
			if (task.subtasks.length === 0) return `- ${task.text}`;
			return `- ${task.text}: ${task.subtasks.map((subtask) => subtask.text).join(", ")}`;
		})
		.join("\n");
	return `Completed ${state.title} (${completedSteps(state)}/${totalSteps(state)} steps).\n${focus}`;
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text?: string } => !!block && typeof block === "object" && "type" in block)
		.map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
		.join("\n");
}

export default function taskTrackerExtension(pi: ExtensionAPI) {
	let state = makeState();
	const emittedNudges = new Set<string>();

	const setState = (next: TrackerState) => {
		state = snapshot(next);
	};

	const clearActiveIfMissing = () => {
		const task = getTaskById(state, state.activeTaskId);
		if (!task) {
			state.activeTaskId = undefined;
			state.activeSubtaskId = undefined;
			return;
		}
		if (state.activeSubtaskId !== undefined && !getSubtaskById(task, state.activeSubtaskId)) {
			state.activeSubtaskId = undefined;
		}
	};

	const setActive = (taskId?: number, subtaskId?: number) => {
		state.activeTaskId = taskId;
		state.activeSubtaskId = subtaskId;
		clearActiveIfMissing();
	};

	const ensureActive = () => {
		clearActiveIfMissing();
		if (state.activeTaskId !== undefined) return;
		const next = firstUnfinished(state);
		if (next) setActive(next.taskId, next.subtaskId);
	};

	const clearActiveIfCompleted = () => {
		const task = getTaskById(state, state.activeTaskId);
		if (!task) {
			setActive(undefined, undefined);
			return;
		}
		if (state.activeSubtaskId !== undefined) {
			const subtask = getSubtaskById(task, state.activeSubtaskId);
			if (!subtask || subtask.status === "done") {
				setActive(undefined, undefined);
			}
			return;
		}
		if (task.status === "done") {
			setActive(undefined, undefined);
		}
	};

	const warn = (key: string, message: string) => {
		if (emittedNudges.has(key)) return;
		emittedNudges.add(key);
		pi.sendMessage({ customType: `task-tracker-${key}`, content: message, display: true }, { triggerTurn: false });
	};

	const progressText = () => `${completedSteps(state)}/${totalSteps(state)}`;

	const updateUi = (ctx: ExtensionContext) => {
		if (!state.pinned || state.tasks.length === 0) {
			ctx.ui.setWidget(TRACKER_WIDGET, undefined);
			ctx.ui.setStatus(TRACKER_STATUS, undefined);
			return;
		}

		const task = getTaskById(state, state.activeTaskId);
		const subtask = getSubtaskById(task, state.activeSubtaskId);
		const focus = summarizeFocus(state);
		ctx.ui.setStatus(TRACKER_STATUS, focus ? `🎯 ${progressText()} · ${focus}` : `🎯 ${progressText()} tracked`);
		ctx.ui.setWidget(TRACKER_WIDGET, (_tui, theme) => {
			const lines: string[] = [];
			lines.push(`${theme.fg("accent", theme.bold(`🎯 ${state.title}`))} ${theme.fg("dim", `${progressText()} steps`)}`);
			if (task) {
				lines.push("");
				lines.push(theme.bold("Current focus"));
				lines.push(`${theme.fg("warning", "→")} ${theme.fg("accent", `#${task.id}`)} ${task.text} ${theme.fg("dim", `[${priorityLabel(task.priority)}]`)}`);
				if (subtask) {
					lines.push(`  ${theme.fg("warning", "↳")} ${theme.fg("accent", `#${task.id}.${subtask.id}`)} ${theme.fg("warning", subtask.text)} ${theme.fg("dim", `[${priorityLabel(subtask.priority)}]`)}`);
				}
			}

			const nextItems = state.tasks.flatMap((entry) => {
				if (entry.id === task?.id && subtask) {
					return entry.subtasks
						.filter((candidate) => candidate.id !== subtask.id && candidate.status !== "done")
						.slice(0, 2)
						.map((candidate) => `  • #${entry.id}.${candidate.id} ${candidate.text}`);
				}
				if (entry.id !== task?.id && entry.status !== "done") return [`• #${entry.id} ${entry.text}`];
				return [];
			}).slice(0, 3);

			if (nextItems.length > 0) {
				lines.push("");
				lines.push(theme.fg("dim", "Next up"));
				lines.push(...nextItems.map((line) => theme.fg("dim", line)));
			}

			lines.push("");
			lines.push(theme.fg("dim", `Tasks: ${state.tasks.length} · Priority ${task ? priorityBadge(task.priority) : "-"}`));
			return new Text(lines.join("\n"), 0, 0);
		});
	};

	const reconstruct = (ctx: ExtensionContext) => {
		setState(makeState());
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "toolResult" || message.toolName !== TRACKER_TOOL) continue;
			const details = message.details as TrackerDetails | undefined;
			if (!details) continue;
			setState({
				title: details.title,
				tasks: details.tasks,
				nextTaskId: details.nextTaskId,
				nextSubtaskId: details.nextSubtaskId,
				activeTaskId: details.activeTaskId,
				activeSubtaskId: details.activeSubtaskId,
				pinned: details.pinned,
			});
		}
		clearActiveIfMissing();
		updateUi(ctx);
	};

	const listText = () => `${state.title}:\n${listLines(state).join("\n")}`;

	const applyCompletion = (ctx: ExtensionContext, itemLabel: string) => {
		clearActiveIfCompleted();
		if (isComplete(state)) {
			state.pinned = false;
			setActive(undefined, undefined);
			updateUi(ctx);
			pi.sendMessage({ customType: "task-tracker-complete", content: buildCompletionSummary(state), display: true }, { triggerTurn: false });
			return `Completed ${itemLabel}; tracker complete and hidden`;
		}
		ensureActive();
		updateUi(ctx);
		return `Completed ${itemLabel}`;
	};

	const replaceFromPlan = (params: { title?: string; tasks?: Array<{ text: string; priority?: Priority; subtasks?: Array<{ text: string; priority?: Priority }> }> }) => {
		const nextTasks: TaskItem[] = [];
		let nextTaskId = 1;
		let nextSubtaskId = 1;
		for (const rawTask of params.tasks ?? []) {
			const text = normalizeText(rawTask.text);
			if (!text) continue;
			const task: TaskItem = {
				id: nextTaskId++,
				text,
				status: "todo",
				priority: rawTask.priority ?? DEFAULT_PRIORITY,
				subtasks: [],
			};
			for (const rawSubtask of rawTask.subtasks ?? []) {
				const subtaskText = normalizeText(rawSubtask.text);
				if (!subtaskText) continue;
				task.subtasks.push({
					id: nextSubtaskId++,
					text: subtaskText,
					status: "todo",
					priority: rawSubtask.priority ?? task.priority,
				});
			}
			syncTaskStatus(task);
			nextTasks.push(task);
		}
		return {
			title: normalizeText(params.title) ?? state.title ?? DEFAULT_TITLE,
			tasks: nextTasks,
			nextTaskId,
			nextSubtaskId,
			activeTaskId: undefined,
			activeSubtaskId: undefined,
			pinned: nextTasks.length > 0,
		} satisfies TrackerState;
	};

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setWidget(TRACKER_WIDGET, undefined);
		ctx.ui.setStatus(TRACKER_STATUS, undefined);
	});

	pi.on("before_agent_start", async (event) => {
		if (!looksMultiStep(event.prompt)) return;
		const base = [
			"For work with more than 2 steps, use the track_tasks tool early.",
			"Create the plan with action=replace, include tasks and subtasks, and set an active item as you work.",
			"Keep the current focus updated with set_active, set_status, or complete_current.",
			"If the work is 2 steps or fewer, skip the tracker.",
		].join(" ");
		return {
			message: {
				customType: "task-tracker-guidance",
				content: base,
				display: false,
			},
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		const branch = [...ctx.sessionManager.getBranch()].reverse();
		const latestUserMessage = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
		const text = latestUserMessage && latestUserMessage.type === "message"
			? extractMessageText((latestUserMessage.message as { content?: unknown }).content)
			: "";
		if (looksMultiStep(text) && state.tasks.length === 0) {
			warn(NUDGE_MULTI_STEP_NO_PLAN, "This looked like multi-step work. Next turn, create a task tracker plan if the job really has more than 2 steps.");
		}
		if (state.tasks.length > 0 && state.activeTaskId === undefined) {
			warn(NUDGE_NO_ACTIVE, "Task tracker has a plan but no active focus. Set the current task or subtask so the widget stays informative.");
		}
		if (state.tasks.length > 0 && completedSteps(state) === 0) {
			warn(NUDGE_STALLED, "Task tracker exists but everything is still todo. Mark the current item doing/done as work progresses.");
		}
		updateUi(ctx);
	});

	pi.registerTool({
		name: TRACKER_TOOL,
		label: "Track Tasks",
		description: "Manage a session-persistent task tracker with tasks, subtasks, focus, and status updates",
		promptSnippet: "Create and update a tracked task plan for multi-step work",
		promptGuidelines: [
			"Only create a tracker when the work has more than 2 steps.",
			"After creating a plan, keep one current task or subtask active so the user sees current focus.",
			"Use complete_current for the common flow of finishing the active item and moving to the next one.",
		],
		parameters: TrackerParams,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as TrackerToolParams;
			let warning: string | undefined;
			switch (params.action) {
				case "list": {
					updateUi(ctx);
					return {
						content: [{ type: "text", text: listText() }],
						details: { action: "list", ...snapshot(state) } as TrackerDetails,
					};
				}
				case "replace": {
					const next = replaceFromPlan(params);
					if (stepCountForPlanTasks(next.tasks) <= 2) {
						warning = "Tracker not created: only activate tracking when the work has more than 2 total steps.";
						updateUi(ctx);
						return {
							content: [{ type: "text", text: warning }],
							details: { action: "replace", warning, ...snapshot(state) } as TrackerDetails,
						};
					}
					setState(next);
					ensureActive();
					state.pinned = true;
					updateUi(ctx);
					pi.sendMessage({ customType: "task-tracker-created", content: `Tracking ${state.title} with ${totalSteps(state)} steps.`, display: true }, { triggerTurn: false });
					return {
						content: [{ type: "text", text: `Created tracker with ${state.tasks.length} task(s)` }],
						details: { action: "replace", ...snapshot(state) } as TrackerDetails,
					};
				}
				case "add_task": {
					const text = normalizeText(params.text);
					if (!text) {
						return {
							content: [{ type: "text", text: "Error: text required for add_task" }],
							details: { action: "add_task", error: "text required", ...snapshot(state) } as TrackerDetails,
						};
					}
					state.tasks.push({
						id: state.nextTaskId++,
						text,
						status: "todo",
						priority: params.priority ?? DEFAULT_PRIORITY,
						subtasks: [],
					});
					state.pinned = totalSteps(state) > 2;
					ensureActive();
					updateUi(ctx);
					return {
						content: [{ type: "text", text: `Added task #${state.tasks[state.tasks.length - 1]!.id}` }],
						details: { action: "add_task", ...snapshot(state) } as TrackerDetails,
					};
				}
				case "add_subtask": {
					const text = normalizeText(params.text);
					const task = getTaskById(state, params.taskId);
					if (!text || !task) {
						return {
							content: [{ type: "text", text: "Error: taskId and text required for add_subtask" }],
							details: { action: "add_subtask", error: "taskId and text required", ...snapshot(state) } as TrackerDetails,
						};
					}
					task.subtasks.push({
						id: state.nextSubtaskId++,
						text,
						status: "todo",
						priority: params.priority ?? task.priority,
					});
					syncTaskStatus(task);
					state.pinned = totalSteps(state) > 2;
					ensureActive();
					updateUi(ctx);
					return {
						content: [{ type: "text", text: `Added subtask #${task.id}.${task.subtasks[task.subtasks.length - 1]!.id}` }],
						details: { action: "add_subtask", ...snapshot(state) } as TrackerDetails,
					};
				}
				case "set_active": {
					const task = getTaskById(state, params.taskId);
					if (!task) {
						return {
							content: [{ type: "text", text: "Error: valid taskId required for set_active" }],
							details: { action: "set_active", error: "valid taskId required", ...snapshot(state) } as TrackerDetails,
						};
					}
					if (params.subtaskId !== undefined && !getSubtaskById(task, params.subtaskId)) {
						return {
							content: [{ type: "text", text: "Error: subtask not found" }],
							details: { action: "set_active", error: "subtask not found", ...snapshot(state) } as TrackerDetails,
						};
					}
					setActive(task.id, params.subtaskId);
					if (params.subtaskId === undefined && task.status === "todo") task.status = "doing";
					const subtask = getSubtaskById(task, params.subtaskId);
					if (subtask && subtask.status === "todo") {
						subtask.status = "doing";
						syncTaskStatus(task);
					}
					state.pinned = true;
					updateUi(ctx);
					return {
						content: [{ type: "text", text: `Set active ${params.subtaskId !== undefined ? `#${task.id}.${params.subtaskId}` : `#${task.id}`}` }],
						details: { action: "set_active", ...snapshot(state) } as TrackerDetails,
					};
				}
				case "set_status": {
					if (!params.status || params.taskId === undefined) {
						return {
							content: [{ type: "text", text: "Error: taskId and status required for set_status" }],
							details: { action: "set_status", error: "taskId and status required", ...snapshot(state) } as TrackerDetails,
						};
					}
					const task = getTaskById(state, params.taskId);
					if (!task) {
						return {
							content: [{ type: "text", text: "Error: task not found" }],
							details: { action: "set_status", error: "task not found", ...snapshot(state) } as TrackerDetails,
						};
					}
					if (params.subtaskId !== undefined) {
						const subtask = getSubtaskById(task, params.subtaskId);
						if (!subtask) {
							return {
								content: [{ type: "text", text: "Error: subtask not found" }],
								details: { action: "set_status", error: "subtask not found", ...snapshot(state) } as TrackerDetails,
							};
						}
						subtask.status = params.status;
						if (params.status === "doing") setActive(task.id, subtask.id);
						syncTaskStatus(task);
						const result = params.status === "done" ? applyCompletion(ctx, `#${task.id}.${subtask.id}`) : `Marked #${task.id}.${subtask.id} ${params.status}`;
						return {
							content: [{ type: "text", text: result }],
							details: { action: "set_status", ...snapshot(state) } as TrackerDetails,
						};
					}
					if (task.subtasks.length > 0 && params.status === "done" && task.subtasks.some((entry) => entry.status !== "done")) {
						warning = `Cannot mark #${task.id} done while subtasks are unfinished; finish or update the subtasks first.`;
						warn(`unfinished-subtasks-${task.id}`, warning);
						updateUi(ctx);
						return {
							content: [{ type: "text", text: warning }],
							details: { action: "set_status", warning, ...snapshot(state) } as TrackerDetails,
						};
					}
					task.status = params.status;
					if (params.status === "doing") setActive(task.id, undefined);
					const result = params.status === "done" ? applyCompletion(ctx, `#${task.id}`) : `Marked #${task.id} ${params.status}`;
					return {
						content: [{ type: "text", text: result }],
						details: { action: "set_status", ...snapshot(state) } as TrackerDetails,
					};
				}
				case "complete_current": {
					ensureActive();
					const task = getTaskById(state, state.activeTaskId);
					if (!task) {
						warning = "No active task is set. Use set_active first.";
						warn("complete-without-active", warning);
						updateUi(ctx);
						return {
							content: [{ type: "text", text: warning }],
							details: { action: "complete_current", warning, ...snapshot(state) } as TrackerDetails,
						};
					}
					const subtask = getSubtaskById(task, state.activeSubtaskId);
					if (subtask) {
						subtask.status = "done";
						syncTaskStatus(task);
						return {
							content: [{ type: "text", text: applyCompletion(ctx, `#${task.id}.${subtask.id}`) }],
							details: { action: "complete_current", ...snapshot(state) } as TrackerDetails,
						};
					}
					if (task.subtasks.some((entry) => entry.status !== "done")) {
						const nextSubtask = task.subtasks.find((entry) => entry.status !== "done");
						setActive(task.id, nextSubtask?.id);
						if (nextSubtask && nextSubtask.status === "todo") nextSubtask.status = "doing";
						syncTaskStatus(task);
						warning = `Task #${task.id} has unfinished subtasks, so focus moved to #${task.id}.${nextSubtask?.id}.`;
						warn(`task-has-subtasks-${task.id}`, warning);
						updateUi(ctx);
						return {
							content: [{ type: "text", text: warning }],
							details: { action: "complete_current", warning, ...snapshot(state) } as TrackerDetails,
						};
					}
					task.status = "done";
					return {
						content: [{ type: "text", text: applyCompletion(ctx, `#${task.id}`) }],
						details: { action: "complete_current", ...snapshot(state) } as TrackerDetails,
					};
				}
				case "show": {
					state.pinned = state.tasks.length > 0;
					if (params.title?.trim()) state.title = params.title.trim();
					updateUi(ctx);
					return {
						content: [{ type: "text", text: state.tasks.length > 0 ? "Task tracker shown" : "No tracked tasks to show" }],
						details: { action: "show", ...snapshot(state) } as TrackerDetails,
					};
				}
				case "hide": {
					state.pinned = false;
					updateUi(ctx);
					return {
						content: [{ type: "text", text: "Task tracker hidden" }],
						details: { action: "hide", ...snapshot(state) } as TrackerDetails,
					};
				}
				case "clear": {
					setState(makeState());
					updateUi(ctx);
					pi.sendMessage({ customType: "task-tracker-cleared", content: "Cleared task tracker.", display: true }, { triggerTurn: false });
					return {
						content: [{ type: "text", text: "Cleared task tracker" }],
						details: { action: "clear", ...snapshot(state) } as TrackerDetails,
					};
				}
			}
			return {
				content: [{ type: "text", text: "Unsupported action" }],
				details: { action: "list", error: "unsupported action", ...snapshot(state) } as TrackerDetails,
			};
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold(`${TRACKER_TOOL} `)) + theme.fg("muted", args.action);
			if (args.taskId !== undefined) text += ` ${theme.fg("accent", `#${args.taskId}`)}`;
			if (args.subtaskId !== undefined) text += theme.fg("accent", `.${args.subtaskId}`);
			if (args.status) text += ` ${theme.fg("warning", args.status)}`;
			if (args.priority) text += ` ${theme.fg("dim", `[${args.priority}]`)}`;
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (Array.isArray(args.tasks)) text += ` ${theme.fg("dim", `(${args.tasks.length} tasks)`)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as TrackerDetails | undefined;
			const text = result.content[0];
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			if (details?.warning) return new Text(theme.fg("warning", details.warning), 0, 0);
			return new Text(theme.fg("muted", text?.type === "text" ? text.text : "Updated tracker"), 0, 0);
		},
	});

	pi.registerCommand("task-tracker", {
		description: "Inspect or lightly control the task tracker: list, show, hide, clear, done, or focus <taskId[.subtaskId]>",
		handler: async (args, ctx) => {
			const input = (args ?? "list").trim();
			const [action, value] = input.split(/\s+/, 2);
			switch ((action || "list").toLowerCase()) {
				case "list":
					pi.sendMessage({ customType: "task-tracker-list", content: listText(), display: true });
					return;
				case "show":
					state.pinned = state.tasks.length > 0;
					updateUi(ctx);
					ctx.ui.notify(state.tasks.length > 0 ? "Task tracker shown" : "No tracked tasks to show", "info");
					return;
				case "hide":
					state.pinned = false;
					updateUi(ctx);
					ctx.ui.notify("Task tracker hidden", "info");
					return;
				case "clear":
					setState(makeState());
					updateUi(ctx);
					ctx.ui.notify("Task tracker cleared", "info");
					return;
				case "done": {
					ensureActive();
					const task = getTaskById(state, state.activeTaskId);
					if (!task) {
						ctx.ui.notify("No active task to complete", "warning");
						return;
					}
					const subtask = getSubtaskById(task, state.activeSubtaskId);
					if (subtask) {
						subtask.status = "done";
						syncTaskStatus(task);
						ctx.ui.notify(applyCompletion(ctx, `#${task.id}.${subtask.id}`), "info");
						return;
					}
					if (task.subtasks.some((entry) => entry.status !== "done")) {
						ctx.ui.notify(`Task #${task.id} still has unfinished subtasks`, "warning");
						return;
					}
					task.status = "done";
					ctx.ui.notify(applyCompletion(ctx, `#${task.id}`), "info");
					return;
				}
				case "focus": {
					const match = value?.match(/^(\d+)(?:\.(\d+))?$/);
					if (!match) {
						ctx.ui.notify("Usage: /task-tracker focus <taskId[.subtaskId]>", "warning");
						return;
					}
					const taskId = Number(match[1]);
					const subtaskId = match[2] ? Number(match[2]) : undefined;
					const task = getTaskById(state, taskId);
					if (!task) {
						ctx.ui.notify(`Task #${taskId} not found`, "warning");
						return;
					}
					if (subtaskId !== undefined && !getSubtaskById(task, subtaskId)) {
						ctx.ui.notify(`Subtask #${taskId}.${subtaskId} not found`, "warning");
						return;
					}
					setActive(taskId, subtaskId);
					updateUi(ctx);
					ctx.ui.notify(`Focused ${subtaskId !== undefined ? `#${taskId}.${subtaskId}` : `#${taskId}`}`, "info");
					return;
				}
				default:
					ctx.ui.notify("Usage: /task-tracker [list|show|hide|clear|done|focus <taskId[.subtaskId]>]", "warning");
			}
		},
	});
}
