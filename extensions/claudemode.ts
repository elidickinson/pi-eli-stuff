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
import { Text } from "@mariozechner/pi-tui";

// --- Types ---

interface ToolCallState {
	name: string;
	status: string;
	rawInput?: unknown;
	rawOutput?: unknown;
	content?: Array<{ type: string; text?: string }>;
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

	// Terminal management
	let nextTerminalId = 1;
	const terminals = new Map<string, TerminalState>();

	// UI context ref (set during command handler, used in callbacks)
	let uiCtx: ExtensionContext | null = null;

	function resetStreamState() {
		responseText = "";
		thinkingText = "";
		toolCalls.clear();
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
		const lines = responseText.split("\n");
		// Show last ~20 lines to keep widget manageable
		const visible = lines.length > 20 ? lines.slice(-20) : lines;
		uiCtx.ui.setWidget(WIDGET_KEY, ["◉ Claude responding...", "", ...visible]);
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
					content: tc.content as Array<{ type: string; text?: string }>,
				});
				emitToolMessage(tc.toolCallId);
				break;
			}

			case "tool_call_update": {
				const tc = update as ToolCallUpdate & { sessionUpdate: string };
				const id = tc.toolCallId;
				const existing = toolCalls.get(id);
				if (existing) {
					if (tc.title) existing.name = tc.title;
					if (tc.status) existing.status = tc.status;
					if (tc.rawInput !== undefined) existing.rawInput = tc.rawInput;
					if (tc.rawOutput !== undefined) existing.rawOutput = tc.rawOutput;
					if (tc.content) existing.content = tc.content as Array<{ type: string; text?: string }>;
					emitToolMessage(id);
				}
				break;
			}

			case "current_mode_update": {
				const modeUpdate = update as { currentModeId?: string };
				currentMode = modeUpdate.currentModeId ?? null;
				updateFooter();
				break;
			}

			case "plan": {
				// Plans come as session updates — render as a response message
				const plan = update as { tasks?: Array<{ title: string; status: string }> };
				if (plan.tasks) {
					const planText = plan.tasks
						.map((t) => {
							const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "◉" : "○";
							return `${icon} ${t.title}`;
						})
						.join("\n");
					pi.sendMessage(
						{
							customType: MSG_RESPONSE,
							content: `Plan:\n${planText}`,
							display: true,
							details: { isPlan: true },
						},
						{ triggerTurn: false },
					);
				}
				break;
			}

			default:
				break;
		}
	}

	function emitToolMessage(toolCallId: string) {
		const tc = toolCalls.get(toolCallId);
		if (!tc) return;

		let content = `${tc.name} [${tc.status}]`;
		if (tc.rawInput) {
			const inputStr = typeof tc.rawInput === "string" ? tc.rawInput : JSON.stringify(tc.rawInput);
			content += `\n  Input: ${inputStr.substring(0, 300)}`;
		}
		if (tc.rawOutput) {
			const outputStr = typeof tc.rawOutput === "string" ? tc.rawOutput : JSON.stringify(tc.rawOutput);
			content += `\n  Output: ${outputStr.substring(0, 500)}`;
		}
		if (tc.content) {
			for (const block of tc.content) {
				if (block.type === "text" && block.text) {
					content += `\n  ${block.text.substring(0, 500)}`;
				}
			}
		}

		pi.sendMessage(
			{
				customType: MSG_TOOL,
				content,
				display: true,
				details: { toolCallId, name: tc.name, status: tc.status },
			},
			{ triggerTurn: false },
		);
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

		try {
			const result = await connection.prompt({
				sessionId,
				prompt: [{ type: "text", text }],
			});

			// Clear streaming widget and send final persistent response
			clearStreamWidget();
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

		let text = "";

		if (details?.isPlan) {
			text += theme.fg("accent", "◇ Plan") + "\n";
			text += content;
			return new Text(text, 0, 0);
		}

		text += theme.fg("success", "● Claude") + "\n\n";
		text += content;

		if (expanded && details?.thinking) {
			text += "\n\n" + theme.fg("dim", "─ Thinking " + "─".repeat(29));
			text += "\n" + theme.fg("dim", details.thinking);
		}

		return new Text(text, 0, 0);
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

		let text = `${statusIcon} ${theme.fg("toolTitle", details?.name ?? "tool")} ${theme.fg("dim", `[${details?.status ?? "unknown"}]`)}`;

		if (expanded) {
			text += "\n" + theme.fg("muted", content);
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

		// Forward to Claude Code
		handlePrompt(text);
		return { action: "handled" as const };
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
