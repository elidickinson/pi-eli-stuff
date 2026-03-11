import { describe, it, expect } from "vitest";
import {
	handleTurnStart,
	handleMessageStart,
	handleMessageUpdate,
	handleMessageEnd,
	type PendingCall,
} from "./state-machine.js";

const SESSION_ID = "test-session-uuid";

function makePending(overrides: Partial<PendingCall> = {}): PendingCall {
	return {
		startTime: 1000,
		turnIndex: 0,
		firstTokenTime: null,
		provider: "anthropic",
		model: "claude-sonnet-4",
		api: "anthropic-messages",
		contextTokens: 5000,
		contextWindow: 200000,
		...overrides,
	};
}

function makeAssistantMsg(overrides: Record<string, unknown> = {}) {
	return {
		role: "assistant" as const,
		provider: "anthropic",
		model: "claude-sonnet-4",
		api: "anthropic-messages",
		timestamp: 1000,
		stopReason: "stop",
		usage: {
			input: 100,
			output: 200,
			cacheRead: 50,
			cacheWrite: 10,
			totalTokens: 360,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.0005, cacheWrite: 0.0001, total: 0.0036 },
		},
		...overrides,
	};
}

describe("handleTurnStart", () => {
	it("creates pending from turn_start event", () => {
		const result = handleTurnStart(null, 3, 1000, 5000, 200000);
		expect(result.turnIndex).toBe(3);
		expect(result.startTime).toBe(1000);
		expect(result.contextTokens).toBe(5000);
		expect(result.firstTokenTime).toBeNull();
	});

	it("overwrites existing pending (defensive)", () => {
		const old = makePending({ turnIndex: 1 });
		const result = handleTurnStart(old, 2, 2000, null, 200000);
		expect(result.turnIndex).toBe(2);
		expect(result.startTime).toBe(2000);
	});
});

describe("handleMessageStart", () => {
	it("updates pending with provider/model/api", () => {
		const pending = makePending({ provider: "", model: "", api: "" });
		const result = handleMessageStart(pending, {
			provider: "openrouter",
			model: "deepseek-v3",
			api: "openai-completions",
		});
		expect(result.provider).toBe("openrouter");
		expect(result.model).toBe("deepseek-v3");
		expect(result.api).toBe("openai-completions");
	});

	it("creates pending from message.timestamp when no turn_start", () => {
		const result = handleMessageStart(null, {
			provider: "anthropic",
			model: "claude-sonnet-4",
			api: "anthropic-messages",
			timestamp: 5000,
		});
		expect(result.startTime).toBe(5000);
		expect(result.turnIndex).toBe(-1);
	});
});

describe("handleMessageUpdate", () => {
	it("records TTFT on first text_delta", () => {
		const pending = makePending();
		const result = handleMessageUpdate(pending, "text_delta", 1823);
		expect(result!.firstTokenTime).toBe(1823);
	});

	it("records TTFT on first thinking_delta", () => {
		const pending = makePending();
		const result = handleMessageUpdate(pending, "thinking_delta", 1500);
		expect(result!.firstTokenTime).toBe(1500);
	});

	it("ignores subsequent text_delta events", () => {
		const pending = makePending({ firstTokenTime: 1500 });
		const result = handleMessageUpdate(pending, "text_delta", 2000);
		expect(result!.firstTokenTime).toBe(1500);
	});

	it("does NOT trigger TTFT on toolcall_delta", () => {
		const pending = makePending();
		const result = handleMessageUpdate(pending, "toolcall_delta", 1500);
		expect(result!.firstTokenTime).toBeNull();
	});

	it("returns null when no pending", () => {
		expect(handleMessageUpdate(null, "text_delta", 1000)).toBeNull();
	});
});

describe("handleMessageEnd", () => {
	it("happy path: produces complete row", () => {
		const pending = makePending({ startTime: 1000, firstTokenTime: 1823 });
		const msg = makeAssistantMsg();
		const { row } = handleMessageEnd(pending, msg, SESSION_ID, 5200);

		expect(row).not.toBeNull();
		expect(row!.provider).toBe("anthropic");
		expect(row!.model).toBe("claude-sonnet-4");
		expect(row!.ttft_ms).toBe(823); // 1823 - 1000
		expect(row!.duration_ms).toBe(4200); // 5200 - 1000
		expect(row!.input_tokens).toBe(100);
		expect(row!.output_tokens).toBe(200);
		expect(row!.cost_total).toBe(0.0036);
		expect(row!.session_id).toBe(SESSION_ID);
		expect(row!.stop_reason).toBe("stop");
	});

	it("error before tokens: null TTFT, duration recorded", () => {
		const pending = makePending({ startTime: 1000 });
		const msg = makeAssistantMsg({ stopReason: "error", errorMessage: "rate limited" });
		const { row } = handleMessageEnd(pending, msg, SESSION_ID, 1500);

		expect(row!.ttft_ms).toBeNull();
		expect(row!.duration_ms).toBe(500);
		expect(row!.stop_reason).toBe("error");
		expect(row!.error_message).toBe("rate limited");
	});

	it("aborted call recorded", () => {
		const pending = makePending({ startTime: 1000, firstTokenTime: 1200 });
		const msg = makeAssistantMsg({ stopReason: "aborted" });
		const { row } = handleMessageEnd(pending, msg, SESSION_ID, 3000);

		expect(row!.stop_reason).toBe("aborted");
		expect(row!.ttft_ms).toBe(200);
	});

	it("retry within turn: first message_end produces row, clears pending", () => {
		// First attempt: error
		const pending1 = makePending({ startTime: 1000 });
		const msg1 = makeAssistantMsg({ stopReason: "error", errorMessage: "500" });
		const result1 = handleMessageEnd(pending1, msg1, SESSION_ID, 1500);

		expect(result1.row).not.toBeNull();
		expect(result1.pending).toBeNull();

		// Second attempt: message_start creates new pending from message timestamp
		const pending2 = handleMessageStart(result1.pending, {
			provider: "anthropic",
			model: "claude-sonnet-4",
			timestamp: 1600,
		});
		const pending2b = handleMessageUpdate(pending2, "text_delta", 2000);
		const msg2 = makeAssistantMsg({ stopReason: "stop" });
		const result2 = handleMessageEnd(pending2b, msg2, SESSION_ID, 4000);

		expect(result2.row).not.toBeNull();
		expect(result2.row!.ttft_ms).toBe(400); // 2000 - 1600
		expect(result2.row!.duration_ms).toBe(2400); // 4000 - 1600
	});

	it("returns null row when no pending", () => {
		const msg = makeAssistantMsg();
		const { row } = handleMessageEnd(null, msg, SESSION_ID, 5000);
		expect(row).toBeNull();
	});

	it("ignores non-assistant messages", () => {
		const pending = makePending();
		const { row } = handleMessageEnd(pending, { role: "user" }, SESSION_ID, 5000);
		expect(row).toBeNull();
	});
});
