/**
 * Claude Mode Extension
 *
 * Connects pi to Claude Code via ACP. User messages are forwarded to Claude Code
 * and responses stream back into pi's TUI.
 *
 * Commands:
 *   /claudemode           - Toggle Claude Mode on/off
 *   /claudemode disconnect - Explicit disconnect
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Writable, Readable } from "node:stream";
import {
	ClientSideConnection,
	ndJsonStream,
	PROTOCOL_VERSION,
	type SessionUpdate,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
	type ReadTextFileRequest,
	type ReadTextFileResponse,
	type WriteTextFileRequest,
	type WriteTextFileResponse,
	type CreateTerminalRequest,
	type CreateTerminalResponse,
	type TerminalOutputRequest,
	type TerminalOutputResponse,
	type WaitForTerminalExitRequest,
	type WaitForTerminalExitResponse,
	type KillTerminalRequest,
	type KillTerminalResponse,
	type ReleaseTerminalRequest,
	type ReleaseTerminalResponse,
	type ToolCallUpdate,
	type ToolCall,
} from "@agentclientprotocol/sdk";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Box, Markdown, type MarkdownTheme, Text } from "@mariozechner/pi-tui";

// --- Types ---

interface ToolCallContentBlock {
	type: string;
	text?: string;
	// Diff content
	path?: string;
	oldText?: string;
	newText?: string;
}

interface ToolCallState {
	name: string;
	status: string;
	rawInput?: unknown;
	rawOutput?: unknown;
	content?: ToolCallContentBlock[];
	locations?: Array<{ path?: string; uri?: string }>;
}

interface TerminalState {
	proc: ChildProcess;
	output: string;
	exitCode?: number | null;
	signal?: string | null;
}

// --- Message types for pi TUI ---

const MSG_USER = "claudemode-user";
const MSG_RESPONSE = "claudemode-response";
const MSG_TOOL = "claudemode-tool";
const MSG_STATUS = "claudemode-status";
const ENTRY_TYPE = "claudemode-state";
const WIDGET_KEY = "claudemode-stream";

// --- Extension ---

export default function (pi: ExtensionAPI) {
	let active = false;
	let connection: ClientSideConnection | null = null;
	let sessionId: string | null = null;
	let agentProcess: ChildProcess | null = null;
	let prompting = false;
	let currentMode: string | null = null;

	// Accumulated response state during a prompt turn
	let responseText = "";
	let thinkingText = "";
	const toolCalls = new Map<string, ToolCallState>();
	let planTasks: Array<{ title: string; status: string }> | null = null;

	// Terminal management
	let nextTerminalId = 1;
	const terminals = new Map<string, TerminalState>();

	// UI context ref (set during command handler, used in callbacks)
	let uiCtx: ExtensionContext | null = null;

	function resetStreamState() {
		responseText = "";
		thinkingText = "";
		toolCalls.clear();
		planTasks = null;
	}

	function updateFooter() {
		if (!uiCtx) return;
		if (!active) {
			uiCtx.ui.setStatus("claudemode", undefined);
			return;
		}
		let label = "Claude Code";
		if (currentMode && currentMode !== "code") label += ` [${currentMode}]`;
		const dot = prompting ? " ◉" : " ●";
		const color = prompting ? "warning" : "success";
		uiCtx.ui.setStatus("claudemode", uiCtx.ui.theme.fg(color, label + dot));
	}

	function updateStreamWidget() {
		if (!uiCtx) return;
		const lines: string[] = ["◉ Claude responding..."];

		// Show tool call activity
		for (const [, tc] of toolCalls) {
			const icon = tc.status === "completed" ? "✓" : tc.status === "failed" ? "✗" : "◉";
			let line = `  ${icon} ${tc.name}`;
			// Show file path from locations or rawInput
			const path = tc.locations?.[0]?.path ?? extractPath(tc.rawInput);
			if (path) line += ` ${path}`;
			if (tc.status !== "completed" && tc.status !== "failed") line += ` [${tc.status}]`;
			lines.push(line);
		}

		// Show plan tasks
		if (planTasks) {
			lines.push("");
			for (const t of planTasks) {
				const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "◉" : "○";
				lines.push(`  ${icon} ${t.title}`);
			}
		}

		// Show tail of response text
		if (responseText) {
			lines.push("");
			const respLines = responseText.split("\n");
			const visible = respLines.length > 15 ? respLines.slice(-15) : respLines;
			lines.push(...visible);
		}

		uiCtx.ui.setWidget(WIDGET_KEY, lines);
	}

	function extractPath(rawInput: unknown): string | undefined {
		if (!rawInput || typeof rawInput !== "object") return undefined;
		const input = rawInput as Record<string, unknown>;
		if (typeof input.file_path === "string") return input.file_path;
		if (typeof input.path === "string") return input.path;
		if (typeof input.command === "string") return input.command.substring(0, 80);
		return undefined;
	}

	function clearStreamWidget() {
		uiCtx?.ui.setWidget(WIDGET_KEY, undefined);
	}

	// --- ACP Client Callbacks ---

	function handleSessionUpdate(params: SessionNotification): void {
		const update = params.update as SessionUpdate;

		switch (update.sessionUpdate) {
			case "agent_message_chunk": {
				const block = update.content;
				if (block.type === "text") {
					responseText += block.text;
					updateStreamWidget();
				}
				break;
			}

			case "agent_thought_chunk": {
				const block = update.content;
				if (block.type === "text") {
					thinkingText += block.text;
				}
				break;
			}

			case "tool_call": {
				const tc = update as ToolCall & { sessionUpdate: string };
				toolCalls.set(tc.toolCallId, {
					name: tc.title ?? "tool",
					status: tc.status ?? "pending",
					rawInput: tc.rawInput,
					rawOutput: tc.rawOutput,
					content: tc.content as ToolCallContentBlock[] | undefined,
					locations: tc.locations as Array<{ path?: string; uri?: string }> | undefined,
				});
				updateStreamWidget();
				break;
			}

			case "tool_call_update": {
				const tc = update as ToolCallUpdate & { sessionUpdate: string };
				const existing = toolCalls.get(tc.toolCallId);
				if (existing) {
					if (tc.title) existing.name = tc.title;
					if (tc.status) existing.status = tc.status;
					if (tc.rawInput !== undefined) existing.rawInput = tc.rawInput;
					if (tc.rawOutput !== undefined) existing.rawOutput = tc.rawOutput;
					if (tc.content) existing.content = tc.content as ToolCallContentBlock[] | undefined;
					if (tc.locations) existing.locations = tc.locations as Array<{ path?: string; uri?: string }> | undefined;
				}
				updateStreamWidget();
				break;
			}

			case "current_mode_update": {
				const modeUpdate = update as { currentModeId?: string };
				currentMode = modeUpdate.currentModeId ?? null;
				updateFooter();
				break;
			}

			case "plan": {
				const plan = update as { tasks?: Array<{ title: string; status: string }> };
				if (plan.tasks) planTasks = plan.tasks;
				updateStreamWidget();
				break;
			}

			default:
				break;
		}
	}

	/** Format a completed tool call for the final persistent message. */
	function formatToolContent(tc: ToolCallState): string {
		const parts: string[] = [];

		// Show file path
		const path = tc.locations?.[0]?.path ?? extractPath(tc.rawInput);
		if (path) parts.push(path);

		// Show diffs from content
		if (tc.content) {
			for (const block of tc.content) {
				if (block.type === "diff" && block.path) {
					parts.push(`--- ${block.path}`);
					if (block.oldText != null && block.newText != null) {
						parts.push(formatSimpleDiff(block.oldText, block.newText));
					} else if (block.newText != null) {
						parts.push(block.newText.substring(0, 1000));
					}
				} else if (block.type === "content" && block.text) {
					parts.push(block.text.substring(0, 1000));
				}
			}
		}

		// Fall back to rawInput/rawOutput if no structured content
		if (parts.length === 0) {
			if (tc.rawInput) {
				const s = typeof tc.rawInput === "string" ? tc.rawInput : JSON.stringify(tc.rawInput, null, 2);
				parts.push(s.substring(0, 500));
			}
			if (tc.rawOutput) {
				const s = typeof tc.rawOutput === "string" ? tc.rawOutput : JSON.stringify(tc.rawOutput, null, 2);
				parts.push(s.substring(0, 1000));
			}
		}

		return parts.join("\n");
	}

	function formatSimpleDiff(oldText: string, newText: string): string {
		const oldLines = oldText.split("\n");
		const newLines = newText.split("\n");
		const out: string[] = [];
		const maxLines = 40;
		let count = 0;
		// Simple line-by-line: show removed then added
		for (const line of oldLines) {
			if (!newLines.includes(line)) {
				out.push(`- ${line}`);
				if (++count >= maxLines) { out.push("..."); return out.join("\n"); }
			}
		}
		for (const line of newLines) {
			if (!oldLines.includes(line)) {
				out.push(`+ ${line}`);
				if (++count >= maxLines) { out.push("..."); return out.join("\n"); }
			}
		}
		return out.join("\n") || "(no changes)";
	}

	/** Emit final persistent messages for all tool calls accumulated during this turn. */
	function emitFinalToolMessages() {
		for (const [toolCallId, tc] of toolCalls) {
			pi.sendMessage(
				{
					customType: MSG_TOOL,
					content: formatToolContent(tc),
					display: true,
					details: { toolCallId, name: tc.name, status: tc.status },
				},
				{ triggerTurn: false },
			);
		}
	}

	function handleRequestPermission(params: RequestPermissionRequest): RequestPermissionResponse {
		// Auto-approve everything for now
		const allowOption = params.options.find(
			(o) => o.kind === "allow_once" || o.kind === "allow_always",
		);
		if (allowOption) {
			return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
		}
		return { outcome: { outcome: "cancelled" } };
	}

	// --- Filesystem callbacks ---

	async function handleReadTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
		const content = await readFile(params.path, "utf-8");
		if (params.line != null || params.limit != null) {
			const lines = content.split("\n");
			const start = Math.max(0, (params.line ?? 1) - 1);
			const end = params.limit != null ? start + params.limit : lines.length;
			return { content: lines.slice(start, end).join("\n") };
		}
		return { content };
	}

	async function handleWriteTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
		await mkdir(dirname(params.path), { recursive: true });
		await writeFile(params.path, params.content, "utf-8");
		return {};
	}

	// --- Terminal callbacks ---

	function handleCreateTerminal(params: CreateTerminalRequest): CreateTerminalResponse {
		const id = `term-${nextTerminalId++}`;
		const args = params.args ?? [];
		const proc = spawn(params.command, args, {
			cwd: params.cwd ?? process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				...(params.env
					? Object.fromEntries(params.env.map((e) => [e.name, e.value]))
					: {}),
			},
		});

		const state: TerminalState = { proc, output: "" };
		terminals.set(id, state);

		proc.stdout?.on("data", (chunk: Buffer) => {
			state.output += chunk.toString();
			if (params.outputByteLimit && state.output.length > params.outputByteLimit) {
				state.output = state.output.slice(-params.outputByteLimit);
			}
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			state.output += chunk.toString();
			if (params.outputByteLimit && state.output.length > params.outputByteLimit) {
				state.output = state.output.slice(-params.outputByteLimit);
			}
		});
		proc.on("close", (code, signal) => {
			state.exitCode = code;
			state.signal = signal;
		});

		return { terminalId: id };
	}

	function handleTerminalOutput(params: TerminalOutputRequest): TerminalOutputResponse {
		const state = terminals.get(params.terminalId);
		if (!state) return { output: "", truncated: false };
		return {
			output: state.output,
			truncated: false,
			...(state.exitCode !== undefined || state.signal !== undefined
				? { exitStatus: { exitCode: state.exitCode, signal: state.signal } }
				: {}),
		};
	}

	async function handleWaitForTerminalExit(
		params: WaitForTerminalExitRequest,
	): Promise<WaitForTerminalExitResponse> {
		const state = terminals.get(params.terminalId);
		if (!state) return { exitCode: 1 };
		if (state.exitCode !== undefined || state.signal !== undefined) {
			return { exitCode: state.exitCode, signal: state.signal };
		}
		return new Promise((resolve) => {
			state.proc.on("close", (code, signal) => {
				resolve({ exitCode: code, signal });
			});
		});
	}

	function handleKillTerminal(
		params: KillTerminalRequest,
	): KillTerminalResponse | void {
		const state = terminals.get(params.terminalId);
		if (state) state.proc.kill();
	}

	function handleReleaseTerminal(
		params: ReleaseTerminalRequest,
	): ReleaseTerminalResponse | void {
		const state = terminals.get(params.terminalId);
		if (state) {
			state.proc.kill();
			terminals.delete(params.terminalId);
		}
	}

	// --- Connection lifecycle ---

	async function connect(ctx: ExtensionContext): Promise<void> {
		uiCtx = ctx;

		const child = spawn("npx", ["-y", "@zed-industries/claude-agent-acp"], {
			cwd: process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
		});
		agentProcess = child;

		child.stderr?.on("data", () => {
			// Suppress stderr noise from npx/agent startup
		});

		child.on("close", () => {
			if (active) {
				active = false;
				connection = null;
				sessionId = null;
				agentProcess = null;
				updateFooter();
				pi.sendMessage(
					{
						customType: MSG_STATUS,
						content: "Claude Code disconnected",
						display: true,
						details: {},
					},
					{ triggerTurn: false },
				);
			}
		});

		const input = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
		const output = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
		const stream = ndJsonStream(input, output);

		connection = new ClientSideConnection(
			() => ({
				sessionUpdate: async (params) => handleSessionUpdate(params),
				requestPermission: async (params) => handleRequestPermission(params),
				readTextFile: async (params) => handleReadTextFile(params),
				writeTextFile: async (params) => handleWriteTextFile(params),
				createTerminal: async (params) => handleCreateTerminal(params),
				terminalOutput: async (params) => handleTerminalOutput(params),
				waitForTerminalExit: async (params) => handleWaitForTerminalExit(params),
				killTerminal: async (params) => handleKillTerminal(params),
				releaseTerminal: async (params) => handleReleaseTerminal(params),
			}),
			stream,
		);

		const initResult = await connection.initialize({
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {
				fs: { readTextFile: true, writeTextFile: true },
				terminal: true,
			},
			clientInfo: { name: "pi-claudemode", version: "0.1.0" },
		});

		const session = await connection.newSession({
			cwd: process.cwd(),
			mcpServers: [],
		});
		sessionId = session.sessionId;

		active = true;
		updateFooter();

		pi.sendMessage(
			{
				customType: MSG_STATUS,
				content: `Connected to Claude Code (${initResult.agentInfo?.name ?? "agent"})`,
				display: true,
				details: {},
			},
			{ triggerTurn: false },
		);
	}

	function disconnect() {
		active = false;
		if (agentProcess) {
			agentProcess.kill();
			agentProcess = null;
		}
		// Kill any lingering terminals
		for (const [, state] of terminals) {
			state.proc.kill();
		}
		terminals.clear();
		connection = null;
		sessionId = null;
		currentMode = null;
		resetStreamState();
		updateFooter();
	}

	async function handlePrompt(text: string): Promise<void> {
		if (!connection || !sessionId) return;

		// Echo the user's message so it's visible in history
		pi.sendMessage(
			{
				customType: MSG_USER,
				content: `[You → Claude Code] ${text}`,
				display: true,
				details: {},
			},
			{ triggerTurn: false },
		);

		resetStreamState();
		prompting = true;
		updateFooter();
		uiCtx?.ui.setWidget(WIDGET_KEY, ["◉ Waiting for Claude Code..."]);

		try {
			const result = await connection.prompt({
				sessionId,
				prompt: [{ type: "text", text }],
			});

			// Clear streaming widget and emit final persistent messages
			clearStreamWidget();
			emitFinalToolMessages();
			if (planTasks) {
				const planText = planTasks
					.map((t) => {
						const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "◉" : "○";
						return `${icon} ${t.title}`;
					})
					.join("\n");
				pi.sendMessage(
					{ customType: MSG_RESPONSE, content: `Plan:\n${planText}`, display: true, details: { isPlan: true } },
					{ triggerTurn: false },
				);
			}
			if (responseText) {
				pi.sendMessage(
					{
						customType: MSG_RESPONSE,
						content: `[Claude Code] ${responseText}`,
						display: true,
						details: {
							thinking: thinkingText,
							stopReason: result.stopReason,
						},
					},
					{ triggerTurn: false },
				);
			}
		} catch (err) {
			clearStreamWidget();
			const msg = err instanceof Error ? err.message : String(err);
			pi.sendMessage(
				{
					customType: MSG_STATUS,
					content: `Error: ${msg}`,
					display: true,
					details: { error: true },
				},
				{ triggerTurn: false },
			);
		} finally {
			prompting = false;
			updateFooter();
		}
	}

	// --- Message Renderers ---

	pi.registerMessageRenderer(MSG_USER, (message, _opts, theme) => {
		const raw = typeof message.content === "string" ? message.content : "";
		const content = raw.replace(/^\[You → Claude Code] /, "");
		return new Text(theme.fg("userMessageText", `▶ ${content}`), 0, 0);
	});

	pi.registerMessageRenderer(MSG_RESPONSE, (message, { expanded }, theme) => {
		// Build markdown theme from pi's active theme so Claude Code responses render
		// with proper markdown formatting (headings, code blocks, lists, etc.)
		const mdTheme: MarkdownTheme = {
			heading: (t) => theme.bold(theme.fg("mdHeading", t)),
			link: (t) => theme.fg("mdLink", t),
			linkUrl: (t) => theme.fg("mdLinkUrl", t),
			code: (t) => theme.fg("mdCode", t),
			codeBlock: (t) => theme.fg("mdCodeBlock", t),
			codeBlockBorder: (t) => theme.fg("mdCodeBlockBorder", t),
			quote: (t) => theme.fg("mdQuote", t),
			quoteBorder: (t) => theme.fg("mdQuoteBorder", t),
			hr: (t) => theme.fg("mdHr", t),
			listBullet: (t) => theme.fg("mdListBullet", t),
			bold: (t) => theme.bold(t),
			italic: (t) => theme.italic(t),
			underline: (t) => theme.underline(t),
			strikethrough: (t) => theme.strikethrough(t),
		};
		const details = message.details as {
			thinking?: string;
			isPlan?: boolean;
			stopReason?: string;
		} | undefined;
		const raw = typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content.map((b: any) => b.text ?? "").join("")
				: "";
		const content = raw.replace(/^\[Claude Code] /, "");

		if (details?.isPlan) {
			const planBox = new Box(0, 0);
			planBox.addChild(new Text(theme.fg("accent", "◇ Plan"), 0, 0));
			planBox.addChild(new Markdown(content, 0, 0, mdTheme, {
				color: (t) => theme.fg("mdLink", t),
			}));
			return planBox;
		}

		const box = new Box(0, 0);
		box.addChild(new Text(theme.fg("success", "● Claude"), 0, 0));
		box.addChild(new Markdown(content, 0, 0, mdTheme, {
			color: (t) => theme.fg("mdLink", t),
		}));

		if (expanded && details?.thinking) {
			box.addChild(new Text(
				theme.fg("dim", "─ Thinking " + "─".repeat(29)) + "\n" + theme.fg("dim", details.thinking),
				0, 0,
			));
		}

		return box;
	});

	pi.registerMessageRenderer(MSG_TOOL, (message, { expanded }, theme) => {
		const details = message.details as {
			name?: string;
			status?: string;
			toolCallId?: string;
		} | undefined;
		const content = typeof message.content === "string" ? message.content : "";

		const statusIcon =
			details?.status === "completed" ? theme.fg("success", "✓")
			: details?.status === "failed" ? theme.fg("error", "✗")
			: theme.fg("warning", "◉");

		let text = `${statusIcon} ${theme.fg("toolTitle", details?.name ?? "tool")}`;

		// Show first line preview when collapsed
		const firstLine = content.split("\n")[0] || "";
		if (firstLine) text += ` ${theme.fg("muted", firstLine.substring(0, 120))}`;

		if (expanded && content.includes("\n")) {
			// Color diff lines
			const body = content
				.split("\n")
				.slice(1)
				.map((line) => {
					if (line.startsWith("+ ")) return theme.fg("toolDiffAdded", line);
					if (line.startsWith("- ")) return theme.fg("toolDiffRemoved", line);
					if (line.startsWith("--- ")) return theme.fg("dim", line);
					return theme.fg("muted", line);
				})
				.join("\n");
			text += "\n" + body;
		}

		return new Text(text, 0, 0);
	});

	pi.registerMessageRenderer(MSG_STATUS, (message, _opts, theme) => {
		const details = message.details as { error?: boolean } | undefined;
		const content = typeof message.content === "string" ? message.content : "";
		const color = details?.error ? "error" : "accent";
		return new Text(theme.fg(color, `◆ ${content}`), 0, 0);
	});

	// --- Input Interception ---

	pi.on("input", async (event, ctx) => {
		if (!active) return { action: "continue" as const };

		uiCtx = ctx;
		const text = event.text.trim();
		if (!text) return { action: "continue" as const };

		// Allow /commands to pass through to pi
		if (text.startsWith("/")) return { action: "continue" as const };

		// Let messages from sendUserMessage (e.g. /pi command) go to pi's LLM
		if (event.source === "extension") return { action: "continue" as const };

		// Forward to Claude Code
		handlePrompt(text);
		return { action: "handled" as const };
	});

	// --- /pi Command (talk to Pi while in claudemode) ---

	pi.registerCommand("pi", {
		description: "Send a message to Pi's LLM instead of Claude Code (only useful in Claude Mode)",
		async handler(args) {
			const text = args?.trim();
			if (!text) return;
			pi.sendUserMessage(text);
		},
	});

	// --- /claudemode Command ---

	pi.registerCommand("claudemode", {
		description: "Toggle Claude Mode — forward messages to Claude Code via ACP",
		async handler(args, ctx) {
			uiCtx = ctx;
			const arg = args?.trim().toLowerCase();

			if (arg === "disconnect" || (active && !arg)) {
				disconnect();
				ctx.ui.notify("Claude Mode off", "info");
				pi.appendEntry(ENTRY_TYPE, { active: false });
				return;
			}

			if (active) {
				ctx.ui.notify("Claude Mode already active", "info");
				return;
			}

			ctx.ui.notify("Connecting to Claude Code...", "info");
			try {
				await connect(ctx);
				ctx.ui.notify("Claude Mode on", "info");
				pi.appendEntry(ENTRY_TYPE, { active: true });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to connect: ${msg}`, "error");
			}
		},
	});

	// --- Session events ---

	function restoreState(ctx: ExtensionContext) {
		uiCtx = ctx;
		// Don't auto-reconnect, just restore footer state
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
				const data = entry.data as { active?: boolean } | undefined;
				if (data?.active && !active) {
					// Was active before fork/resume — show hint
					ctx.ui.setStatus(
						"claudemode",
						ctx.ui.theme.fg("dim", "Claude Code ○ (run /claudemode to reconnect)"),
					);
				}
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => restoreState(ctx));
	pi.on("session_fork", async (_event, ctx) => restoreState(ctx));
	pi.on("session_switch", async (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreState(ctx));

	pi.on("session_shutdown", async () => {
		if (active) disconnect();
	});
}
