/**
 * Claude ACP Extension
 *
 * Connects pi to Claude Code via ACP. User messages are forwarded to Claude Code
 * and responses stream back into pi's TUI.
 *
 * Commands:
 *   /claude:on    - Connect (resumes previous session)
 *   /claude:off   - Disconnect (preserves session)
 *   /claude:clear - Disconnect and forget session
 *   /claude:whisper - Quick one-shot question (display only, no context)
 *   /claude:ask     - One-shot question (added to context)
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
import { Type } from "@sinclair/typebox";
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

const MSG_USER = "claude-acp-user";
const MSG_RESPONSE = "claude-acp-response";
const MSG_TOOL = "claude-acp-tool";
const MSG_STATUS = "claude-acp-status";
const ENTRY_TYPE = "claude-acp-state";
const WIDGET_KEY = "claude-acp-stream";
const WHISPER_WIDGET = "claude-whisper";

// --- Extension ---

export default function (pi: ExtensionAPI) {
	let active = false; // Interactive mode: intercept user messages
	let connected = false; // Connection state: connected to Claude Code
	let connection: ClientSideConnection | null = null;
	let sessionId: string | null = null;
	let lastSessionId: string | null = null; // for resume after disconnect
	let agentProcess: ChildProcess | null = null;
	let prompting = false;
	let currentMode: string | null = null;
	let contextPct: number | null = null; // context window usage %
	let streamWidgetKey = WIDGET_KEY; // which widget streams render into

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
			uiCtx.ui.setStatus("claude-acp", undefined);
			return;
		}
		let label = "Claude Code";
		if (currentMode && currentMode !== "code") label += ` [${currentMode}]`;
		const dot = prompting ? " ◉" : " ●";
		const color = prompting ? "warning" : "success";
		let status = uiCtx.ui.theme.fg(color, label + dot);
		if (contextPct != null) {
			const pctColor = contextPct >= 80 ? "error" : "dim";
			status += " " + uiCtx.ui.theme.fg(pctColor, `${contextPct}%`);
		}
		uiCtx.ui.setStatus("claude-acp", status);
	}

	function updateStreamWidget() {
		if (!uiCtx) return;
		const box = new Box(0, 0);

		const mdTheme: MarkdownTheme = {
			heading: (t) => uiCtx!.ui.theme.bold(uiCtx!.ui.theme.fg("mdHeading", t)),
			link: (t) => uiCtx!.ui.theme.fg("mdLink", t),
			linkUrl: (t) => uiCtx!.ui.theme.fg("mdLinkUrl", t),
			code: (t) => uiCtx!.ui.theme.fg("mdCode", t),
			codeBlock: (t) => uiCtx!.ui.theme.fg("mdCodeBlock", t),
			codeBlockBorder: (t) => uiCtx!.ui.theme.fg("mdCodeBlockBorder", t),
			quote: (t) => uiCtx!.ui.theme.fg("mdQuote", t),
			quoteBorder: (t) => uiCtx!.ui.theme.fg("mdQuoteBorder", t),
			hr: (t) => uiCtx!.ui.theme.fg("mdHr", t),
			listBullet: (t) => uiCtx!.ui.theme.fg("mdListBullet", t),
			bold: (t) => uiCtx!.ui.theme.bold(t),
			italic: (t) => uiCtx!.ui.theme.italic(t),
			underline: (t) => uiCtx!.ui.theme.underline(t),
			strikethrough: (t) => uiCtx!.ui.theme.strikethrough(t),
		};

		// Status header
		box.addChild(new Text(uiCtx.ui.theme.fg("mdLink", "[claude]") + " " + uiCtx.ui.theme.fg("muted", "responding..."), 0, 0));

		// Show tool call activity
		for (const [, tc] of toolCalls) {
			const icon = tc.status === "completed" ? "✓" : tc.status === "failed" ? "✗" : "◉";
			let line = `  ${icon} ${tc.name}`;
			const path = tc.locations?.[0]?.path ?? extractPath(tc.rawInput);
			if (path) line += ` ${path}`;
			if (tc.status !== "completed" && tc.status !== "failed") line += ` [${tc.status}]`;
			box.addChild(new Text(line, 0, 0));
		}

		// Show plan tasks
		if (planTasks) {
			box.addChild(new Text("", 0, 0));
			for (const t of planTasks) {
				const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "◉" : "○";
				box.addChild(new Text(`  ${icon} ${t.title}`, 0, 0));
			}
		}

		// Show tail of response text with markdown rendering
		if (responseText) {
			box.addChild(new Text("", 0, 0));
			const respLines = responseText.split("\n");
			const visible = respLines.length > 15 ? respLines.slice(-15) : respLines;
			const visibleText = visible.join("\n");
			box.addChild(new Markdown(visibleText, 0, 0, mdTheme, {
				color: (t) => uiCtx!.ui.theme.fg("mdLink", t),
			}));
		}

		uiCtx.ui.setWidget(streamWidgetKey, () => box);
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
		uiCtx?.ui.setWidget(streamWidgetKey, undefined);
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

			case "usage_update": {
				const usage = update as { used?: number; size?: number };
				if (usage.used != null && usage.size != null && usage.size > 0) {
					contextPct = Math.round((usage.used / usage.size) * 100);
					updateFooter();
				}
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

	async function connect(ctx: ExtensionContext, resumeId?: string | null, interactive: boolean = true): Promise<void> {
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
			if (active || connected) {
				active = false;
				connected = false;
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
		const rawStream = ndJsonStream(input, output);

		// Workaround: intercept session/update notifications before the SDK's Zod
		// validation. The SDK parses SessionUpdate with z.union() over 11 .and()
		// intersection variants (zod.gen.js zSessionUpdate). When a tool_call_update
		// with content:[] arrives, Zod v4 (4.x) throws "TypeError: content is not
		// a function" instead of a ZodError while trying earlier union branches
		// (agent_message_chunk etc.) whose zContentChunk schema expects content to
		// be a single ContentBlock object. Because it's not a ZodError the SDK's
		// catch chain wraps it as -32603 Internal Error and logs to stderr.
		//
		// Safe to remove once either:
		//  - @agentclientprotocol/sdk switches zSessionUpdate to
		//    z.discriminatedUnion("sessionUpdate", ...) (avoids trying wrong branches)
		//  - The underlying Zod/SDK issue is identified and fixed
		// Reproduced on Zod 4.3.6, @agentclientprotocol/sdk 0.16.1.
		const filter = new TransformStream({
			transform(msg: any, controller) {
				if ("method" in msg && msg.method === "session/update" && !("id" in msg) && msg.params) {
					try { handleSessionUpdate(msg.params); } catch (e) { console.error("[claude-acp] session/update handler error:", e); }
					return;
				}
				controller.enqueue(msg);
			},
		});
		rawStream.readable.pipeTo(filter.writable).catch(() => {});
		const stream = { readable: filter.readable, writable: rawStream.writable };

		connection = new ClientSideConnection(
			() => ({
				sessionUpdate: async () => {}, // handled by stream filter above
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
			clientInfo: { name: "pi-claude-acp-mode", version: "0.1.0" },
		});

		let resumed = false;
		if (resumeId) {
			try {
				await connection.loadSession({ sessionId: resumeId, cwd: process.cwd() });
				sessionId = resumeId;
				resumed = true;
			} catch {
				// Session no longer exists — fall through to new session
			}
		}
		if (!resumed) {
			const session = await connection.newSession({
				cwd: process.cwd(),
				mcpServers: [],
			});
			sessionId = session.sessionId;
		}

		// Set bypassPermissions so Claude Code's built-in tools (Bash, WebSearch, etc.) work
		await connection.setSessionMode({ sessionId, modeId: "bypassPermissions" });

		active = interactive; // Only activate input interception for interactive mode
		connected = true; // Always mark as connected
		lastSessionId = sessionId;
		if (interactive) {
			updateFooter();
			const label = resumed ? "Resumed" : "Connected to";
			pi.sendMessage(
				{
					customType: MSG_STATUS,
					content: `${label} Claude Code (${initResult.agentInfo?.name ?? "agent"})`,
					display: true,
					details: {},
				},
				{ triggerTurn: false },
			);
		}
	}

	function disconnect() {
		active = false;
		connected = false;
		lastSessionId = sessionId;
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

	async function ensureConnection(ctx: ExtensionContext, interactive: boolean = false): Promise<void> {
		uiCtx = ctx;
		if (connected) {
			// Already connected. Upgrade to interactive if needed.
			if (interactive && !active) {
				active = true;
				updateFooter();
				pi.appendEntry(ENTRY_TYPE, { active: true, connected: true, sessionId: lastSessionId });
			}
			return;
		}
		// Not connected. Establish connection.
		await connect(ctx, lastSessionId, interactive);
		pi.appendEntry(ENTRY_TYPE, { active: interactive, connected: true, sessionId: lastSessionId });
	}

	interface PromptResult {
		responseText: string;
		thinkingText: string;
		toolCalls: Map<string, ToolCallState>;
		planTasks: Array<{ title: string; status: string }> | null;
		stopReason?: string;
	}

	async function promptClaude(text: string, widgetKey: string): Promise<PromptResult> {
		if (!connection || !sessionId) throw new Error("Not connected");

		streamWidgetKey = widgetKey;
		resetStreamState();
		prompting = true;
		updateFooter();
		uiCtx?.ui.setWidget(widgetKey, ["◉ Asking Claude..."]);

		try {
			const result = await connection.prompt({
				sessionId,
				prompt: [{ type: "text", text }],
			});

			clearStreamWidget();
			return {
				responseText,
				thinkingText,
				toolCalls: new Map(toolCalls),
				planTasks: planTasks ? [...planTasks] : null,
				stopReason: result.stopReason,
			};
		} catch (err) {
			clearStreamWidget();
			throw err;
		} finally {
			streamWidgetKey = WIDGET_KEY;
			prompting = false;
			updateFooter();
		}
	}

	async function handlePrompt(text: string): Promise<void> {
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

		try {
			const result = await promptClaude(text, WIDGET_KEY);

			// Emit final persistent messages
			for (const [toolCallId, tc] of result.toolCalls) {
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
			if (result.planTasks) {
				const planText = result.planTasks
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
			if (result.responseText) {
				pi.sendMessage(
					{
						customType: MSG_RESPONSE,
						content: `[Claude Code] ${result.responseText}`,
						display: true,
						details: {
							thinking: result.thinkingText,
							stopReason: result.stopReason,
						},
					},
					{ triggerTurn: false },
				);
			}
		} catch (err) {
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
		box.addChild(new Text(theme.fg("mdLink", "[claude]"), 0, 0));
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
		// Clear any whisper/ask widget on new input
		ctx.ui.setWidget(WHISPER_WIDGET, undefined);

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

	// --- Tool ---

	pi.registerTool({
		name: "AskClaude",
		label: "Ask Claude Code",
		description: "Delegate a question or task to Claude Code (Anthropic's coding agent). Share persistent context with Claude Code but do NOT switch to Claude mode (user input continues to go to pi's LLM). Use when: the user asks you to ask Claude, you need a second opinion on a complex problem, or a task would benefit from Claude's tools (codebase search, web search, browser). Prefer to solve straightforward tasks yourself.",
		parameters: Type.Object({
			prompt: Type.String({ description: "The question or task for Claude Code" }),
		}),
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("AskClaude "));
			const preview = args.prompt.length > 200 ? args.prompt.substring(0, 200) + "..." : args.prompt;
			text += theme.fg("muted", `"${preview}"`);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as { prompt?: string; executionTime?: number } | undefined;
			const responseText = result.content[0];
			const firstLine = responseText?.type === "text" && responseText.text
				? responseText.text.split("\n")[0]
				: null;

			let text = result.details && (result.details as any).error
				? theme.fg("error", "✗ Claude Code error")
				: theme.fg("success", "✓ Claude Code");

			if (!expanded) {
				if (firstLine) {
					text += ` ${theme.fg("muted", firstLine.substring(0, 120))}${firstLine.length > 120 ? "..." : ""}`;
				}
				return new Text(text, 0, 0);
			}

			if (details?.prompt) text += `\n${theme.fg("dim", `Prompt: ${details.prompt}`)}`;
			if (details?.executionTime) text += `\n${theme.fg("dim", `Time: ${(details.executionTime / 1000).toFixed(1)}s`)}`;
			if (responseText?.type === "text" && responseText.text) {
				text += `\n\n${theme.fg("muted", "─".repeat(40))}\n${responseText.text}`;
			}
			return new Text(text, 0, 0);
		},
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const start = Date.now();
			try {
				await ensureConnection(ctx, false); // Non-interactive: don't activate input interception
				const result = await promptClaude(params.prompt, WHISPER_WIDGET);
				const executionTime = Date.now() - start;
				// Show response as a visible message (no prompt echo — that caused LLM retry loops)
				pi.sendMessage(
					{ customType: MSG_RESPONSE, content: `[Claude Code] ${result.responseText}`, display: true, details: {} },
					{ triggerTurn: false },
				);
				return {
					content: [{ type: "text" as const, text: result.responseText }],
					details: { prompt: params.prompt, executionTime },
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Error: ${msg}` }],
					details: { prompt: params.prompt, executionTime: Date.now() - start, error: true },
				};
			}
		},
	});

	// --- Commands (registration order = display order) ---

	pi.registerCommand("claude:on", {
		description: "Connect to Claude Code — resumes previous session if available",
		async handler(_args, ctx) {
			uiCtx = ctx;
			if (active) {
				ctx.ui.notify("Claude Code already connected", "info");
				return;
			}
			ctx.ui.notify("Connecting to Claude Code...", "info");
			try {
				await ensureConnection(ctx, true); // Interactive mode: activate input interception
				ctx.ui.notify("Claude Code connected", "info");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to connect: ${msg}`, "error");
			}
		},
	});

	pi.registerCommand("claude:off", {
		description: "Disconnect from Claude Code (session is preserved for resume)",
		async handler(_args, ctx) {
			uiCtx = ctx;
			if (!active && !connected) {
				ctx.ui.notify("Claude Code not connected", "info");
				return;
			}
			disconnect();
			ctx.ui.notify("Claude Code disconnected", "info");
			pi.appendEntry(ENTRY_TYPE, { active: false, connected: false, sessionId: lastSessionId });
		},
	});

	pi.registerCommand("claude:clear", {
		description: "Disconnect and start a fresh Claude Code session next time",
		async handler(_args, ctx) {
			uiCtx = ctx;
			if (active) disconnect();
			lastSessionId = null;
			ctx.ui.notify("Claude Code session cleared", "info");
			pi.appendEntry(ENTRY_TYPE, { active: false, connected: false, sessionId: null });
		},
	});

	pi.registerCommand("claude:whisper", {
		description: "Ask Claude a quick question (display only, not added to context)",
		async handler(args, ctx) {
			const prompt = args?.trim();
			if (!prompt) {
				ctx.ui.notify("Usage: /claude:whisper <question>", "warning");
				return;
			}
			try {
				await ensureConnection(ctx, false); // Non-interactive: don't activate input interception
				const result = await promptClaude(prompt, WHISPER_WIDGET);
				const lines = result.responseText.split("\n");
				ctx.ui.setWidget(WHISPER_WIDGET, [
					ctx.ui.theme.fg("dim", "[whisper]") + " " + ctx.ui.theme.fg("dim", prompt),
					"",
					...lines,
				]);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.setWidget(WHISPER_WIDGET, [ctx.ui.theme.fg("error", `whisper failed: ${msg}`)]);
			}
		},
	});

	pi.registerCommand("claude:ask", {
		description: "Ask Claude a question (added to context)",
		async handler(args, ctx) {
			const prompt = args?.trim();
			if (!prompt) {
				ctx.ui.notify("Usage: /claude:ask <question>", "warning");
				return;
			}
			try {
				await ensureConnection(ctx, false); // Non-interactive: don't activate input interception
				const result = await promptClaude(prompt, WHISPER_WIDGET);
				pi.sendMessage(
					{
						customType: MSG_USER,
						content: `[You → Claude Code] ${prompt}`,
						display: true,
						details: {},
					},
					{ triggerTurn: false },
				);
				pi.sendMessage(
					{
						customType: MSG_RESPONSE,
						content: `[Claude Code] ${result.responseText}`,
						display: true,
						details: {},
					},
					{ triggerTurn: false },
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`claude:ask failed: ${msg}`, "error");
			}
		},
	});

	pi.registerCommand("pi", {
		description: "Send a message to Pi's LLM instead of Claude Code (only useful in Claude Mode)",
		async handler(args) {
			const text = args?.trim();
			if (!text) return;
			pi.sendUserMessage(text);
		},
	});

	// --- Session events ---

	function restoreState(ctx: ExtensionContext) {
		uiCtx = ctx;
		// Don't auto-reconnect, just restore footer and session state
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
				const data = entry.data as {
					active?: boolean;
					connected?: boolean;
					sessionId?: string | null
				} | undefined;
				if (data?.sessionId !== undefined) lastSessionId = data.sessionId;
				if (data?.connected && !connected && !active) {
					// Was connected passively (via tool or /claude:ask), show prompt to reconnect
					ctx.ui.setStatus(
						"claude-acp",
						ctx.ui.theme.fg("dim", "Claude Code ○ (session available)"),
					);
				} else if (data?.active && !active) {
					// Was in interactive mode, show prompt to reconnect
					ctx.ui.setStatus(
						"claude-acp",
						ctx.ui.theme.fg("dim", "Claude Code ○ (run /claude:on to reconnect)"),
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
