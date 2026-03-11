// Pure state machine for tracking pending LLM calls.
// No dependencies on Pi runtime or SQLite — fully testable in isolation.

export interface PendingCall {
	startTime: number;
	turnIndex: number;
	firstTokenTime: number | null;
	provider: string;
	model: string;
	api: string;
	contextTokens: number | null;
	contextWindow: number;
}

export interface LlmCallRow {
	timestamp_ms: number;
	session_id: string;
	turn_index: number;
	provider: string;
	model: string;
	api: string | null;
	ttft_ms: number | null;
	duration_ms: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read: number | null;
	cache_write: number | null;
	cost_input: number | null;
	cost_output: number | null;
	cost_cache_read: number | null;
	cost_cache_write: number | null;
	cost_total: number | null;
	context_tokens: number | null;
	context_window: number | null;
	stop_reason: string | null;
	error_message: string | null;
}

export interface MessageEndResult {
	row: LlmCallRow | null;
	pending: null;
}

export interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface MessageLike {
	role?: string;
	provider?: string;
	model?: string;
	api?: string;
	usage?: UsageLike;
	stopReason?: string;
	errorMessage?: string;
	timestamp?: number;
}

const DEBUG = process.env.LLM_PERF_DEBUG === "1";

function debug(...args: unknown[]) {
	if (DEBUG) console.warn("[llm-perf]", ...args);
}

export function handleTurnStart(
	_pending: PendingCall | null,
	turnIndex: number,
	timestamp: number,
	contextTokens: number | null,
	contextWindow: number,
): PendingCall {
	if (_pending) debug("WARN: overwriting pending (turn_start before message_end)");
	return {
		startTime: timestamp,
		turnIndex,
		firstTokenTime: null,
		provider: "",
		model: "",
		api: "",
		contextTokens,
		contextWindow,
	};
}

export function handleMessageStart(
	pending: PendingCall | null,
	message: { provider?: string; model?: string; api?: string; timestamp?: number },
): PendingCall {
	if (pending) {
		return {
			...pending,
			provider: message.provider || pending.provider,
			model: message.model || pending.model,
			api: message.api || pending.api,
		};
	}
	// No turn_start (mid-stream load or retry) — create from message timestamp
	debug("WARN: message_start without turn_start");
	return {
		startTime: message.timestamp || Date.now(),
		turnIndex: -1,
		firstTokenTime: null,
		provider: message.provider || "",
		model: message.model || "",
		api: message.api || "",
		contextTokens: null,
		contextWindow: 0,
	};
}

export function handleMessageUpdate(
	pending: PendingCall | null,
	eventType: string,
	now: number,
): PendingCall | null {
	if (!pending) return null;
	if (pending.firstTokenTime !== null) return pending;
	if (eventType === "text_delta" || eventType === "thinking_delta") {
		debug(`TTFT recorded ${now - pending.startTime}ms`);
		return { ...pending, firstTokenTime: now };
	}
	return pending;
}

export function handleMessageEnd(
	pending: PendingCall | null,
	message: MessageLike,
	sessionId: string,
	now: number,
): MessageEndResult {
	if (!pending) {
		debug("WARN: message_end without pending");
		return { row: null, pending: null };
	}

	if (message.role !== "assistant") {
		return { row: null, pending: null };
	}

	const provider = message.provider || pending.provider;
	const model = message.model || pending.model;
	const usage = message.usage;

	const row: LlmCallRow = {
		timestamp_ms: pending.startTime,
		session_id: sessionId,
		turn_index: pending.turnIndex,
		provider,
		model,
		api: message.api || pending.api || null,
		ttft_ms: pending.firstTokenTime !== null ? pending.firstTokenTime - pending.startTime : null,
		duration_ms: now - pending.startTime,
		input_tokens: usage?.input ?? null,
		output_tokens: usage?.output ?? null,
		cache_read: usage?.cacheRead ?? null,
		cache_write: usage?.cacheWrite ?? null,
		cost_input: usage?.cost.input ?? null,
		cost_output: usage?.cost.output ?? null,
		cost_cache_read: usage?.cost.cacheRead ?? null,
		cost_cache_write: usage?.cost.cacheWrite ?? null,
		cost_total: usage?.cost.total ?? null,
		context_tokens: pending.contextTokens,
		context_window: pending.contextWindow || null,
		stop_reason: message.stopReason || null,
		error_message: message.errorMessage || null,
	};

	return { row, pending: null };
}
